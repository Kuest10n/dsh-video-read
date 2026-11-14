/**
 * Bilibili "videoshot" keyframe sprites: the platform already publishes a
 * 10x10 tile strip of keyframes plus their timestamps. Cropping one tile is far
 * cheaper than decoding the video, so this yields keyframe screenshots for long
 * videos without a full download.
 *
 * Security posture: every sprite URL handed back by the API is re-validated
 * against a Bilibili CDN host allowlist, and every redirect hop is checked
 * again (so a compromised/redirecting CDN cannot point us at a private host).
 * Downloaded strips are checked for a real JPEG SOI marker before ffmpeg is
 * asked to decode them.
 */
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { downloadToFile, fetchWithDeadline, readTextCapped } from './net.js'
import { run } from './ffmpeg.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_STRIP_BYTES = 40 * 1024 * 1024

/** Hosts Bilibili legitimately serves videoshot sprites from. */
const SHOT_CDN_HOST_SUFFIXES = [
  '.hdslb.com',
  '.bilibili.com',
  '.bilivideo.com',
  '.bilivideo.cn',
  '.szbdyd.com',
  '.mountaintoys.cn',
]

/** True for hosts that are not safe to fetch from arbitrary API data. */
function isForbiddenShotHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '')
  if (!host) return true
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host === 'metadata.google.internal'
  ) {
    return true
  }
  // Bilibili CDNs always use DNS names; a bare IP literal is not legitimate here.
  return isIP(host) !== 0
}

/**
 * Validate a sprite/API URL (including each redirect hop) before fetching.
 * Enforces https, a DNS host, the standard port, and the CDN allowlist.
 * Returns the normalized URL string; throws with a descriptive reason otherwise.
 */
export function assertShotCdnUrl(value, purpose = 'videoshot') {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new Error(`${purpose} URL is not a valid URL; refusing to fetch it`)
  }
  if (url.protocol !== 'https:') throw new Error(`${purpose} URL is not https; refusing to fetch it`)
  if (url.username || url.password) throw new Error(`${purpose} URL contains credentials; refusing to fetch it`)
  if (url.port && url.port !== '443') throw new Error(`${purpose} URL uses port ${url.port}; refusing to fetch it`)
  if (isForbiddenShotHost(url.hostname)) {
    throw new Error(`${purpose} URL points to a non-public host (${url.hostname}); refusing to fetch it`)
  }
  const host = url.hostname.toLowerCase()
  const allowed =
    host === 'bilibili.com' ||
    SHOT_CDN_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
  if (!allowed) {
    throw new Error(`${purpose} URL host "${host}" is not a known Bilibili CDN; refusing to fetch it`)
  }
  return url.toString()
}

/** Cache filename includes the URL so a changed sprite can never reuse a stale strip. */
export function spriteStripName(imageUrl, page) {
  const hash = createHash('sha256').update(String(imageUrl)).digest('hex').slice(0, 16)
  return `videoshot-page-${page}-${hash}.jpg`
}

/** Reject anything that is not a JPEG (SOI marker FF D8 FF) before ffmpeg reads it. */
export async function assertJpegStrip(file) {
  let handle
  try {
    handle = await open(file, 'r')
    const header = Buffer.alloc(3)
    const { bytesRead } = await handle.read(header, 0, 3, 0)
    if (bytesRead < 3 || header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff) {
      throw new Error('videoshot sprite is not a JPEG (missing SOI marker)')
    }
  } finally {
    try { await handle?.close?.() } catch {}
  }
}

/**
 * Fetch the keyframe sprite description (image pages, tile grid, timestamps).
 * @returns {Promise<{images:string[],xLen:number,yLen:number,xSize:number,ySize:number,times:number[]}>}
 */
export async function fetchVideoShots({ bvid, cid, signal, timeoutMs = 20_000 } = {}) {
  if (!bvid || !cid) throw new Error('keyframe shots require a Bilibili bvid and cid')
  const url = `https://api.bilibili.com/x/player/videoshot?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&index=1`
  const response = await fetchWithDeadline(url, {
    signal,
    timeoutMs,
    headers: { 'user-agent': UA, referer: REFERER },
    validateUrl: (value) => assertShotCdnUrl(value, 'videoshot API redirect'),
  })
  if (!response.ok) throw new Error(`videoshot request failed: HTTP ${response.status}`)
  const payload = JSON.parse(await readTextCapped(response, { maxBytes: MAX_JSON_BYTES, signal }))
  if (payload.code !== 0) throw new Error(`videoshot API error ${payload.code}: ${payload.message ?? 'unknown error'}`)
  const data = payload.data ?? {}
  const images = (Array.isArray(data.image) ? data.image : []).map((entry) => {
    const raw = String(entry)
    const absolute = raw.startsWith('//') ? `https:${raw}` : raw
    return assertShotCdnUrl(absolute, 'videoshot sprite')
  })
  const positiveInt = (value, fallback) => Math.max(1, Math.floor(Number(value) || fallback))
  const times = Array.isArray(data.index) ? data.index.map(Number).filter((value) => Number.isFinite(value)) : []
  return {
    images,
    xLen: positiveInt(data.img_x_len, 10),
    yLen: positiveInt(data.img_y_len, 10),
    xSize: positiveInt(data.img_x_size, 480),
    ySize: positiveInt(data.img_y_size, 270),
    times,
  }
}

/** Choose which sprite keyframes fall inside [start,end] (evenly spread, max N). */
export function pickShotIndices({ shots, start = 0, end, max = 8 }) {
  const from = Math.max(0, Number(start) || 0)
  const to = Number.isFinite(Number(end)) ? Number(end) : Infinity
  const candidates = shots.times.map((time, index) => ({ time, index })).filter((entry) => entry.time >= from - 0.5 && entry.time <= to + 0.5)
  if (!candidates.length) return []
  const cap = Math.max(1, Math.min(20, Math.round(Number(max)) || 8))
  if (candidates.length <= cap) return candidates
  const picked = []
  for (let i = 0; i < cap; i += 1) {
    picked.push(candidates[Math.round((i * (candidates.length - 1)) / Math.max(1, cap - 1))])
  }
  return [...new Map(picked.map((entry) => [entry.index, entry])).values()]
}

/**
 * Download the sprite pages and crop the selected tiles into individual JPEGs.
 * @returns {Promise<{time:number,path:string,bytes:number}[]>}
 */
export async function materializeShots({ ff, shots, picks, cacheDir, outDir, signal, quality = 3 } = {}) {
  await mkdir(outDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  const xLen = Math.max(1, Math.floor(Number(shots.xLen) || 10))
  const yLen = Math.max(1, Math.floor(Number(shots.yLen) || 10))
  const xSize = Math.max(1, Math.floor(Number(shots.xSize) || 480))
  const ySize = Math.max(1, Math.floor(Number(shots.ySize) || 270))
  const tilesPerPage = xLen * yLen
  const frames = []
  const pageCache = new Map()

  const fetchStrip = async (safeUrl, stripFile) => {
    await downloadToFile(safeUrl, stripFile, {
      signal,
      timeoutMs: 60_000,
      maxBytes: MAX_STRIP_BYTES,
      minBytes: 1_024,
      headers: { 'user-agent': UA, referer: REFERER, origin: 'https://www.bilibili.com' },
      validateUrl: (value) => assertShotCdnUrl(value, 'videoshot redirect'),
    })
    await assertJpegStrip(stripFile)
  }

  for (const pick of picks) {
    const page = Math.floor(pick.index / tilesPerPage)
    const tile = pick.index % tilesPerPage
    const col = tile % xLen
    const row = Math.floor(tile / xLen)
    const rawUrl = shots.images[page]
    if (!rawUrl) continue
    let stripFile = pageCache.get(page)
    if (!stripFile) {
      const safeUrl = assertShotCdnUrl(rawUrl, 'videoshot sprite')
      stripFile = join(cacheDir, spriteStripName(safeUrl, page))
      try {
        await assertJpegStrip(stripFile)
      } catch {
        await unlink(stripFile).catch(() => {})
        await fetchStrip(safeUrl, stripFile)
      }
      pageCache.set(page, stripFile)
    }
    const outFile = join(outDir, `shot-${String(pick.index + 1).padStart(3, '0')}-${pick.time.toFixed(2).replace('.', '_')}s.jpg`)
    await run(
      ff.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', stripFile,
        '-vf', `crop=${xSize}:${ySize}:${col * xSize}:${row * ySize}`,
        '-frames:v', '1', '-q:v', String(quality), outFile,
      ],
      { signal, timeoutMs: 60_000 },
    )
    const info = await stat(outFile)
    frames.push({ time: pick.time, path: outFile, bytes: info.size })
  }
  return frames
}

/** Read a buffer helper used by tests. */
export async function readShotBytes(file) {
  return readFile(file)
}
