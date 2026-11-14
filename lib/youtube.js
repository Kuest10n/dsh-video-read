/**
 * Video acquisition through yt-dlp.
 *
 * Covers YouTube and, as a generic fallback, most other sites yt-dlp supports.
 * The executable is resolved from config.ytdlpPath, PATH, the standard
 * %LOCALAPPDATA% location, or the plugin cache; when none exists and
 * config.autoDownloadYtdlp is not false it is installed on first use from the
 * npm mirror package `yt-dlp-static`, because github.com release downloads time
 * out in this environment.
 *
 * Supply-chain note: the npm tarball is verified against the registry's sha512
 * integrity before extraction, only the single `package/bin/win/yt-dlp.exe`
 * member is extracted, and the binary must answer `--version` with a yt-dlp
 * version string or it is deleted again. PyInstaller needs a writable TEMP
 * directory, so every child process runs with TEMP/TMP/TMPDIR pointed at
 * <cache>/tmp.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { probeMedia } from './ffmpeg.js'
import { parseSrtOrVtt } from './frames.js'
import { downloadToFile, fetchWithDeadline, readTextCapped } from './net.js'

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 240_000
const NPM_REGISTRY = 'https://registry.npmmirror.com'
const YTDLP_NPM_PACKAGE = 'yt-dlp-static'
const YTDLP_TARBALL_MAX_BYTES = 300 * 1024 * 1024
const YTDLP_TARBALL_MEMBER = 'package/bin/win/yt-dlp.exe'
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}/
const INSTALL_HINT =
  'YouTube and generic web videos need yt-dlp. Set the plugin option ytdlpPath, install it once ' +
  '(`winget install yt-dlp`), or leave autoDownloadYtdlp enabled so the plugin installs the npm mirror ' +
  'build on first use. Bilibili and local files work without it.'

function cacheRoot(cfg = {}) {
  if (cfg.cacheDir) return String(cfg.cacheDir)
  return join(homedir(), '.dsh', 'cache', 'dsh-video-read')
}

/** Writable scratch directory for PyInstaller-packaged executables. */
export function tempDirFor(cfg = {}) {
  return join(cacheRoot(cfg), 'tmp')
}

function runProcess(exe, args, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, cwd, tempDir } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    if (tempDir) {
      try {
        mkdirSync(tempDir, { recursive: true })
      } catch {}
      env.TEMP = tempDir
      env.TMP = tempDir
      env.TMPDIR = tempDir
    }
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => {
      child.kill()
      finish(new Error('yt-dlp was cancelled'))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= MAX_CAPTURE_BYTES) stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= MAX_CAPTURE_BYTES) stderr.push(chunk)
    })
    child.on('error', (error) => finish(new Error(`could not start yt-dlp: ${error.message}`)))
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (code === 0) finish(null, { stdout: out, stderr: err })
      else finish(new Error(`yt-dlp exited with code ${code}: ${(err || out).trim().slice(0, 800) || 'no output'}`))
    })
  })
}

/** Candidate yt-dlp executables, most explicit first. */
export function ytdlpCandidates(cfg = {}) {
  const candidates = []
  if (cfg.ytdlpPath) candidates.push(String(cfg.ytdlpPath))
  candidates.push('yt-dlp.exe', 'yt-dlp')
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) candidates.push(join(localAppData, 'Programs', 'yt-dlp', 'yt-dlp.exe'))
  candidates.push(join(cacheRoot(cfg), 'bin', 'yt-dlp.exe'))
  return [...new Set(candidates)]
}

async function versionOf(exe, tempDir, { signal, timeoutMs = 30_000 } = {}) {
  try {
    const { stdout } = await runProcess(exe, ['--version'], { signal, timeoutMs, tempDir })
    const line = String(stdout).trim().split(/\r?\n/)[0] ?? ''
    return VERSION_PATTERN.test(line) ? line : null
  } catch {
    return null
  }
}

/** Return the first yt-dlp executable that answers --version, else null. */
export async function findYtdlp(cfg = {}, { signal } = {}) {
  const tempDir = tempDirFor(cfg)
  for (const candidate of ytdlpCandidates(cfg)) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (!existsSync(candidate)) continue
    }
    const version = await versionOf(candidate, tempDir, { signal })
    if (version) return candidate
  }
  return null
}

async function sha512File(file) {
  const hash = createHash('sha512')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('base64')
}

async function registryLatest({ signal } = {}) {
  const url = `${NPM_REGISTRY}/${encodeURIComponent(YTDLP_NPM_PACKAGE)}/latest`
  const response = await fetchWithDeadline(url, {
    signal,
    timeoutMs: 20_000,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`could not read ${YTDLP_NPM_PACKAGE} metadata: HTTP ${response.status}`)
  const text = await readTextCapped(response, { maxBytes: 2 * 1024 * 1024, idleTimeoutMs: 20_000, signal })
  const data = JSON.parse(text)
  const tarball = data?.dist?.tarball
  if (typeof tarball !== 'string' || !/^https:\/\//i.test(tarball)) {
    throw new Error(`the ${YTDLP_NPM_PACKAGE} registry entry has no https tarball`)
  }
  const registryHost = new URL(NPM_REGISTRY).hostname
  let tarballHost
  try {
    tarballHost = new URL(tarball).hostname
  } catch {
    throw new Error(`the ${YTDLP_NPM_PACKAGE} registry entry has an invalid tarball URL`)
  }
  if (tarballHost !== registryHost) {
    throw new Error(`refusing a ${YTDLP_NPM_PACKAGE} tarball served from ${tarballHost} (expected ${registryHost})`)
  }
  return {
    tarball,
    integrity: typeof data?.dist?.integrity === 'string' ? data.dist.integrity : null,
    version: typeof data?.version === 'string' ? data.version : null,
  }
}

function tarExecutable() {
  return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
}

/**
 * Reject a tarball whose nominated member is not a plain file. The npm mirror
 * is https + same-origin + integrity-checked, but a tar entry can still be a
 * symlink or an absolute path; extracting one blindly is how tar-slip bugs
 * start. `tar -tvf` lists the type flag, so a "l"/"h" entry never reaches
 * extraction.
 */
async function assertMemberIsRegularFile(tgz, { signal } = {}) {
  const { stdout } = await runProcess(tarExecutable(), ['-tvf', tgz], {
    signal,
    timeoutMs: 120_000,
    tempDir: dirname(tgz),
  })
  const line = String(stdout)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry === YTDLP_TARBALL_MEMBER || entry.endsWith(` ${YTDLP_TARBALL_MEMBER}`))
  if (!line) throw new Error(`the ${YTDLP_NPM_PACKAGE} tarball did not contain ${YTDLP_TARBALL_MEMBER}`)
  const type = line[0]
  if (type !== '-') {
    throw new Error(`the ${YTDLP_NPM_PACKAGE} member ${YTDLP_TARBALL_MEMBER} is not a regular file (type "${type}")`)
  }
}

async function extractMember(tgz, staging, { signal } = {}) {
  await mkdir(staging, { recursive: true })
  await assertMemberIsRegularFile(tgz, { signal })
  await runProcess(tarExecutable(), ['-xzf', tgz, '-C', staging, YTDLP_TARBALL_MEMBER], {
    signal,
    timeoutMs: 120_000,
    tempDir: staging,
  })
  const extracted = join(staging, ...YTDLP_TARBALL_MEMBER.split('/'))
  if (!existsSync(extracted)) throw new Error(`the ${YTDLP_NPM_PACKAGE} tarball did not contain ${YTDLP_TARBALL_MEMBER}`)
  return extracted
}

const MIN_YTDLP_BYTES = 5 * 1024 * 1024

/**
 * Refuse to execute something that is not an actual Windows PE binary.
 * The registry integrity check protects the tarball in transit; this check
 * catches a member that is a script, a stub, or a truncated download before it
 * is ever spawned.
 */
async function assertWindowsExecutable(file) {
  const info = await stat(file)
  if (info.size < MIN_YTDLP_BYTES) {
    throw new Error(`the extracted yt-dlp is unexpectedly small (${info.size} bytes); refusing to run it`)
  }
  const handle = await open(file, 'r')
  try {
    const head = Buffer.alloc(2)
    await handle.read(head, 0, 2, 0)
    if (head.toString('latin1') !== 'MZ') {
      throw new Error('the extracted yt-dlp is not a Windows executable; refusing to run it')
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Install yt-dlp from the npm mirror; returns the executable path. */
export async function installYtdlp(cfg = {}, { signal } = {}) {
  const root = cacheRoot(cfg)
  const binDir = join(root, 'bin')
  const downloads = join(root, 'downloads')
  const staging = join(root, 'extract')
  await mkdir(binDir, { recursive: true })
  await mkdir(downloads, { recursive: true })
  const meta = await registryLatest({ signal })
  if (!meta.integrity) {
    // Fail closed: an executable whose bytes we cannot verify must never be run.
    throw new Error(`the ${YTDLP_NPM_PACKAGE} registry entry has no sha512 integrity; refusing to install it`)
  }
  const expected = /^sha512-([A-Za-z0-9+/=]+)$/.exec(meta.integrity)?.[1]
  if (!expected) {
    throw new Error(`the ${YTDLP_NPM_PACKAGE} registry entry has an unusable integrity value; refusing to install it`)
  }
  const tarballFile = join(downloads, `yt-dlp-static-${meta.version ?? 'latest'}.tgz`)
  if (!existsSync(tarballFile)) {
    await downloadToFile(meta.tarball, tarballFile, {
      signal,
      idleTimeoutMs: 60_000,
      maxBytes: YTDLP_TARBALL_MAX_BYTES,
      validateUrl: (value) => {
        const parsed = new URL(value)
        const registryHost = new URL(NPM_REGISTRY).hostname
        if (parsed.protocol !== 'https:') throw new Error(`refusing non-https yt-dlp download: ${value}`)
        if (parsed.hostname !== registryHost) {
          throw new Error(`refusing a yt-dlp download from ${parsed.hostname} (expected ${registryHost})`)
        }
      },
    })
  }
  {
    const actual = await sha512File(tarballFile)
    if (actual !== expected) {
      await rm(tarballFile, { force: true })
      throw new Error('the downloaded yt-dlp package failed its integrity check; refusing to run it')
    }
  }
  await rm(staging, { recursive: true, force: true })
  const extracted = await extractMember(tarballFile, staging, { signal })
  const target = join(binDir, 'yt-dlp.exe')
  await rm(target, { force: true })
  await copyFile(extracted, target)
  try {
    await assertWindowsExecutable(target)
  } catch (error) {
    await rm(target, { force: true }).catch(() => {})
    throw error
  }
  const version = await versionOf(target, tempDirFor(cfg), { signal, timeoutMs: 60_000 })
  if (!version) {
    await rm(target, { force: true })
    throw new Error('the installed yt-dlp did not answer --version; removed it')
  }
  await writeFile(
    join(binDir, 'yt-dlp.json'),
    `${JSON.stringify(
      {
        package: YTDLP_NPM_PACKAGE,
        version,
        integrity: meta.integrity,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await rm(staging, { recursive: true, force: true }).catch(() => {})
  await rm(tarballFile, { force: true }).catch(() => {})
  return target
}

/** Resolve yt-dlp, installing it on first use when allowed. */
export async function ensureYtdlp(cfg = {}, { signal, onEvent } = {}) {
  const existing = await findYtdlp(cfg, { signal })
  if (existing) return existing
  if (cfg.autoDownloadYtdlp === false) {
    const error = new Error(INSTALL_HINT)
    error.code = 'E_YTDLP_MISSING'
    throw error
  }
  try {
    onEvent?.({ type: 'runtime', detail: 'installing yt-dlp (npm mirror)' })
    return await installYtdlp(cfg, { signal })
  } catch (error) {
    const wrapped = new Error(`${INSTALL_HINT} (auto-install failed: ${error.message})`)
    wrapped.code = 'E_YTDLP_MISSING'
    throw wrapped
  }
}

/** Extract the metadata JSON that `yt-dlp -J` prints. */
export function parseYtdlpJson(stdout) {
  const trimmed = String(stdout ?? '').trim()
  const index = trimmed.lastIndexOf('\n{')
  const text = index >= 0 ? trimmed.slice(index + 1) : trimmed
  return JSON.parse(text)
}

/**
 * Resolve a yt-dlp-supported URL into the same descriptor shape the rest of the
 * plugin uses. Metadata only when `download` is false.
 */
export async function resolveYoutube(input, options = {}) {
  const { cfg = {}, signal, ff = null, cacheDir, download = false, log = () => {}, kind = 'youtube', onEvent } = options
  const tempDir = tempDirFor(cfg)
  const exe = await ensureYtdlp(cfg, { signal, onEvent })
  log('yt-dlp: resolving metadata')
  // --ignore-config: a user's global yt-dlp.conf (e.g. --embed-subs) breaks the
  // pinned CLI contract here; the plugin must behave identically per machine.
  const { stdout } = await runProcess(
    exe,
    ['--ignore-config', '-J', '--no-warnings', '--no-playlist', '--', String(input)],
    {
      signal,
      timeoutMs: 120_000,
      tempDir,
    },
  )
  const info = parseYtdlpJson(stdout)
  // A playlist/collection URL would otherwise mix playlist metadata with the
  // last downloaded entry, so refuse it explicitly instead of guessing.
  if (info?._type === 'playlist' || (Array.isArray(info?.entries) && info.entries.length > 0)) {
    const error = new Error(
      'this URL is a playlist/collection, not a single video; pass one video URL ' +
        '(or download the entry you want and pass its local file)',
    )
    error.code = 'E_PLAYLIST'
    throw error
  }
  const label = kind === 'youtube' ? 'YouTube' : 'web'
  const meta = {
    kind,
    input,
    webpageUrl: info.webpage_url ?? String(input),
    videoId: info.id ?? null,
    title: info.title ?? `${label} video`,
    owner: info.uploader ?? info.channel ?? null,
    durationSec: Number(info.duration) || 0,
    width: Number(info.width) || null,
    height: Number(info.height) || null,
    hasAudio: null,
    subtitles: { cues: [], languages: [], note: null },
    notes: [`resolved through yt-dlp (${label})`],
    filePath: null,
    cacheDir: null,
  }
  if (!download) return meta
  if (!cacheDir) throw new Error('internal error: yt-dlp download needs a cache directory')

  // Subtitle sidecars first: they are small and give text evidence even if the
  // mp4 download fails.
  try {
    await runProcess(
      exe,
      [
        '--ignore-config',
        '--skip-download', '--write-subs', '--write-auto-subs', '--no-playlist',
        '--sub-langs', 'zh-Hans,zh-CN,zh,en.*',
        '--sub-format', 'vtt/srt',
        '-o', join(cacheDir, 'subs.%(ext)s'),
        '--', String(input),
      ],
      { signal, timeoutMs: 120_000, tempDir },
    )
    const files = (await readdir(cacheDir)).filter((name) => /^subs\.(.*\.)?(vtt|srt)$/i.test(name))
    if (files.length) {
      const preferred = files.find((name) => /zh/i.test(name)) ?? files[0]
      const text = await readFile(join(cacheDir, preferred), 'utf8')
      const cues = parseSrtOrVtt(text)
      meta.subtitles = {
        cues,
        languages: [preferred],
        note: files.length > 1 ? `several subtitle tracks present; used ${preferred}` : null,
      }
    }
  } catch (error) {
    meta.subtitles.note = `subtitle download failed: ${error.message}`
  }

  log('yt-dlp: downloading <=720p mp4')
  // yt-dlp needs an ffmpeg to merge the DASH video/audio streams; without it it
  // silently leaves source.f<id>.mp4 + source.f<id>.m4a behind. Some Bilibili
  // CDN mirrors also refuse connections for particular codecs, so retry once
  // with a different format preference before giving up.
  const ffmpegDir = ff?.ffmpeg ? dirname(String(ff.ffmpeg)) : null
  const formatAttempts = [
    'bv*[height<=720]+ba/b[height<=720]',
    'bv*[vcodec^=avc1][height<=720]+ba/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
  ]
  const cleanPartial = async () => {
    for (const name of await readdir(cacheDir)) {
      if (/^source\./.test(name) && !/^source\.mp4$/i.test(name)) await rm(join(cacheDir, name), { force: true })
    }
  }
  let lastError = null
  let downloaded = null
  for (const [index, selector] of formatAttempts.entries()) {
    if (index > 0) {
      await cleanPartial().catch(() => {})
      log('yt-dlp: retrying the download with a different format preference')
    }
    try {
      await runProcess(
        exe,
        [
          '--ignore-config',
          ...(ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : []),
          '-f', selector,
          '--merge-output-format', 'mp4',
          '--no-playlist', '--write-thumbnail',
          '--retries', '3', '--fragment-retries', '3', '--socket-timeout', '20',
          // DASH/HLS downloads are fragment-parallel; 4 streams hides most of
          // the per-fragment latency on long videos without stressing mirrors.
          '--concurrent-fragments', '4',
          '-o', join(cacheDir, 'source.%(ext)s'),
          '--', String(input),
        ],
        { signal, timeoutMs: 300_000, tempDir },
      )
      const produced = await readdir(cacheDir)
      downloaded = produced.find((name) => /^source\.mp4$/i.test(name)) ?? null
      if (!downloaded) {
        const videoOnly = produced.filter((name) => /^source\.f\d+\.(mp4|m4v|webm|mkv)$/i.test(name))
        if (videoOnly.length === 1) {
          downloaded = videoOnly[0]
          meta.notes.push('yt-dlp could not merge the audio track; using the video-only stream')
        }
      }
      if (downloaded) break
      lastError = new Error('yt-dlp finished but produced no usable video file')
    } catch (error) {
      lastError = error
    }
  }
  if (!downloaded) throw lastError ?? new Error('yt-dlp finished but produced no usable video file')
  // Drop leftover per-format files from an unmerged attempt to keep the cache small.
  for (const name of await readdir(cacheDir)) {
    if (name !== downloaded && /^source\.f\d+\./.test(name)) {
      await rm(join(cacheDir, name), { force: true }).catch(() => {})
    }
  }
  meta.filePath = join(cacheDir, downloaded)
  if (ff?.available) {
    try {
      const probe = await probeMedia(ff, meta.filePath, { signal })
      meta.durationSec = probe.durationSec || meta.durationSec
      meta.width = probe.width
      meta.height = probe.height
      meta.hasAudio = probe.hasAudio
      meta.hasVideo = probe.hasVideo
    } catch (error) {
      meta.notes.push(`probe of downloaded media failed: ${error.message}`)
    }
  }
  return meta
}
