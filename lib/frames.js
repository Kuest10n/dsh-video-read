/**
 * Frame-sampling planning, subtitle parsing and timeline formatting helpers.
 * Pure functions only: no filesystem or network access.
 */

/** Legacy list exposed to the agent as illustrative frame-rate choices. */
export const FPS_CHOICES = [1, 2, 5, 12, 15, 24, 30, 60]

/**
 * Format seconds as `mm:ss.s` / `h:mm:ss.s`. Rounds to tenths first so values
 * like 59.96 render as `01:00.0`, never `00:60.0`.
 */
export function formatClock(seconds) {
  const value = Math.max(0, Math.round((Number(seconds) || 0) * 10) / 10)
  const tenths = Math.round(value * 10)
  const hours = Math.floor(tenths / 36_000)
  const minutes = Math.floor((tenths % 36_000) / 600)
  const secText = ((tenths % 600) / 10).toFixed(1).padStart(4, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${secText}`
  return `${String(minutes).padStart(2, '0')}:${secText}`
}

/**
 * Clamp a requested range into the media. Every coercion is reported in
 * `notes` so the model never believes an out-of-range request was honoured.
 * @returns {{start:number, end:number, notes:string[]}}
 */
export function clampRange(durationSec, start, end) {
  const notes = []
  const duration = Number(durationSec) || 0
  // The last decodable timestamp is slightly before EOF: seeking exactly to the
  // duration makes ffmpeg return no frame, so keep the range inside the media.
  const lastSafe = duration > 0.2 ? Number((duration - 0.05).toFixed(3)) : Number(duration.toFixed(3))
  const rawStart = start === undefined || start === null ? null : Number(start)
  const rawEnd = end === undefined || end === null ? null : Number(end)
  // Normalize and clamp BOTH endpoints before comparing them. Otherwise an
  // out-of-range end (e.g. -10) looks like a "swapped" range and the notes
  // describe values that never became the returned start/end.
  let from
  if (rawStart === null || !Number.isFinite(rawStart)) {
    from = 0
    if (rawStart !== null) notes.push(`start ${String(start)} is not a number; used 0`)
  } else {
    from = Math.min(lastSafe, Math.max(0, rawStart))
    if (rawStart < 0) notes.push(`start ${rawStart}s is negative; used 0`)
    else if (rawStart > lastSafe) notes.push(`start ${rawStart}s is past the ${duration.toFixed(2)}s media; used ${lastSafe}s`)
  }
  let to
  if (rawEnd === null || !Number.isFinite(rawEnd)) {
    to = lastSafe
    if (rawEnd !== null) notes.push(`end ${String(end)} is not a number; used the media end`)
  } else if (rawEnd <= 0 || rawEnd > duration + 0.5) {
    to = lastSafe
    notes.push(`end ${rawEnd}s is outside the ${duration.toFixed(2)}s media; used ${lastSafe}s`)
  } else {
    to = Math.min(lastSafe, rawEnd)
  }
  if (from > to) {
    notes.push(`start ${from}s is after end ${to}s; swapped them`)
    const swap = from
    from = to
    to = swap
  }
  if (from >= to) {
    notes.push(`empty range (${from}s..${to}s); widened to 1s before the end`)
    from = Math.max(0, Number((to - 1).toFixed(3)))
    if (from >= to) {
      from = 0
      to = lastSafe
    }
  }
  return { start: Number(from.toFixed(3)), end: Number(to.toFixed(3)), notes }
}

function toTenth(value) {
  return Math.round(Number(value) * 1000) / 1000
}

function dedupe(times, minGap = 0.2) {
  const sorted = [...times].filter((time) => Number.isFinite(time) && time >= 0).sort((a, b) => a - b)
  const result = []
  for (const time of sorted) {
    if (!result.length || time - result[result.length - 1] >= minGap) result.push(toTenth(time))
  }
  return result
}

function thinTo(times, maxFrames) {
  if (times.length <= maxFrames) return times
  const picked = []
  for (let i = 0; i < maxFrames; i += 1) {
    picked.push(times[Math.round((i * (times.length - 1)) / Math.max(1, maxFrames - 1))])
  }
  return [...new Set(picked)].sort((a, b) => a - b)
}

/**
 * Decide which timestamps to capture.
 * @returns {{times:number[], mode:string, notes:string[]}}
 */
export function planSampleTimes(options) {
  const {
    durationSec,
    range,
    mode = 'even',
    fps = 1,
    maxFrames = 16,
    requestedTimes = null,
    sceneTimes = null,
  } = options
  const notes = []
  const clamped = clampRange(durationSec, range?.start, range?.end)
  notes.push(...clamped.notes)
  const { start, end } = clamped
  const span = Math.max(0.1, end - start)
  const cap = Math.max(1, Math.min(32, Math.round(maxFrames) || 16))

  if (mode === 'times') {
    const raw = Array.isArray(requestedTimes) ? requestedTimes : []
    if (!raw.length) throw new Error('mode="times" requires a non-empty times array')
    const wanted = []
    let dropped = 0
    for (const item of raw) {
      const time = Number(item)
      if (!Number.isFinite(time) || time < 0) {
        dropped += 1
        continue
      }
      wanted.push(time)
    }
    if (dropped) notes.push(`dropped ${dropped} non-numeric or negative times entr${dropped === 1 ? 'y' : 'ies'}`)
    if (!wanted.length) throw new Error('mode="times" received no usable timestamps')
    let outside = 0
    let clampedTimes = wanted.map((time) => {
      const bounded = Math.min(end, Math.max(start, time))
      if (Math.abs(bounded - time) > 0.001) outside += 1
      return bounded
    })
    if (outside) notes.push(`clamped ${outside} requested time(s) into the sampled range ${formatClock(start)}-${formatClock(end)}`)
    const beforeDedupe = clampedTimes.length
    clampedTimes = dedupe(clampedTimes)
    if (clampedTimes.length < beforeDedupe) {
      notes.push(`merged ${beforeDedupe - clampedTimes.length} timestamp(s) closer than 0.2s`)
    }
    if (clampedTimes.length > cap) {
      clampedTimes = thinTo(clampedTimes, cap)
      notes.push(`requested ${wanted.length} timestamps, thinned to ${clampedTimes.length} (max_frames=${cap})`)
    }
    return { times: clampedTimes, mode: 'times', notes }
  }
  if (mode === 'scene') {
    const rawScenes = Array.isArray(sceneTimes) ? sceneTimes : []
    const scenes = dedupe(rawScenes.filter((time) => time >= start && time <= end))
    if (rawScenes.length && !scenes.length) {
      notes.push('scene detection returned candidates outside the sampled range')
    }
    if (scenes.length >= 2) {
      const times = thinTo(scenes, cap)
      if (times.length !== scenes.length) notes.push(`detected ${scenes.length} scene changes, thinned to ${times.length}`)
      return { times, mode: 'scene', notes }
    }
    notes.push('scene detection found fewer than two scene changes; fell back to even sampling')
  }

  const requestedFps = Math.min(60, Math.max(0.05, Number(fps) || 1))
  // Exclude the last ~1.4s of the video from the even grid (rather than moving
  // one already-generated sample afterwards) so every timestamp label matches
  // the frame that is actually extracted.
  const evenEnd =
    durationSec > 1.4 && end > durationSec - 1.4 ? Math.max(start, durationSec - 1.4) : end
  if (evenEnd !== end) notes.push('sampled 1.4s before the end to avoid a black end frame')
  const evenSpan = Math.max(0.1, evenEnd - start)
  const ideal = Math.max(1, Math.round(evenSpan * requestedFps))
  const count = Math.max(1, Math.min(cap, ideal))
  if (ideal > cap) {
    notes.push(
      `${requestedFps}fps over ${evenSpan.toFixed(1)}s would need ${ideal} frames; capped at ${cap}. ` +
        'Use mode="times" or a shorter range for targeted frames.',
    )
  }
  if (count === 1) return { times: [toTenth(start + evenSpan / 2)], mode: 'even', notes }
  const step = evenSpan / (count - 1)
  const times = Array.from({ length: count }, (_, index) => toTenth(start + index * step))
  return { times: dedupe(times), mode: 'even', notes }
}

function parseTimestamp(text) {
  const match = String(text).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/)
  if (!match) return null
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const millis = Number((match[4] ?? '0').padEnd(3, '0'))
  return hours * 3600 + minutes * 60 + seconds + millis / 1000
}

// ASS/SSA Dialogue times are `h:mm:ss.cc`: the fractional field counts
// centiseconds (1cc = 10ms), so `.1` is 10ms and `.50` is 500ms. Reusing
// parseTimestamp() would pad the field to three digits and treat it as
// milliseconds, turning a one-digit `.1` into 100ms and `.5` into 500ms.
// Two-digit fields happen to come out the same; one-digit ones do not.
function parseAssTimestamp(text) {
  const found = String(text).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,2}))?$/)
  if (!found) return null
  const hours = Number(found[1] ?? 0)
  const minutes = Number(found[2])
  const seconds = Number(found[3])
  const centiseconds = Number(found[4] ?? '0')
  return hours * 3600 + minutes * 60 + seconds + centiseconds / 100
}

export function cleanCueText(text) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse SRT / WebVTT without relying on blank lines between cues: every
 * timestamp line starts a cue, and its body runs until the next timestamp line.
 */
export function parseSrtOrVtt(text) {
  const normalized = String(text).replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const cues = []
  let current = null
  // Small WebVTT state machine: skip the WEBVTT header block and every
  // NOTE/STYLE/REGION metadata block until its terminating blank line. Those
  // blocks may contain `-->` lines which must never become fake cues. A real
  // cue timestamp line immediately after the signature (a non-standard file
  // with no blank line) still starts the first cue. SRT has no metadata blocks,
  // so it goes straight to cue parsing.
  const cueTimestampStart = /^\s*(?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->/
  let skippedBlock = null
  const flush = () => {
    if (current && current.body.length) {
      const body = cleanCueText(current.body.join(' '))
      if (body && current.from !== null) cues.push({ from: current.from, to: current.to ?? current.from + 2, text: body })
    }
    current = null
  }
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      if (skippedBlock) skippedBlock = null
      else flush()
      continue
    }
    if (skippedBlock === 'metadata') continue
    if (skippedBlock === 'header') {
      // A metadata block may follow the signature without an intervening blank
      // line; enter metadata mode so its `-->` lines are skipped too.
      if (/^(NOTE|STYLE|REGION)\b/i.test(line)) {
        flush()
        skippedBlock = 'metadata'
        continue
      }
      // Tolerate a real first cue directly after the signature (a non-standard
      // file with no blank line); anything else is still header text.
      if (!cueTimestampStart.test(line)) continue
      skippedBlock = null
    }
    if (!current && /^WEBVTT(?:\s|$)/i.test(line)) {
      skippedBlock = 'header'
      continue
    }
    if (!current && /^(NOTE|STYLE|REGION)\b/i.test(line)) {
      flush()
      skippedBlock = 'metadata'
      continue
    }
    if (line.includes('-->')) {
      flush()
      const [fromText, toText] = line.split('-->')
      current = { from: parseTimestamp(fromText), to: parseTimestamp(toText), body: [] }
      continue
    }
    if (/^\d+$/.test(line) && (!current || !current.body.length)) continue
    if (current) current.body.push(line)
  }
  flush()
  return cues.filter((cue) => cue.text && Number.isFinite(cue.from)).sort((a, b) => a.from - b.from)
}

/** Parse the Dialogue lines of an ASS/SSA subtitle file into cues. */
export function parseAss(text) {
  const cues = []
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.match(/^\s*Dialogue:\s*([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/)
    if (!parts) continue
    const from = parseAssTimestamp(parts[2])
    const to = parseAssTimestamp(parts[3])
    const body = cleanCueText(parts[10].replace(/\\N/gi, ' '))
    if (from !== null && body) cues.push({ from, to: to ?? from + 2, text: body })
  }
  return cues.filter((cue) => cue.text).sort((a, b) => a.from - b.from)
}

/** Find the subtitle cue covering (or nearest to) a frame time. */
export function nearestCue(cues, time, lookahead = 1.5) {
  if (!Array.isArray(cues) || !cues.length) return null
  // Prefer the cue that actually covers the frame: a long line that started
  // much earlier still owns the frame while it is on screen, even if a later
  // cue started closer to it.
  let covering = null
  let nearest = null
  let nearestDistance = Infinity
  for (const cue of cues) {
    const covers = time >= cue.from && time <= cue.to
    if (covers) {
      if (!covering || cue.from >= covering.from) covering = cue
      continue
    }
    if (time >= cue.from - 0.5 && time <= cue.to + lookahead) {
      const distance = Math.abs(time - cue.from)
      if (distance < nearestDistance) {
        nearest = cue
        nearestDistance = distance
      }
    }
  }
  return covering ?? nearest
}

/**
 * Format cues as compact `[mm:ss] text` lines. Coverage is preserved: when the
 * corpus is too large for the count/char budget, the stride is increased until
 * the selected lines fit, so the timeline always reaches the end of the video
 * instead of silently dropping the tail.
 * @returns {{lines:string[], truncated:boolean, total:number, stride:number, coversUntil:number}}
 */
export function formatTimeline(cues, options = {}) {
  const { maxCues = 300, maxChars = 24_000, prefix = true } = options
  if (!Array.isArray(cues) || !cues.length) {
    return { lines: [], truncated: false, total: 0, stride: 1, coversUntil: 0 }
  }
  const total = cues.length
  const full = prefix ? cues.map((cue) => `${formatClock(cue.from)} ${cue.text}`) : cues.map((cue) => cue.text)
  const fullChars = full.reduce((sum, line) => sum + line.length + 1, 0)
  // Grow the stride until both the cue-count and the character budget fit.
  let stride = Math.max(1, Math.ceil(total / Math.max(1, maxCues)))
  let selected = []
  for (let guard = 0; guard < 64; guard += 1) {
    selected = []
    for (let index = 0; index < total; index += stride) selected.push(index)
    if (selected[selected.length - 1] !== total - 1) selected.push(total - 1)
    const lines = selected.map((index) => full[index])
    const chars = lines.reduce((sum, line) => sum + line.length + 1, 0)
    if (chars <= maxChars && lines.length <= Math.max(1, maxCues)) {
      return {
        lines,
        truncated: stride > 1,
        total,
        stride,
        coversUntil: Math.max(cues[total - 1].from, cues[total - 1].to ?? cues[total - 1].from),
      }
    }
    stride += 1
  }
  // Extreme fallback: report coverage honestly instead of lying about it.
  return {
    lines: [full[0]],
    truncated: true,
    total,
    stride,
    coversUntil: Math.max(cues[total - 1].from, cues[total - 1].to ?? cues[total - 1].from),
    droppedByBudget: true,
    fullChars,
  }
}

/** Build a compact frame footnote describing its subtitle context. */
export function frameCaption(cue) {
  if (!cue) return ''
  const text = cue.text.length > 140 ? `${cue.text.slice(0, 139)}…` : cue.text
  return ` | subtitle: ${text}`
}
