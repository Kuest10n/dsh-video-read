/**
 * Long-video text digest (path C2): compress a video's subtitle + danmaku
 * timeline into time-segmented text evidence that a text-only model can scan.
 */
import { formatClock } from './frames.js'

/**
 * Build fixed-length time segments with the subtitle and danmaku lines inside.
 * @param {object} options
 * @param {{from:number,to:number,text:string}[]} options.cues
 * @param {{time:number,text:string}[]} options.danmaku
 */
export function buildSegments({
  cues = [],
  danmaku = [],
  startSec = 0,
  endSec,
  segmentSeconds = 120,
  maxSegments = 12,
  maxCuesPerSegment = 40,
  maxDanmakuPerSegment = 8,
} = {}) {
  const start = Math.max(0, Number(startSec) || 0)
  const endValue = Number(endSec)
  const span = Math.max(0.1, (Number.isFinite(endValue) && endValue > start ? endValue : start + 1) - start)
  const cap = Math.max(1, Math.min(50, Math.round(Number(maxSegments)) || 12))
  let segmentLength = Math.max(10, Number(segmentSeconds) || 120)
  if (span / segmentLength > cap) segmentLength = span / cap
  const count = Math.min(cap, Math.max(1, Math.ceil(span / segmentLength)))

  const safeCues = cues.filter((cue) => Number.isFinite(Number(cue.from)))
  const safeDanmaku = danmaku.filter((line) => Number.isFinite(Number(line.time)))
  const segments = []
  for (let i = 0; i < count; i += 1) {
    const segStart = start + i * segmentLength
    const segEnd = i === count - 1 ? start + span : segStart + segmentLength
    const inside = (time) => time >= segStart - 0.05 && time < segEnd
    const segCuesAll = safeCues.filter((cue) => inside(Number(cue.from)))
    const segCues = segCuesAll.slice(0, maxCuesPerSegment)
    const segDanmaku = safeDanmaku.filter((line) => inside(Number(line.time)))

    const seen = new Set()
    const picked = []
    for (const line of segDanmaku) {
      if (picked.length >= maxDanmakuPerSegment) break
      const key = line.text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      picked.push(line)
    }

    const lines = []
    for (const cue of segCues) {
      const content = String(cue.text ?? '').trim()
      if (content) lines.push(`${formatClock(Number(cue.from))} ${content}`)
    }
    for (const line of picked) lines.push(`${formatClock(Number(line.time))} [danmaku] ${line.text}`)

    segments.push({
      index: i + 1,
      start: Number(segStart.toFixed(2)),
      end: Number(segEnd.toFixed(2)),
      startLabel: formatClock(segStart),
      endLabel: formatClock(segEnd),
      cueCount: segCuesAll.length,
      shownCueCount: segCues.length,
      danmakuCount: segDanmaku.length,
      shownDanmakuCount: picked.length,
      omittedCues: Math.max(0, segCuesAll.length - segCues.length),
      omittedDanmaku: Math.max(0, segDanmaku.length - picked.length),
      lines,
    })
  }
  return {
    segments,
    segmentSeconds: Number(segmentLength.toFixed(1)),
    totalCues: safeCues.length,
    totalDanmaku: safeDanmaku.length,
    coveredUntilSec: Number((start + span).toFixed(2)),
  }
}

/** Render a digest as plain text (used by the tool result and by video_ask). */
export function renderDigestText(value) {
  const header = [
    `Video: ${value.source.title}`,
    `Duration: ${value.source.durationLabel} · segments: ${value.segments.length} x ~${value.segmentSeconds}s`,
    `Evidence: ${value.totalCues} subtitle cue(s), ${value.totalDanmaku} danmaku line(s) · time range covered through ${formatClock(value.coveredUntilSec || 0)}`,
  ]
  if (!value.totalCues) header.push('No subtitle text is available. This is a timeline-only result; use video_frames or video_shots to read the actual visuals, or add a sidecar subtitle file.')
  if (value.evidenceNote) header.push(`Evidence coverage: ${value.evidenceNote}`)
  if (value.notes?.length) header.push(`Notes: ${value.notes.join(' | ')}`)
  const body = value.segments.map((segment) => {
    const lines = segment.lines.length ? segment.lines.join('\n') : '(no subtitle or danmaku in this segment; visual evidence requires frame sampling)'
    return `[${segment.startLabel}-${segment.endLabel}] subtitles ${segment.shownCueCount}/${segment.cueCount} shown · danmaku ${segment.shownDanmakuCount || 0}/${segment.danmakuCount} shown\n${lines}`
  })
  return `${header.join('\n')}\n\n${body.join('\n\n')}`
}
