/**
 * ffmpeg/ffprobe discovery, on-demand download, probing, frame extraction and
 * scene detection. The DSH host ships no ffmpeg CLI, so the plugin either uses
 * a user-provided binary or fetches a static Windows build into its own cache.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { downloadToFile, fetchWithDeadline, readTextCapped } from './net.js'

const IS_WIN = platform() === 'win32'
const EXE = IS_WIN ? '.exe' : ''
const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows'

/**
 * Spawn Windows system tools through their absolute System32 path: the bare
 * name search order includes the process CWD, which is the workspace.
 */
function preferSystemExe(candidates, fallback) {
  for (const candidate of candidates) {
    try {
      const full = join(SYSTEM_ROOT, ...candidate.split('/'))
      if (existsSync(full)) return full
    } catch {}
  }
  return fallback
}

const TAR_EXE = IS_WIN ? preferSystemExe(['System32/tar.exe'], 'tar') : 'tar'
const POWERSHELL_EXE = IS_WIN
  ? preferSystemExe(['System32/WindowsPowerShell/v1.0/powershell.exe'], 'powershell.exe')
  : 'powershell'

/**
 * Fast path: the npm mirror ships the Windows binaries inside the tarball itself,
 * so no GitHub release redirect is involved. gyan.dev / BtbN are slow or stalled
 * from many networks, so they are only the fallback.
 */
const NPM_FFMPEG_PKG = '@ffmpeg-installer/win32-x64'
const NPM_FFMPEG_VERSION = '4.1.0'
const NPM_FFPROBE_PKG = '@ffprobe-installer/win32-x64'
const NPM_FFPROBE_VERSION = '5.1.0'
const NPM_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
const ZIP_URLS = [
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
]

/** Resolve the plugin's private cache directory. */
export function cacheDir(cfg) {
  return cfg.cacheDir || join(homedir(), '.dsh', 'cache', 'dsh-video-read')
}

/** Run a child process and capture output; rejects on non-zero exit unless allowed. */
export function run(exe, args, options = {}) {
  const { signal, timeoutMs = 180_000, allowNonZero = false, env } = options
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ?? process.env,
      })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
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
      try {
        child.kill('SIGKILL')
      } catch {}
      finish(new Error(`cancelled while running ${exe}`))
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish(new Error(`${exe} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (code === 0 || allowNonZero) {
        finish(null, { code, stdout, stderr })
      } else {
        const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n')
        finish(new Error(`${exe} exited with code ${code}${tail ? `: ${tail}` : ''}`))
      }
    })
  })
}

function works(exe) {
  if (!exe) return false
  const probe = spawnSync(exe, ['-version'], { windowsHide: true, encoding: 'utf8', timeout: 15_000 })
  return probe.status === 0 ? String(probe.stdout || '').split(/\r?\n/)[0] : null
}

async function walkForExe(dir, name, depth = 0) {
  if (depth > 5) return null
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await walkForExe(join(dir, entry.name), name, depth + 1)
    if (found) return found
  }
  return null
}

async function readPointer(cfg) {
  const cache = resolve(cacheDir(cfg))
  try {
    const raw = JSON.parse(await readFile(join(cache, 'ffmpeg-bin.json'), 'utf8'))
    if (!raw.ffmpeg || !raw.ffprobe) return null
    // A pointer written by another local process must not be able to make the
    // plugin spawn an arbitrary executable: require both paths inside the cache.
    const inside = (candidate, name) => {
      if (typeof candidate !== 'string') return false
      const absolute = resolve(candidate)
      const rel = relative(cache, absolute)
      return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel) && basename(absolute).toLowerCase() === name.toLowerCase()
    }
    return inside(raw.ffmpeg, `ffmpeg${EXE}`) && inside(raw.ffprobe, `ffprobe${EXE}`) ? raw : null
  } catch {}
  return null
}

function npmTarballUrl(registry, pkg, version) {
  const short = pkg.split('/').pop()
  return `${registry.replace(/\/+$/, '')}/${pkg}/-/${short}-${version}.tgz`
}

/** Download one archive with hard byte/idle/time bounds, then report its size. */
async function downloadArchive(url, dest, options) {
  const { signal, timeoutMs = 300_000, minBytes = 8_000_000, log = () => {} } = options
  return downloadToFile(url, dest, {
    signal,
    headers: { 'user-agent': 'dsh-video-read/0.1 (+ffmpeg bootstrap)' },
    timeoutMs,
    idleTimeoutMs: 45_000,
    maxBytes: 500_000_000,
    minBytes,
    log,
  })
}

function assertSafeArchive(archive) {
  const listing = spawnSync(TAR_EXE, ['-tf', archive], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (listing.status !== 0) {
    throw new Error(`could not list archive ${basename(archive)}: ${listing.stderr || listing.status}`)
  }
  const unsafe = listing.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((entry) => {
      const normalized = entry.replace(/\\/g, '/')
      return /^([a-zA-Z]:|\/)/.test(normalized) || normalized.split('/').includes('..')
    })
  if (unsafe) {
    throw new Error(`archive ${basename(archive)} contains an unsafe entry (${unsafe}); refusing to extract`)
  }
}

const integrityCache = new Map()

/** Read the registry's declared dist.integrity for one exact package version. */
async function npmIntegrity(registry, pkg, version, { signal, log = () => {} }) {
  const key = `${registry}|${pkg}|${version}`
  if (integrityCache.has(key)) return integrityCache.get(key)
  const url = `${registry.replace(/\/+$/, '')}/${pkg}/${version}`
  log(`verifying ${pkg}@${version} against the ${registry} manifest`)
  const response = await fetchWithDeadline(url, {
    signal,
    timeoutMs: 20_000,
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!response.ok) throw new Error(`registry metadata HTTP ${response.status}`)
  const text = await readTextCapped(response, { maxBytes: 2_000_000, idleTimeoutMs: 15_000, signal })
  const integrity = String(JSON.parse(text)?.dist?.integrity ?? '')
  if (!integrity) throw new Error('registry metadata has no dist.integrity')
  integrityCache.set(key, integrity)
  return integrity
}

/** Fail closed unless the downloaded bytes match the registry-declared hash. */
async function verifyIntegrity(file, integrity) {
  const match = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(String(integrity))
  if (!match) throw new Error(`unsupported integrity value: ${integrity}`)
  const actual = createHash(match[1]).update(await readFile(file)).digest('base64')
  if (actual !== match[2]) {
    throw new Error('archive integrity mismatch (registry manifest does not match the downloaded bytes)')
  }
}

async function extractTarGz(tgz, dest) {
  assertSafeArchive(tgz)
  await mkdir(dest, { recursive: true })
  const tar = spawnSync(TAR_EXE, ['-xzf', tgz, '-C', dest], { windowsHide: true, encoding: 'utf8', timeout: 300_000 })
  if (tar.status !== 0) throw new Error(`tar failed to extract ${basename(tgz)}: ${tar.stderr || tar.status}`)
}

async function extractZip(zip, dest) {
  assertSafeArchive(zip)
  await mkdir(dest, { recursive: true })
  const tar = spawnSync(TAR_EXE, ['-xf', zip, '-C', dest], { windowsHide: true, encoding: 'utf8', timeout: 300_000 })
  if (tar.status === 0) return
  // PowerShell fallback; single-quoted literals keep paths with quotes/spaces safe.
  const psPath = (value) => `'${String(value).replace(/'/g, "''")}'`
  const script = `Expand-Archive -LiteralPath ${psPath(zip)} -DestinationPath ${psPath(dest)} -Force`
  const ps = spawnSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 300_000,
  })
  if (ps.status !== 0) throw new Error(`Expand-Archive failed for ${basename(zip)}: ${ps.stderr || ps.status}`)
}

async function tryNpmPair(cfg, { signal, log }) {
  const cache = cacheDir(cfg)
  const cacheKey = `npm-${NPM_FFMPEG_VERSION}`
  const dir = join(cache, cacheKey)
  let ffmpeg = await walkForExe(dir, `ffmpeg${EXE}`)
  if (!ffmpeg || !works(ffmpeg)) {
    const tgz = join(cache, `ffmpeg-${NPM_FFMPEG_VERSION}.tgz`)
    let lastError = null
    for (const registry of NPM_REGISTRIES) {
      const url = npmTarballUrl(registry, NPM_FFMPEG_PKG, NPM_FFMPEG_VERSION)
      try {
        const size = await downloadArchive(url, tgz, { signal, log })
        if (cfg.verifyFfmpegIntegrity !== false) {
          const integrity = await npmIntegrity(registry, NPM_FFMPEG_PKG, NPM_FFMPEG_VERSION, { signal, log })
          await verifyIntegrity(tgz, integrity)
        }
        log(`extracting ffmpeg (${size} bytes)`)
        await extractTarGz(tgz, dir)
        await unlink(tgz).catch(() => {})
        lastError = null
        break
      } catch (error) {
        lastError = error
        log(`ffmpeg tgz failed from ${registry}: ${error.message}`)
      }
    }
    if (lastError) throw lastError
    ffmpeg = await walkForExe(dir, `ffmpeg${EXE}`)
    if (!ffmpeg || !works(ffmpeg)) throw new Error('npm ffmpeg tarball did not contain a runnable ffmpeg.exe')
  }
  const probeDir = join(cache, `npm-ffprobe-${NPM_FFPROBE_VERSION}`)
  let ffprobe = await walkForExe(probeDir, `ffprobe${EXE}`)
  if (!ffprobe) {
    const tgz = join(cache, `ffprobe-${NPM_FFPROBE_VERSION}.tgz`)
    let lastError = null
    for (const registry of NPM_REGISTRIES) {
      const url = npmTarballUrl(registry, NPM_FFPROBE_PKG, NPM_FFPROBE_VERSION)
      try {
        const size = await downloadArchive(url, tgz, { signal, log })
        if (cfg.verifyFfmpegIntegrity !== false) {
          const integrity = await npmIntegrity(registry, NPM_FFPROBE_PKG, NPM_FFPROBE_VERSION, { signal, log })
          await verifyIntegrity(tgz, integrity)
        }
        log(`extracting ffprobe (${size} bytes)`)
        await extractTarGz(tgz, probeDir)
        await unlink(tgz).catch(() => {})
        lastError = null
        break
      } catch (error) {
        lastError = error
        log(`ffprobe tgz failed from ${registry}: ${error.message}`)
      }
    }
    if (lastError) throw lastError
    ffprobe = await walkForExe(probeDir, `ffprobe${EXE}`)
    if (!ffprobe) throw new Error('npm ffprobe tarball did not contain ffprobe.exe')
  }
  return { ffmpeg, ffprobe, via: 'npm' }
}

async function downloadFfmpeg(cfg, { signal, log = () => {} }) {
  const cache = cacheDir(cfg)
  await mkdir(cache, { recursive: true })
  let lastError = null
  try {
    const pair = await tryNpmPair(cfg, { signal, log })
    const version = works(pair.ffmpeg)
    if (!version) throw new Error('downloaded ffmpeg does not run')
    const pointer = { ffmpeg: pair.ffmpeg, ffprobe: pair.ffprobe, version, via: pair.via, downloadedAt: new Date().toISOString() }
    await writeFile(join(cache, 'ffmpeg-bin.json'), JSON.stringify(pointer, null, 2), 'utf8')
    return pointer
  } catch (error) {
    lastError = error
    log(`npm ffmpeg path failed: ${error.message}`)
  }
  for (const url of ZIP_URLS) {
    const zip = join(cache, 'ffmpeg-essentials.zip')
    const dest = join(cache, 'ffmpeg-dist')
    try {
      const size = await downloadArchive(url, zip, { signal, log })
      log(`extracting archive (${size} bytes)`)
      await extractZip(zip, dest)
      const ffmpeg = await walkForExe(dest, `ffmpeg${EXE}`)
      const ffprobe = await walkForExe(dest, `ffprobe${EXE}`)
      if (!ffmpeg || !ffprobe) throw new Error('archive did not contain ffmpeg/ffprobe')
      const version = works(ffmpeg)
      if (!version) throw new Error('downloaded ffmpeg does not run')
      const pointer = { ffmpeg, ffprobe, version, via: url, downloadedAt: new Date().toISOString() }
      await writeFile(join(cache, 'ffmpeg-bin.json'), JSON.stringify(pointer, null, 2), 'utf8')
      await unlink(zip).catch(() => {})
      return pointer
    } catch (error) {
      lastError = error
      log(`ffmpeg download failed from ${url}: ${error.message}`)
    }
  }
  throw new Error(
    `could not obtain ffmpeg: ${lastError ? lastError.message : 'unknown error'}. ` +
      'Set config.ffmpegPath to an existing ffmpeg.exe, or install ffmpeg and add it to PATH.',
  )
}

const resolveCache = new Map()
const RESOLVE_TTL_MS = 5 * 60_000
const RESOLVE_FAIL_TTL_MS = 20_000

function resolveKey(cfg) {
  return [cfg.ffmpegPath ?? '', cfg.cacheDir ?? '', cfg.autoDownloadFfmpeg ?? true, process.env.FFMPEG_PATH ?? ''].join('|')
}

/**
 * Locate a usable ffmpeg/ffprobe pair.
 * @returns {Promise<{available:boolean, ffmpeg?:string, ffprobe?:string, version?:string,
 *   downloaded?:boolean, note?:string}>}
 */
export async function resolveFfmpeg(cfg = {}, options = {}) {
  const key = resolveKey(cfg)
  const hit = resolveCache.get(key)
  if (hit && Date.now() - hit.at < (hit.result?.available ? RESOLVE_TTL_MS : RESOLVE_FAIL_TTL_MS)) {
    return hit.result
  }
  const result = await resolveFfmpegUncached(cfg, options)
  resolveCache.set(key, { at: Date.now(), result })
  return result
}

async function resolveFfmpegUncached(cfg = {}, options = {}) {
  const { signal, log = () => {} } = options
  const explicit = cfg.ffmpegPath || process.env.FFMPEG_PATH
  if (explicit) {
    const ffmpeg = explicit
    const ffprobe = explicit.replace(/ffmpeg(\.exe)?$/i, `ffprobe${EXE}`)
    const version = works(ffmpeg)
    if (!version) {
      return { available: false, note: `configured ffmpeg does not run: ${ffmpeg}` }
    }
    return { available: true, ffmpeg, ffprobe, version }
  }

  const pointer = await readPointer(cfg)
  if (pointer) {
    const version = works(pointer.ffmpeg)
    if (version) return { available: true, ffmpeg: pointer.ffmpeg, ffprobe: pointer.ffprobe, version }
  }

  const pathVersion = works(`ffmpeg`)
  if (pathVersion) return { available: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: pathVersion }

  if (cfg.autoDownloadFfmpeg === false) {
    return { available: false, note: 'ffmpeg is not installed and autoDownloadFfmpeg is false' }
  }
  try {
    options.onEvent?.({ type: 'runtime', detail: 'downloading ffmpeg + ffprobe (npm mirror)' })
    const downloaded = await downloadFfmpeg(cfg, { signal, log })
    return { available: true, ffmpeg: downloaded.ffmpeg, ffprobe: downloaded.ffprobe, version: downloaded.version, downloaded: true }
  } catch (error) {
    return { available: false, note: error.message }
  }
}

const probeCache = new Map()
const PROBE_CACHE_TTL_MS = 5 * 60_000

/** Probe a media file for duration and stream layout (memoized per file version). */
export async function probeMedia(ff, file, { signal } = {}) {
  let fingerprint = ''
  try {
    const info = await stat(file)
    fingerprint = `${info.size}|${Math.round(info.mtimeMs)}`
  } catch {}
  const key = `${ff.ffprobe}|${file}|${fingerprint}`
  const hit = probeCache.get(key)
  if (hit && Date.now() - hit.at < PROBE_CACHE_TTL_MS) return hit.value
  const { stdout } = await run(
    ff.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { signal, timeoutMs: 120_000 },
  )
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`ffprobe returned unreadable JSON for ${basename(file)}; the file may be corrupt`)
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video')
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  const durationSec =
    Number(parsed.format?.duration) || Number(video?.duration) || Number(audio?.duration) || 0
  const value = {
    durationSec,
    width: Number(video?.width) || null,
    height: Number(video?.height) || null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    frameRate: video?.avg_frame_rate ?? null,
    bitRate: Number(parsed.format?.bit_rate) || null,
  }
  probeCache.set(key, { at: Date.now(), value })
  return value
}

/** Mux a DASH video-only file and an audio-only file into one container. */
export async function muxDash(ff, videoFile, audioFile, outFile, { signal } = {}) {
  await run(
    ff.ffmpeg,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-y',
      '-i', videoFile,
      '-i', audioFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      outFile,
    ],
    { signal, timeoutMs: 240_000 },
  )
}

function frameFilter(width) {
  if (!width) return 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
  return `scale='min(${width},iw)':-2`
}

const FONT_CANDIDATES = [
  process.env.DSH_VIDEO_READ_FONT,
  join(SYSTEM_ROOT, 'Fonts', 'arial.ttf'),
  join(SYSTEM_ROOT, 'Fonts', 'segoeui.ttf'),
  join(SYSTEM_ROOT, 'Fonts', 'msyh.ttc'),
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
].filter(Boolean)

/**
 * Locate a font usable by the drawtext filter. Timestamps are ASCII, so a
 * narrow Latin font is enough; a missing font simply disables burned labels.
 * @returns {string|null}
 */
export function pickDrawTextFont() {
  for (const candidate of FONT_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {}
  }
  return null
}

/** Escape a path for use inside an ffmpeg -vf filter argument. */
function escapeFilterPath(path) {
  return String(path).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * Build a drawtext filter that burns a label into the top-left corner.
 * @param {string} fontFile
 * @param {string} text
 * @param {{fontSize?:number, x?:number, y?:number}} options
 */
export function drawTextFilter(fontFile, text, { fontSize = 18, x = 6, y = 6 } = {}) {
  const safeText = String(text).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/%/g, '\\%').replace(/'/g, "\\'")
  return (
    `drawtext=fontfile='${escapeFilterPath(fontFile)}':text='${safeText}':` +
    `x=${x}:y=${y}:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=4`
  )
}

/** Extract one JPEG at each timestamp (seconds). */
export async function extractFrames(ff, file, times, outDir, options = {}) {
  const { width = 1280, quality = 3, concurrency = 3, signal, onFrame } = options
  await mkdir(outDir, { recursive: true })
  const results = new Array(times.length)
  let cursor = 0
  const grab = async (time, path) => {
    await run(
      ff.ffmpeg,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-an',
        '-sn',
        '-dn',
        '-threads', '1',
        '-ss', String(time),
        '-i', file,
        '-frames:v', '1',
        '-vf', frameFilter(width),
        '-q:v', String(quality),
        '-y',
        path,
      ],
      { signal, timeoutMs: 120_000 },
    )
    const info = await stat(path)
    if (info.size < 512) throw new Error('empty frame')
    return info.size
  }
  const worker = async () => {
    while (cursor < times.length) {
      const index = cursor++
      const requested = times[index]
      // The final container timestamp can sit past the last decoded frame; retry a
      // little earlier instead of returning a hole in the evidence set.
      const attempts = [requested]
      if (requested > 0.25) attempts.push(Number((requested - 0.25).toFixed(3)))
      if (requested > 0.75) attempts.push(Number((requested - 0.75).toFixed(3)))
      let lastError = null
      for (const actual of attempts) {
        const path = join(
          outDir,
          `frame-${String(index + 1).padStart(3, '0')}-${actual.toFixed(2).replace('.', '_')}s.jpg`,
        )
        try {
          const bytes = await grab(actual, path)
          results[index] = { time: actual, requestedTime: requested, path, bytes, adjusted: actual !== requested }
          if (onFrame) onFrame(results[index])
          lastError = null
          break
        } catch (error) {
          lastError = error
        }
      }
      if (lastError) results[index] = { time: requested, requestedTime: requested, path: null, error: lastError.message }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, times.length)) }, worker))
  return results
}

/** Return timestamps (seconds) where the scene score exceeds `threshold`. */
export async function detectScenes(ff, file, options = {}) {
  const { threshold = 0.3, start = 0, end = 0, maxTime = 0, timeoutMs, signal } = options
  const from = Math.max(0, Number(start) || 0)
  const stop = Math.max(from, Number(end) || Number(maxTime) || 0)
  const span = stop > from ? stop - from : 0
  const filter = `select=gt(scene\\,${threshold}),showinfo`
  const args = ['-hide_banner', '-nostats', '-an']
  if (from > 0) args.push('-ss', String(from))
  args.push('-i', file, '-vf', filter, '-vsync', 'vfr')
  if (span > 0) args.push('-t', String(span))
  args.push('-f', 'null', '-')
  // Decode only the requested window: decoding a 50-minute prefix to inspect ten
  // seconds used to blow the tool budget.
  const budget = Number.isFinite(timeoutMs) ? timeoutMs : Math.min(300_000, Math.max(60_000, span * 900))
  const { stderr } = await run(ff.ffmpeg, args, { signal, timeoutMs: budget, allowNonZero: true })
  const times = []
  const re = /pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g
  let match
  while ((match = re.exec(stderr)) !== null) {
    const value = Number(match[1]) + from
    if (Number.isFinite(value)) times.push(value)
  }
  const unique = []
  for (const value of times.sort((a, b) => a - b)) {
    if (!unique.length || value - unique[unique.length - 1] >= 0.2) unique.push(value)
  }
  return unique
}

/**
 * Extract evenly spaced frames in a single ffmpeg decode pass. One spawn is
 * roughly 15x faster than one seek-and-decode spawn per frame.
 */
export async function extractEven(ff, file, times, outDir, options = {}) {
  const { width = 1280, quality = 3, signal } = options
  if (!Array.isArray(times) || times.length === 0) return []
  if (times.length === 1) return extractFrames(ff, file, times, outDir, { ...options, concurrency: 1 })
  await mkdir(outDir, { recursive: true })
  const start = Math.max(0, times[0])
  const end = times[times.length - 1]
  const count = times.length
  // A single decode pass costs time proportional to the decoded span, while a
  // per-frame pass costs one short seek+spawn per requested frame. On long
  // videos with few requested times the single pass decodes minutes of footage
  // for a handful of frames, so switch to seeking past ~10s of span per frame.
  const span = Math.max(0, times[times.length - 1] - Math.max(0, times[0]))
  if (span > (count - 1) * 10) return extractFrames(ff, file, times, outDir, options)
  const fps = (count - 1) / Math.max(0.001, end - start)
  try {
    await run(
      ff.ffmpeg,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-an',
        '-sn',
        '-dn',
        '-ss', String(start),
        '-i', file,
        '-t', String(Math.max(0.5, end - start + 1)),
        '-vf', `fps=${fps.toFixed(6)},${frameFilter(width)}`,
        '-frames:v', String(count),
        '-q:v', String(quality),
        '-y',
        join(outDir, 'raw-%03d.jpg'),
      ],
      { signal, timeoutMs: Math.min(240_000, 60_000 + count * 2_000) },
    )
  } catch {
    return extractFrames(ff, file, times, outDir, options)
  }
  const results = []
  const missing = []
  for (let index = 0; index < count; index += 1) {
    const raw = join(outDir, `raw-${String(index + 1).padStart(3, '0')}.jpg`)
    const target = join(
      outDir,
      `frame-${String(index + 1).padStart(3, '0')}-${times[index].toFixed(2).replace('.', '_')}s.jpg`,
    )
    try {
      const info = await stat(raw)
      await rename(raw, target)
      results.push({ time: times[index], requestedTime: times[index], path: target, bytes: info.size, adjusted: false })
    } catch {
      results.push({ time: times[index], requestedTime: times[index], path: null, error: 'single-pass frame missing' })
      missing.push(index)
    }
  }
  // The fps filter drops a trailing sample that lies past the last decodable
  // frame; retry only the missing positions instead of re-doing the whole set.
  if (missing.length && missing.length < count) {
    const retried = await extractFrames(
      ff,
      file,
      missing.map((index) => times[index]),
      join(outDir, 'fallback'),
      options,
    )
    missing.forEach((index, order) => {
      const frame = retried[order]
      if (frame?.path) results[index] = frame
    })
  }
  if (results.some((result) => !result.path)) {
    return extractFrames(ff, file, times, join(outDir, 'fallback'), options)
  }
  return results
}

/** Detect scene cuts and save exactly those frames in one pass. */
export async function extractScene(ff, file, outDir, options = {}) {
  const {
    threshold = 0.3,
    start = 0,
    end = 0,
    maxFrames = 32,
    width = 1280,
    quality = 3,
    signal,
    timeoutMs,
  } = options
  const from = Math.max(0, Number(start) || 0)
  const stop = Math.max(from, Number(end) || 0)
  const span = stop > from ? stop - from : 0
  await mkdir(outDir, { recursive: true })
  const filter = `select=gt(scene\\,${threshold}),showinfo,${frameFilter(width)}`
  const args = ['-hide_banner', '-nostats', '-an']
  if (from > 0) args.push('-ss', String(from))
  args.push('-i', file, '-vf', filter, '-vsync', 'vfr', '-frames:v', String(maxFrames), '-q:v', String(quality))
  if (span > 0) args.push('-t', String(span))
  args.push('-y', join(outDir, 'raw-%03d.jpg'))
  const budget = Number.isFinite(timeoutMs) ? timeoutMs : Math.min(280_000, Math.max(60_000, span * 900))
  let stderr = ''
  try {
    ;({ stderr } = await run(ff.ffmpeg, args, { signal, timeoutMs: budget, allowNonZero: true }))
  } catch (error) {
    throw new Error(`scene extraction failed: ${error.message}`)
  }
  const times = []
  const re = /pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g
  let match
  while ((match = re.exec(stderr)) !== null) {
    const value = Number(match[1]) + from
    if (Number.isFinite(value)) times.push(value)
  }
  const unique = []
  for (const value of times.sort((a, b) => a - b)) {
    if (!unique.length || value - unique[unique.length - 1] >= 0.2) unique.push(value)
  }
  const results = []
  for (let index = 0; index < unique.length && index < maxFrames; index += 1) {
    const raw = join(outDir, `raw-${String(index + 1).padStart(3, '0')}.jpg`)
    const target = join(
      outDir,
      `frame-${String(index + 1).padStart(3, '0')}-${unique[index].toFixed(2).replace('.', '_')}s.jpg`,
    )
    try {
      const info = await stat(raw)
      await rename(raw, target)
      results.push({
        time: unique[index],
        requestedTime: unique[index],
        path: target,
        bytes: info.size,
        adjusted: false,
        scene: true,
      })
    } catch {}
  }
  // No cut found: report an empty set so the caller can fall back explicitly
  // instead of receiving a misleading one-frame "scene set" at the range start.
  return results
}
