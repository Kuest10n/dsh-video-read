/**
 * Bilibili danmaku (comment overlay) timeline evidence.
 * Danmaku are DOM-like comments posted at a playback time; they often describe
 * what is on screen when speech does not, so they are useful text evidence for
 * models that cannot see video.
 */
import { fetchWithDeadline, readTextCapped } from './net.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const MAX_BYTES = 8 * 1024 * 1024
const MAX_LINES = 20_000

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code) => {
    if (code[0] === '#') {
      const numeric = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : match
    }
    return ENTITIES[code] ?? match
  })
}

/**
 * Parse a Bilibili danmaku XML document (`<d p="time,mode,...">text</d>`).
 * @param {string} xml
 * @returns {{count:number,total:number,lines:{time:number,mode:number,text:string}[],note:string|null}}
 */
export function parseDanmakuXml(xml) {
  const lines = []
  const pattern = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g
  let match
  let total = 0
  while ((match = pattern.exec(String(xml ?? '')))) {
    total += 1
    if (lines.length >= MAX_LINES) continue
    const parts = match[1].split(',')
    const time = Number(parts[0])
    if (!Number.isFinite(time) || time < 0) continue
    const mode = Number(parts[1]) || 1
    const content = decodeEntities(match[2]).replace(/\s+/g, ' ').trim()
    if (!content) continue
    lines.push({ time: Number(time.toFixed(3)), mode, text: content })
  }
  lines.sort((left, right) => left.time - right.time)
  return {
    count: lines.length,
    total,
    lines,
    note: total > lines.length ? `only the first ${MAX_LINES} danmaku entries were parsed` : null,
  }
}

/**
 * Download and parse the danmaku timeline of one Bilibili part.
 * @param {{cid?:number|string,signal?:AbortSignal,timeoutMs?:number}} options
 */
export async function fetchDanmaku({ cid, signal, timeoutMs = 20_000 } = {}) {
  if (!cid) return { count: 0, total: 0, lines: [], note: 'this source has no Bilibili cid, so danmaku is unavailable' }
  const response = await fetchWithDeadline(`https://comment.bilibili.com/${cid}.xml`, {
    signal,
    timeoutMs,
    headers: { 'user-agent': UA, referer: REFERER },
  })
  if (!response.ok) throw new Error(`danmaku request failed: HTTP ${response.status}`)
  const xml = await readTextCapped(response, { maxBytes: MAX_BYTES, signal })
  return parseDanmakuXml(xml)
}

/** Format one danmaku line for text evidence. */
export function formatDanmakuLine(line) {
  return `${line.text}`
}
