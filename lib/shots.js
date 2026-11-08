/**
 * Bilibili "videoshot" keyframe sprites: the platform already publishes a
 * 10x10 tile strip of keyframes plus their timestamps. Cropping one tile is far
 * cheaper than decoding the video, so this yields keyframe screenshots for long
 * videos without a full download.
 */
import { join } from 'node:path'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { downloadToFile, fetchWithDeadline, readTextCapped } from './net.js'
import { run } from './ffmpeg.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_STRIP_BYTES = 40 * 1024 * 1024

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
  })
  if (!response.ok) throw new Error(`videoshot request failed: HTTP ${response.status}`)
  const payload = JSON.parse(await readTextCapped(response, { maxBytes: MAX_JSON_BYTES, signal }))
  if (payload.code !== 0) throw new Error(`videoshot API error ${payload.code}: ${payload.message ?? 'unknown error'}`)
  const data = payload.data ?? {}
  const images = (Array.isArray(data.image) ? data.image : []).map((entry) =>
    String(entry).startsWith('//') ? `https:${entry}` : String(entry),
  )
  const times = Array.isArray(data.index) ? data.index.map(Number).filter((value) => Number.isFinite(value)) : []
  return {
    images,
    xLen: Number(data.img_x_len) || 10,
    yLen: Number(data.img_y_len) || 10,
    xSize: Number(data.img_x_size) || 480,
    ySize: Number(data.img_y_size) || 270,
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
  const tilesPerPage = shots.xLen * shots.yLen
  const frames = []
  const pageCache = new Map()
  for (const pick of picks) {
    const page = Math.floor(pick.index / tilesPerPage)
    const tile = pick.index % tilesPerPage
    const col = tile % shots.xLen
    const row = Math.floor(tile / shots.xLen)
    const imageUrl = shots.images[page]
    if (!imageUrl) continue
    let stripFile = pageCache.get(page)
    if (!stripFile) {
      stripFile = join(cacheDir, `videoshot-page-${page}.jpg`)
      try {
        await stat(stripFile)
      } catch {
        await downloadToFile(imageUrl, stripFile, { signal, timeoutMs: 60_000, maxBytes: MAX_STRIP_BYTES })
      }
      pageCache.set(page, stripFile)
    }
    const outFile = join(outDir, `shot-${String(pick.index + 1).padStart(3, '0')}-${pick.time.toFixed(2).replace('.', '_')}s.jpg`)
    await run(
      ff.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', stripFile,
        '-vf', `crop=${shots.xSize}:${shots.ySize}:${col * shots.xSize}:${row * shots.ySize}`,
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
