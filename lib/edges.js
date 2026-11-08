/**
 * Head/tail black-edge detection. Many videos open or close on a black (or
 * near-black) frame, sometimes for several seconds; sampling them wastes frame
 * slots and tokens, and a black frame near the end also confuses "what happens
 * last". ffmpeg's blackdetect filter reports those intervals cheaply, so we
 * analyse only the first/last few seconds instead of decoding the whole video.
 */
import { stat } from 'node:fs/promises'

import { run } from './ffmpeg.js'

const BLACK_LINE = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g
/** Identical media+options within this window reuse the previous detection. */
const EDGE_CACHE_TTL_MS = 5 * 60_000
const edgeCache = new Map()

async function edgeCacheKey(file, options) {
  try {
    const info = await stat(file)
    if (!info.isFile()) return null
    return [
      file,
      info.size,
      Math.round(info.mtimeMs),
      Math.round(Number(options.durationSec) * 1000),
      options.headSeconds,
      options.tailSeconds,
      options.pixThreshold,
      options.minDurationSec,
    ].join('|')
  } catch {
    return null
  }
}

/**
 * Extract black intervals from ffmpeg's blackdetect stderr.
 * @param {string} stderr
 * @returns {{start:number,end:number,duration:number}[]}
 */
export function parseBlackIntervals(stderr) {
  const text = String(stderr ?? '')
  const intervals = []
  BLACK_LINE.lastIndex = 0
  let match = BLACK_LINE.exec(text)
  while (match) {
    const start = Number(match[1])
    const end = Number(match[2])
    const duration = Number(match[3])
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      intervals.push({ start, end, duration: Number.isFinite(duration) ? duration : end - start })
    }
    match = BLACK_LINE.exec(text)
  }
  return intervals
}

async function blackIntervals(ff, file, { start, seconds, signal, pixThreshold, minDurationSec, timeoutMs }) {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-ss',
    String(Math.max(0, start)),
    '-t',
    String(Math.max(0.2, seconds)),
    '-i',
    file,
    '-vf',
    `blackdetect=d=${minDurationSec}:pix_th=${pixThreshold}`,
    '-an',
    '-sn',
    '-dn',
    '-f',
    'null',
    '-',
  ]
  const result = await run(ff.ffmpeg, args, { signal, timeoutMs, allowNonZero: true })
  return parseBlackIntervals(result.stderr)
}

/**
 * Detect black edges at the head and the tail of a video.
 *
 * @param {{ffmpeg:string}} ff - resolveFfmpeg() result.
 * @param {string} file - local media file.
 * @param {{signal?:AbortSignal, durationSec:number, headSeconds?:number, tailSeconds?:number,
 *   pixThreshold?:number, minDurationSec?:number, timeoutMs?:number}} options
 * @returns {Promise<{contentStart:number, contentEnd:number, headBlackSec:number, tailBlackSec:number,
 *   headSeconds:number, tailSeconds:number, notes:string[]}>}
 */
export async function detectBlackEdges(
  ff,
  file,
  {
    signal,
    durationSec,
    headSeconds = 3,
    tailSeconds = 3,
    pixThreshold = 0.1,
    minDurationSec = 0.05,
    timeoutMs = 30_000,
  } = {},
) {
  const duration = Number(durationSec)
  const notes = []
  const result = {
    contentStart: 0,
    contentEnd: Number.isFinite(duration) ? duration : 0,
    headBlackSec: 0,
    tailBlackSec: 0,
    headSeconds: 0,
    tailSeconds: 0,
    notes,
  }
  if (!ff?.ffmpeg || !file || !Number.isFinite(duration) || duration <= 0) {
    notes.push('edge analysis skipped: no usable media duration')
    return result
  }
  const headWindow = Math.max(0.5, Math.min(headSeconds, duration))
  const tailWindow = Math.max(0.5, Math.min(tailSeconds, duration))
  if (duration < headWindow + tailWindow) {
    notes.push('video is shorter than the head + tail analysis windows; the windows overlap')
  }
  const cacheKey = await edgeCacheKey(file, { durationSec, headSeconds, tailSeconds, pixThreshold, minDurationSec })
  if (cacheKey) {
    const cached = edgeCache.get(cacheKey)
    if (cached && Date.now() - cached.at < EDGE_CACHE_TTL_MS) return structuredClone(cached.value)
  }
  const common = { signal, pixThreshold, minDurationSec, timeoutMs }

  const head = await blackIntervals(ff, file, { start: 0, seconds: headWindow, ...common })
  const headBlack = head.filter((interval) => interval.start <= 0.2)
  if (headBlack.length) {
    const end = Math.max(...headBlack.map((interval) => interval.end))
    result.headBlackSec = Number(end.toFixed(3))
    if (end >= headWindow - 0.25) {
      // The whole head window is black; do not trim past it blindly.
      notes.push(`the first ${headWindow.toFixed(1)}s are black; the opening content may start later`)
    } else {
      result.contentStart = Number(end.toFixed(3))
    }
  }

  const tailStart = Math.max(0, duration - tailWindow)
  const tail = await blackIntervals(ff, file, { start: tailStart, seconds: tailWindow, ...common })
  const tailBlack = tail
    .map((interval) => ({ start: interval.start + tailStart, end: interval.end + tailStart }))
    .filter((interval) => interval.end >= duration - 0.25)
  if (tailBlack.length) {
    const start = Math.min(...tailBlack.map((interval) => interval.start))
    result.tailBlackSec = Number((duration - start).toFixed(3))
    if (start <= tailStart + 0.25) {
      notes.push(`the last ${tailWindow.toFixed(1)}s are black; the closing content may end earlier`)
    } else {
      result.contentEnd = Number(start.toFixed(3))
    }
  }

  if (result.contentEnd - result.contentStart < 0.5) {
    notes.push('black-edge analysis left no usable range; keeping the full duration')
    result.contentStart = 0
    result.contentEnd = Number(duration.toFixed(3))
  }
  if (cacheKey) edgeCache.set(cacheKey, { at: Date.now(), value: structuredClone(result) })
  return result
}
