/**
 * dsh-video-read — host-level bundle that gives every DSH agent the ability to
 * "read" a video: acquire media (Bilibili / local file), sample frames at a
 * chosen rate, pair them with timeline subtitles, and return image evidence.
 *
 * Host plugin (not a preset plugin), so it registers plain tools and is visible
 * to every agent preset. The image path requires a routed model that declares
 * image input; text-only models get a metadata/subtitle fallback instead.
 */
import { basename, join } from 'node:path'
import { readFile, readdir, rm, stat as fsStat, unlink } from 'node:fs/promises'
import { cpus } from 'node:os'

import { persistJson, resolveSource } from './lib/sources.js'
import { extractEven, extractFrames, extractScene, resolveFfmpeg } from './lib/ffmpeg.js'
import { rankEvidence } from './lib/ask.js'
import { captionFrames } from './lib/caption.js'
import { fetchDanmaku } from './lib/danmaku.js'
import { buildSegments, renderDigestText } from './lib/digest.js'
import { fetchVideoShots, materializeShots, pickShotIndices } from './lib/shots.js'
import { buildStoryboard, renderStoryboardText } from './lib/storyboard.js'
import { buildGrid } from './lib/grid.js'
import { detectBlackEdges } from './lib/edges.js'
import { cacheStatus, pruneCache } from './lib/cache.js'
import { finishRun, readSettings, startRun, updateRun } from './lib/progress.js'
import { mountPanel } from './lib/panel.js'
import {
  clampRange,
  formatClock,
  formatTimeline,
  frameCaption,
  nearestCue,
  planSampleTimes,
} from './lib/frames.js'

export const name = 'dsh-video-read'
export const inject = ['tools', 'fs', 'attachments', 'workingDirectory']

const DEFAULT_CONFIG = {
  autoDownloadFfmpeg: true,
  autoDownloadYtdlp: true,
  ffmpegPath: '',
  cacheDir: '',
  cookieFile: '',
  quality: 3,
  // Bilibili qn (16=360p, 32=480p, 64=720p); separate from JPEG qscale above.
  bilibiliQuality: 64,
  maxFrames: 16,
  imageWidth: 1280,
  sceneThreshold: 0.3,
  maxTimelineCues: 300,
  keepSource: true,
  // Safety / performance budgets.
  maxAttachImages: 20,
  frameConcurrency: 0,
  maxVideoMinutes: 180,
  maxMediaBytes: 1_200_000_000,
  cacheTtlDays: 14,
  pruneArtifacts: true,
  // M1.5 / M2: text evidence, captions and keyframe sprites.
  digestSegmentSeconds: 120,
  maxDigestSegments: 12,
  maxShots: 8,
  captionProvider: '',
  captionModel: '',
  captionMaxTokens: 400,
  maxCaptionFrames: 8,
  captionConcurrency: 3,
  ytdlpPath: '',
  // Contact sheet ("grid") mode: one image for the whole sample.
  gridCellWidth: 320,
  gridCellHeight: 240,
  // Edge handling: skip leading/trailing black frames automatically and burn
  // the timestamp onto each contact-sheet cell so story order is unambiguous.
  skipBlackEdges: 'auto',
  trimHead: 0,
  trimTail: 0,
  burnTimestamps: true,
}

const text = (value) => ({ type: 'text', text: value })
const image = (attachment) => ({ type: 'image', attachment })

function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

const MODES = new Set(['even', 'times', 'scene', 'grid'])
const MAX_TIMES = 4096

/**
 * Coerce a tri-state boolean coming from tool args, a persisted settings file,
 * or a bundle patch. A settings file edited by hand can contain the strings
 * "true"/"false"; those must not be treated as truthy by accident.
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function flag(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return fallback
}

/**
 * Validate and normalize tool arguments before any IO (download, ffmpeg, disk).
 * Rejects impossible modes and bounds numeric inputs so a hostile or confused
 * caller cannot trigger unbounded work.
 */
function normalizeParams(raw) {
  const params = { ...(raw ?? {}) }
  const mode = params.mode === undefined ? 'even' : String(params.mode)
  if (!MODES.has(mode)) throw new Error(`mode must be one of "even", "times", "scene" (got "${mode}")`)
  const fpsInput = params.fps === undefined ? 1 : Number(params.fps)
  const fps = Number.isFinite(fpsInput) ? Math.min(60, Math.max(0.05, fpsInput)) : 1
  const maxInput = params.max_frames === undefined ? undefined : Number(params.max_frames)
  const maxFrames = Number.isFinite(maxInput) ? Math.max(1, Math.min(32, Math.round(maxInput))) : undefined
  const startInput = params.start === undefined ? undefined : Number(params.start)
  const endInput = params.end === undefined ? undefined : Number(params.end)
  let times
  if (params.times !== undefined) {
    if (!Array.isArray(params.times)) throw new Error('times must be an array of seconds')
    if (params.times.length > MAX_TIMES) throw new Error(`times has too many entries (max ${MAX_TIMES})`)
    times = params.times
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0)
  }
  return {
    mode,
    fps,
    max_frames: maxFrames,
    start: Number.isFinite(startInput) ? Math.max(0, startInput) : undefined,
    end: Number.isFinite(endInput) ? Math.max(0, endInput) : undefined,
    times,
    include_timeline: params.include_timeline !== false,
    include_danmaku: params.include_danmaku === true,
    captions: ['auto', 'always', 'never'].includes(String(params.captions)) ? String(params.captions) : 'auto',
    skip_black_edges: ['auto', 'always', 'never'].includes(String(params.skip_black_edges))
      ? String(params.skip_black_edges)
      : undefined,
    trim_head: Number.isFinite(Number(params.trim_head)) && Number(params.trim_head) > 0 ? Number(params.trim_head) : undefined,
    trim_tail: Number.isFinite(Number(params.trim_tail)) && Number(params.trim_tail) > 0 ? Number(params.trim_tail) : undefined,
    burn_timestamps: typeof params.burn_timestamps === 'boolean' ? params.burn_timestamps : undefined,
  }
}

/** Frame extraction workers: explicit config wins, otherwise scale to the CPU count. */
function frameConcurrency(cfg) {
  const configured = Number(cfg.frameConcurrency)
  if (Number.isFinite(configured) && configured > 0) return Math.max(1, Math.min(8, Math.round(configured)))
  return Math.max(2, Math.min(5, (cpus()?.length ?? 2) - 1))
}

function sessionCwd(ctx, exec) {
  const session = exec?.agent?.session
  if (session) {
    try {
      const dir = ctx.workingDirectory.get(session)
      if (typeof dir === 'string' && dir) return dir
    } catch {}
  }
  return process.cwd()
}

async function imageRoute(ctx, exec) {
  const session = exec?.agent?.session
  let routed = null
  try {
    routed = session?.requestHeader?.()?.config ?? null
  } catch {}
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  if (!provider || !model) return { capable: false, reason: 'no routed provider/model is attached to this call' }
  try {
    const llm = ctx.get('llm')
    if (!llm?.resolveModelInfo) {
      return { capable: false, reason: 'the llm service is unavailable, so image input cannot be verified' }
    }
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    const declaredInputs = Array.isArray(info?.inputModalities) ? info.inputModalities : []
    const capable = declaredInputs.includes('image')
    return {
      capable,
      provider,
      model,
      declaredInputs,
      videoDeclared: declaredInputs.includes('video'),
      reason: capable ? null : `the routed model ${provider}/${model} does not declare image input`,
    }
  } catch (error) {
    return { capable: false, provider, model, reason: `could not resolve model capabilities: ${error.message}` }
  }
}

function publicSource(meta) {
  return {
    kind: meta.kind,
    input: meta.input,
    title: meta.title,
    durationSec: meta.durationSec,
    durationLabel: formatClock(meta.durationSec),
    width: meta.width ?? null,
    height: meta.height ?? null,
    hasAudio: meta.hasAudio ?? null,
    sizeBytes: meta.sizeBytes ?? null,
    webpageUrl: meta.webpageUrl ?? null,
    bvid: meta.bvid ?? null,
    owner: meta.owner ?? null,
    artifactsDir: meta.artifactsDir,
    mediaFile: meta.filePath ?? null,
  }
}

function baseValue(meta, extra) {
  const cues = Array.isArray(meta.subtitles?.cues) ? meta.subtitles.cues : []
  return {
    ok: true,
    source: publicSource(meta),
    subtitle: {
      source: meta.subtitles?.source ?? (meta.kind === 'bilibili' ? 'bilibili-subtitle-api' : 'sidecar-file'),
      languages: meta.subtitles?.languages ?? [],
      count: cues.length,
      note: meta.subtitles?.note ?? null,
    },
    notes: [...(meta.notes ?? []), ...(extra.notes ?? [])],
    ...(extra.value ?? {}),
  }
}

function originLabel(source) {
  if (source.kind === 'bilibili') return `bilibili ${source.webpageUrl ?? ''}`
  if (source.kind === 'direct') return `direct URL ${source.webpageUrl ?? ''}`
  if (source.kind === 'youtube' || source.kind === 'yt-dlp') return `yt-dlp ${source.webpageUrl ?? ''}`
  if (kindIsLocal(source.kind)) return 'local file'
  return `${source.kind ?? 'unknown'} ${source.webpageUrl ?? ''}`.trim()
}

function kindIsLocal(kind) {
  return kind === 'local' || !kind
}

function summaryText(value) {
  const source = value.source
  const sampling = value.sampling
  const lines = [
    `Video: ${source.title}`,
    `Origin: ${originLabel(source)} · ${source.durationLabel} · ${source.width ?? '?'}x${source.height ?? '?'} · audio=${source.hasAudio === null ? 'unknown' : source.hasAudio}`,
  ]
  if (sampling) {
    lines.push(
      `Sampling: ${sampling.captured} frame(s), mode=${sampling.mode}, requested fps=${sampling.requestedFps ?? 'n/a'}, range=[${formatClock(sampling.range.start)}, ${formatClock(sampling.range.end)}]`,
    )
  }
  lines.push(`Frames on disk: ${value.framesDir ?? value.source.artifactsDir}`)
  lines.push(`Subtitles: ${value.subtitle.count} cue(s)${value.subtitle.languages?.length ? ` (${value.subtitle.languages.join(', ')})` : ''}`)
  if (value.notes?.length) lines.push(`Notes: ${value.notes.join(' | ')}`)
  return lines.join('\n')
}

function frameBlocks(value, options = {}) {
  const blocks = [text(summaryText(value))]
  if (value.textOnlyFallback) {
    blocks.push(
      text(
        `Image input is unavailable (${value.textOnlyFallbackReason}). ` +
          'Frames were captured to disk and the manifest has their paths, but they were not attached here. ' +
          'Answer only from timeline/metadata evidence and tell the user a text-only route cannot visually inspect frames.',
      ),
    )
  }
  const frames = Array.isArray(value.frames) ? value.frames : []
  const grid = value.grid && value.grid.attachment && options.includeImages !== false ? value.grid : null
  if (grid) {
    blocks.push(
      text(
        `Contact sheet: ${grid.cols}x${grid.rows} cells cover ${frames.length} sampled frame(s) in one image ` +
          `(${grid.path}); the index below is row-major, so cell 1 is top-left and cell ${grid.cells} is the last used cell.`,
      ),
    )
  }
  for (const frame of frames) {
    const caption = frame.subtitle ? frameCaption({ text: frame.subtitle }) : ''
    const visual = frame.caption ? ` | caption: ${frame.caption}` : ''
    const problem = frame.error ? ` (capture failed: ${frame.error})` : frame.attachError ? ` (image attach failed: ${frame.attachError})` : ''
    const prefix = grid ? `[cell ${frame.index}/${frames.length}]` : `[frame ${frame.index}/${frames.length}]`
    blocks.push(text(`${prefix} t=${formatClock(frame.time)}${caption}${visual}${problem} · ${frame.path}`))
    if (!grid && frame.attachment && options.includeImages !== false) blocks.push(image(frame.attachment))
  }
  if (grid) blocks.push(image(grid.attachment))
  if (Array.isArray(value.danmaku?.lines) && value.danmaku.lines.length) {
    blocks.push(text(`Danmaku (${value.danmaku.count} line(s)):\n${value.danmaku.lines.join('\n')}`))
  }
  if (Array.isArray(value.timeline?.lines) && value.timeline.lines.length) {
    const timeline = value.timeline
    // Separate "thinned for coverage" from "cut off at the end": the model must
    // know whether later speech exists in the evidence set.
    let label = 'Timeline subtitles'
    if (timeline.truncated) {
      label += ` (thinned x${timeline.stride ?? 1} from ${timeline.total}` +
        `${timeline.coversUntil ? `, covers up to ${formatClock(timeline.coversUntil)}` : ''})`
    }
    blocks.push(text(`${label}:\n${timeline.lines.join('\n')}`))
  }
  return blocks
}

async function attachFrames(ctx, frames, { maxImages = 20, concurrency = 3 } = {}) {
  const attached = new Array(frames.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, frames.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= frames.length) return
      const frame = frames[index]
      if (!frame.path) {
        attached[index] = { ...frame, attachment: null }
        continue
      }
      // Context protection: never attach more images than configured, even if the
      // caller asked for the 32-frame hard maximum.
      if (maxImages > 0 && frame.index > maxImages) {
        attached[index] = { ...frame, attachment: null, skipped: 'image attachment budget reached' }
        continue
      }
      try {
        const data = await readFile(frame.path)
        const ref = await ctx.attachments.saveImage({
          data,
          mediaType: 'image/jpeg',
          name: basename(frame.path),
        })
        attached[index] = { ...frame, attachment: ref }
      } catch (error) {
        attached[index] = { ...frame, attachment: null, attachError: error.message }
      }
    }
  })
  await Promise.all(workers)
  return attached
}

const MAX_RUNS_PER_ARTIFACT = 10

/** Keep only the newest N frame runs per artifact directory. */
async function pruneRuns(framesRoot, keep) {
  try {
    const entries = await readdir(framesRoot, { withFileTypes: true })
    const dirs = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(framesRoot, entry.name)
      try {
        dirs.push({ full, at: (await fsStat(full)).mtimeMs })
      } catch {}
    }
    dirs.sort((a, b) => b.at - a.at)
    for (const stale of dirs.slice(keep)) await rm(stale.full, { recursive: true, force: true })
  } catch {}
}

/**
 * Run one capture and mirror its lifecycle into the run-progress record the Web
 * panel polls (start → phases → finish/error). Progress is best effort: a broken
 * progress file must never fail a tool call, so lib/progress.js swallows writes.
 */
async function capture(options) {
  const progress = startRun({
    cfg: options.cfg,
    source: options.source,
    mode: options.mode ?? options.params?.mode ?? 'even',
    maxFrames: options.maxFrames ?? options.params?.max_frames,
  })
  try {
    const value = await captureInner({ ...options, progress, onEvent: runtimeReporter(progress) })
    finishRun(progress, {
      ok: true,
      frames: value?.sampling?.captured ?? value?.frames?.length ?? 0,
      artifactsDir: value?.artifactsDir ?? null,
    })
    return value
  } catch (error) {
    finishRun(progress, { ok: false, error })
    throw error
  }
}

/** Map runtime bootstrap events (first-use ffmpeg/yt-dlp download) to a phase. */
function runtimeReporter(progress) {
  return (event) => {
    if (event?.type === 'runtime') updateRun(progress, 'runtime', { detail: event.detail ?? null })
  }
}

async function captureInner(options) {
  const { ctx, cfg, exec, source, params } = options
  const cwd = sessionCwd(ctx, exec)
  const notes = []
  const log = () => {}
  const wantsImages = options.includeImages !== false
  // Gate the route BEFORE any download: a text-only model must not wait minutes
  // for image evidence it will never receive.
  const route = await imageRoute(ctx, exec)
  if (!route.capable) notes.push(`no image evidence attached: ${route.reason}`)
  // C1 visual bridge: when the routed model cannot see images but a caption
  // model is configured, frames are captioned for text-only readers.
  const captionsMode = options.captions === undefined ? 'auto' : String(options.captions)
  const captionModelAvailable = Boolean(cfg.captionProvider || cfg.captionModel)
  const wantsCaptions =
    captionsMode === 'always' || (captionsMode === 'auto' && !route.capable && captionModelAvailable)
  if (wantsCaptions && !captionModelAvailable && !route.capable) {
    notes.push('no caption model is configured, so no visual description was produced (set captionModel)')
  }

  updateRun(options.progress, 'downloading')
  const meta = await resolveSource({
    ctx,
    cfg,
    cwd,
    signal: exec?.signal,
    download: true,
    source,
    log,
    onEvent: options.onEvent,
  })
  updateRun(options.progress, 'probing', {
    detail: `${meta.kind}${meta.durationLabel ? ` · ${meta.durationLabel}` : ''}`,
    artifactsDir: meta.artifactsDir ?? null,
    title: meta.title ?? null,
  })
  const ff = meta.ffmpeg ?? (await resolveFfmpeg(cfg, { signal: exec?.signal }))
  if (!ff?.available) {
    const error = new Error(
      `ffmpeg is unavailable, so frame extraction cannot run. ${ff?.note ?? ''} ` +
        'Set the plugin option ffmpegPath, install ffmpeg on PATH, or allow autoDownloadFfmpeg.',
    )
    error.code = 'E_FFMPEG_MISSING'
    throw error
  }
  if (!meta.filePath) throw new Error('media acquisition did not produce a local file')
  if (!meta.durationSec || !Number.isFinite(meta.durationSec)) {
    throw new Error('could not determine the video duration; the media may be corrupt or unsupported')
  }

  const range = clampRange(meta.durationSec, params.start, params.end)
  notes.push(...(range.notes ?? []))
  // Head/tail handling: explicit trim bounds first, then black-edge detection
  // (which analyses only ~3s at each end, never the whole video). `times` mode
  // is explicit by definition and is never auto-trimmed.
  const requestedMode = params.mode ?? 'even'
  const trimHead = Math.max(0, Number(params.trim_head ?? cfg.trimHead) || 0)
  const trimTail = Math.max(0, Number(params.trim_tail ?? cfg.trimTail) || 0)
  if (trimHead > 0) {
    range.start = Math.max(range.start, Math.min(meta.durationSec, trimHead))
    notes.push(`trim_head: sampling starts at ${formatClock(range.start)}`)
  }
  if (trimTail > 0) {
    range.end = Math.min(range.end, Math.max(0, meta.durationSec - trimTail))
    notes.push(`trim_tail: sampling ends at ${formatClock(range.end)}`)
  }
  const skipEdges = params.skip_black_edges ?? cfg.skipBlackEdges ?? 'auto'
  let edges = null
  if (skipEdges !== 'never' && requestedMode !== 'times' && range.end - range.start >= 2) {
    try {
      edges = await detectBlackEdges(ff, meta.filePath, { signal: exec?.signal, durationSec: meta.durationSec })
      const start = Math.max(range.start, edges.contentStart)
      const end = Math.min(range.end, edges.contentEnd)
      if (end - start >= 1 && (start > range.start + 0.2 || end < range.end - 0.2)) {
        notes.push(...edges.notes)
        notes.push(
          `auto-skipped black edges: sampling ${formatClock(start)}–${formatClock(end)}` +
            ` (head black ${edges.headBlackSec}s, tail black ${edges.tailBlackSec}s)`,
        )
        range.start = start
        range.end = end
      } else if (edges.headBlackSec > 0.2 || edges.tailBlackSec > 0.2) {
        notes.push(
          `black edges detected (head ${edges.headBlackSec}s / tail ${edges.tailBlackSec}s) but the requested range was kept`,
        )
      }
    } catch (error) {
      notes.push(`black-edge analysis skipped: ${error.message}`)
    }
  }
  const mode = params.mode ?? 'even'
  const isGrid = mode === 'grid'
  const requestedFps = mode === 'even' ? Number(params.fps ?? 1) : null
  const maxFrames = Math.max(1, Math.min(32, Number(params.max_frames ?? cfg.maxFrames ?? 16) || 16))
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${mode}`
  const framesDir = join(meta.artifactsDir, 'frames', runId)
  const quality = Number(cfg.quality) || 3
  const extractOptions = {
    width: Math.max(320, Math.min(2560, Number(cfg.imageWidth) || 1280)),
    quality,
    concurrency: frameConcurrency(cfg),
    signal: exec?.signal,
  }

  let plan
  let captured
  if (mode === 'scene') {
    // One pass detects the cuts AND saves exactly those frames. Detect a wider
    // candidate set than the caller asked for, then thin it evenly so a long
    // video is represented end-to-end instead of by its first N cuts.
    const candidates = await extractScene(ff, meta.filePath, framesDir, {
      threshold: Number(cfg.sceneThreshold) || 0.3,
      start: range.start,
      end: range.end,
      maxFrames: Math.min(32, maxFrames * 4),
      width: extractOptions.width,
      quality,
      signal: exec?.signal,
    })
    if (!candidates.length) {
      notes.push('no scene change was detected in the requested range; used a frame from the middle of the range instead')
      const middle = Math.round((range.start + (range.end - range.start) / 2) * 10) / 10
      captured = await extractFrames(ff, meta.filePath, [middle], framesDir, extractOptions)
    } else if (candidates.length > maxFrames) {
      const picked = new Set()
      for (let i = 0; i < maxFrames; i += 1) {
        picked.add(Math.round((i * (candidates.length - 1)) / Math.max(1, maxFrames - 1)))
      }
      const kept = [...picked].sort((a, b) => a - b).map((index) => candidates[index])
      for (const frame of candidates) {
        if (!kept.includes(frame) && frame.path) {
          try {
            await unlink(frame.path)
          } catch {}
        }
      }
      notes.push(`scene detection found ${candidates.length} cut(s); kept ${kept.length} spread across the range`)
      captured = kept
    } else {
      notes.push(`scene detection returned ${candidates.length} cut(s) as the frame set`)
      captured = candidates
      // A "single long shot" (a slide deck, a static camera) would otherwise
      // yield one scene covering minutes. Pad the sparse cut list with evenly
      // spaced frames so the storyboard still samples the whole span.
      const span = range.end - range.start
      if (captured.length < 3 && span > 90) {
        const target = Math.min(maxFrames, Math.max(captured.length, Math.ceil(span / 30)))
        const existing = new Set(captured.map((frame) => Math.round(frame.time)))
        const paddedTimes = []
        for (let i = 0; i < target && paddedTimes.length < target - captured.length; i += 1) {
          const time = Math.round((range.start + ((i + 0.5) * span) / target) * 10) / 10
          const rounded = Math.round(time)
          if (existing.has(rounded) || existing.has(rounded - 1) || existing.has(rounded + 1)) continue
          paddedTimes.push(time)
        }
        if (paddedTimes.length) {
          const padded = await extractFrames(ff, meta.filePath, paddedTimes, framesDir, extractOptions)
          const merged = [...captured, ...padded].sort((a, b) => a.time - b.time)
          captured = merged
          notes.push(
            `only ${candidates.length} scene cut(s) in a ${Math.round(span)}s span; padded to ${captured.length} evenly spaced frame(s) so the storyboard covers the whole range`,
          )
        }
      }
    }
    plan = { mode, times: captured.map((frame) => frame.time), notes: [] }
  } else {
    plan = planSampleTimes({
      durationSec: meta.durationSec,
      range,
      mode,
      fps: requestedFps ?? 1,
      maxFrames,
      requestedTimes: params.times,
    })
    notes.push(...plan.notes)
    captured =
      mode === 'times'
        ? await extractFrames(ff, meta.filePath, plan.times, framesDir, extractOptions)
        : await extractEven(ff, meta.filePath, plan.times, framesDir, extractOptions)
  }
  if (!captured.length) throw new Error('no frame could be captured from the requested range')

  const failed = captured.filter((frame) => !frame.path)
  if (failed.length) notes.push(`${failed.length} frame(s) failed to extract`)
  const adjusted = captured.filter((frame) => frame.adjusted)
  if (adjusted.length) {
    notes.push(
      `${adjusted.length} frame(s) were captured slightly earlier than requested because the timestamp sat past the last decodable frame`,
    )
  }
  // Optional disk hygiene: frames + manifest are enough evidence, so the cached
  // Bilibili mezzanine file can be dropped when the user opts out of keepSource.
  if (cfg.keepSource === false && meta.kind === 'bilibili' && meta.filePath) {
    try {
      await unlink(meta.filePath)
      notes.push('cached source video removed (keepSource=false); frames and manifest remain')
    } catch (error) {
      notes.push(`could not remove cached source video: ${error.message}`)
    }
  }

  const cues = Array.isArray(meta.subtitles?.cues) ? meta.subtitles.cues : []
  const frames = captured.map((frame, index) => {
    const cue = nearestCue(cues, frame.time)
    return {
      index: index + 1,
      time: Number(frame.time.toFixed(3)),
      timeLabel: formatClock(frame.time),
      requestedTime: frame.requestedTime ?? Number(frame.time.toFixed(3)),
      adjusted: Boolean(frame.adjusted),
      path: frame.path ?? null,
      bytes: frame.bytes ?? null,
      subtitle: cue?.text ?? null,
      error: frame.error ?? null,
    }
  })
  updateRun(options.progress, 'frames', { frames: frames.length })

  // DSH's attachment store caps one message at 20 images; going past that only
  // spends token budget on images the request projection then drops.
  const maxAttach = Math.max(1, Math.min(20, Number(cfg.maxAttachImages) || 20))
  const captionsRequested = wantsCaptions && !isGrid
  if (wantsCaptions && isGrid) {
    notes.push('captions are ignored in grid mode; call video_frames with mode="times" for captioned frames')
  }
  const attachBudget = captionsRequested
    ? Math.max(maxAttach, Math.min(8, Number(cfg.maxCaptionFrames) || 8))
    : maxAttach
  // Grid mode renders ONE contact-sheet image, so attaching each cell as well
  // would only spend image budget twice; the grid attachment is done later.
  const wantsFrameAttachments = (route.capable || captionsRequested) && wantsImages && !isGrid
  if (wantsFrameAttachments && frames.length > attachBudget) {
    notes.push(`only the first ${attachBudget} of ${frames.length} frames were attached as images (maxAttachImages)`)
  }
  const withAttachments = wantsFrameAttachments
    ? await attachFrames(ctx, frames, { maxImages: attachBudget, concurrency: frameConcurrency(cfg) })
    : frames.map((frame) => ({ ...frame, attachment: null }))
  if (captionsRequested) {
    updateRun(options.progress, 'captions', { frames: withAttachments.length })
    const captioned = await captionFrames({
      ctx,
      cfg,
      frames: withAttachments,
      route,
      signal: exec?.signal,
      maxFrames: Number(cfg.maxCaptionFrames) || 8,
    })
    if (captioned.note) notes.push(captioned.note)
    const byIndex = new Map(captioned.captions.map((entry) => [entry.index, entry.text]))
    for (const frame of withAttachments) {
      if (byIndex.has(frame.index)) frame.caption = byIndex.get(frame.index)
    }
    if (captioned.captions.length) notes.push(`${captioned.captions.length} frame(s) captioned by ${cfg.captionProvider || route.provider}/${cfg.captionModel || route.model}`)
  }

  let grid = null
  if (options.grid === true && withAttachments.length) {
    const burnTimestamps = flag(params.burn_timestamps, flag(cfg.burnTimestamps, true))
    try {
      grid = await buildGrid(ff, withAttachments, {
        outDir: framesDir,
        signal: exec?.signal,
        cellWidth: Math.max(160, Math.min(640, Number(cfg.gridCellWidth) || 320)),
        cellHeight: Math.max(120, Math.min(480, Number(cfg.gridCellHeight) || 240)),
        labels: burnTimestamps ? withAttachments.map((frame) => frame.timeLabel) : [],
      })
      if (route.capable) {
        try {
          const data = await readFile(grid.path)
          grid.attachment = await ctx.attachments.saveImage({ data, mediaType: 'image/jpeg', name: `grid-${runId}.jpg` })
        } catch (error) {
          notes.push(`contact sheet attach failed: ${error.message}`)
        }
      }
      const labelNote = grid.labelsBurned
        ? ' with burned-in timestamps (row-major)'
        : grid.labels
          ? ` with timestamps on ${grid.labels}/${withAttachments.length} cells (row-major)`
          : ''
      notes.push(
        `contact sheet: ${withAttachments.length} frame(s) tiled into one ${grid.cols}x${grid.rows} image` +
          `${labelNote} (${grid.path})`,
      )
      // The grid replaces per-frame images; keep per-frame text (time/subtitle).
      // Only drop them when the contact sheet really attached — otherwise the
      // caller would receive zero images for a failed grid attach.
      if (grid.attachment) {
        for (const frame of withAttachments) if (frame.path) frame.attachment = null
      }
    } catch (error) {
      notes.push(`contact sheet unavailable: ${error.message}`)
      grid = null
    }
  }

  let danmaku = null
  if (options.includeDanmaku && meta.kind === 'bilibili' && meta.cid) {
    try {
      updateRun(options.progress, 'danmaku')
      const fetched = await fetchDanmaku({ cid: meta.cid, signal: exec?.signal })
      const lines = fetched.lines.slice(0, 200).map((line) => `${formatClock(line.time)} ${line.text}`)
      danmaku = { count: fetched.count, lines, note: fetched.note }
      if (fetched.count > lines.length) notes.push(`danmaku timeline truncated to the first ${lines.length} of ${fetched.count} line(s)`)
    } catch (error) {
      notes.push(`danmaku timeline unavailable: ${error.message}`)
    }
  }

  const timeline =
    options.includeTimeline === false
      ? { lines: [], truncated: false, total: cues.length, stride: 1, coversUntilSec: null }
      : formatTimeline(cues, { maxCues: Number(cfg.maxTimelineCues) || 300, maxChars: 24_000 })
  const manifestPath = join(meta.artifactsDir, 'manifest.json')
  const value = baseValue(meta, {
    notes,
    value: {
      framesDir,
      manifestPath,
      sampling: {
        mode: plan.mode,
        requestedFps,
        maxFrames,
        range,
        captured: withAttachments.filter((frame) => frame.path).length,
      },
      frames: withAttachments,
      timeline,
      danmaku,
      grid: grid
        ? { path: grid.path, bytes: grid.bytes, cols: grid.cols, rows: grid.rows, cells: grid.cells, attachment: grid.attachment ?? null }
        : null,
      textOnlyFallback: !route.capable && wantsImages,
      textOnlyFallbackReason: route.reason ?? null,
      edges: edges
        ? {
            contentStart: edges.contentStart,
            contentEnd: edges.contentEnd,
            headBlackSec: edges.headBlackSec,
            tailBlackSec: edges.tailBlackSec,
          }
        : null,
      route: { provider: route.provider ?? null, model: route.model ?? null, imageInput: Boolean(route.capable) },
    },
  })
  const storyboard = plan.mode === 'scene' ? buildStoryboard(value) : null
  if (storyboard) value.storyboard = storyboard
  await persistJson(manifestPath, {
    manifestVersion: 2,
    generatedAt: new Date().toISOString(),
    runId,
    source: value.source,
    sampling: value.sampling,
    subtitle: value.subtitle,
    route: value.route,
    notes: value.notes,
    ...(storyboard ? { storyboard: storyboard.scenes } : {}),
    ...(edges ? { edges } : {}),
    coverage: {
      timelineTruncated: Boolean(timeline.truncated),
      timelineTotal: timeline.total,
      timelineStride: timeline.stride ?? 1,
      coversUntil: timeline.coversUntil ?? null,
    },
    frames: withAttachments.map(({ attachment: _attachment, ...frame }) => frame),
    grid: grid ? { path: grid.path, cols: grid.cols, rows: grid.rows, cells: grid.cells } : null,
    timeline: timeline.lines,
    timelineIncluded: options.includeTimeline !== false,
  })
  await pruneRuns(join(meta.artifactsDir, 'frames'), MAX_RUNS_PER_ARTIFACT)
  return value
}

function probeValue(meta, route, cfg = {}) {
  const cues = Array.isArray(meta.subtitles?.cues) ? meta.subtitles.cues : []
  const sample = formatTimeline(cues, { maxCues: 20, maxChars: 4_000 })
  const captionModel = cfg.captionModel || cfg.captionProvider
    ? `${cfg.captionProvider || route.provider || '?'}/${cfg.captionModel || route.model || '?'}`
    : null
  const modelFit = route.capable
    ? {
        kind: 'image+text',
        use: 'The routed model can see frames: call video_read for a short clip, video_frames mode="grid" to sample many moments into one image, or video_storyboard for a shot-by-shot view.',
        captionModel,
      }
    : {
        kind: 'text-only',
        use:
          'The routed model cannot see images. Use video_digest (subtitle/danmaku text timeline) and video_ask (retrieve moments) first; ' +
          'frames are still written to disk but returned as text diagnostics only. Set captionModel/captionProvider in the plugin config to enable the C1 caption bridge, which turns sampled frames into text descriptions.',
        captionModel,
        captionBridgeEnabled: Boolean(captionModel),
      }
  return {
    ok: true,
    source: publicSource(meta),
    probe: {
      kind: meta.kind,
      durationSec: meta.durationSec,
      durationLabel: formatClock(meta.durationSec),
      width: meta.width ?? null,
      height: meta.height ?? null,
      hasAudio: meta.hasAudio ?? null,
      hasVideo: meta.hasVideo ?? null,
      artwork: meta.cover ?? null,
      page: meta.page ?? null,
      pageCount: meta.pageCount ?? null,
      part: meta.part ?? null,
      publishedAt: meta.publishedAt ?? null,
      mediaFile: meta.filePath ?? null,
      resolvedAt: meta.resolvedAt ?? null,
      cached: meta.cached ?? null,
      sizeBytes: meta.sizeBytes ?? null,
    },
    subtitle: {
      languages: meta.subtitles?.languages ?? [],
      count: cues.length,
      note: meta.subtitles?.note ?? null,
      firstLines: sample.lines,
    },
    ffmpeg: meta.ffmpeg
      ? { available: Boolean(meta.ffmpeg.available), version: meta.ffmpeg.version ?? null, note: meta.ffmpeg.note ?? null }
      : { available: false, version: null, note: 'ffmpeg status unknown' },
    route: {
      provider: route.provider ?? null,
      model: route.model ?? null,
      imageInput: Boolean(route.capable),
      declaredInputs: route.declaredInputs ?? null,
      note: route.reason ?? null,
      videoNote:
        route.videoDeclared === true
          ? 'the routed model declares video input, but DSH content blocks still have no video type; dsh-video-read returns sampled frames instead, which is the honest fallback'
          : null,
    },
    recommended: {
      fpsHint: 'Default 1 fps is usually right for speech content; use 2-5 fps for fast visual action and mode="times" for targeted moments.',
      note: 'Then call video_read (or video_frames) with start/end to bound the sampled range. Max 32 frames per call.',
      modelFit,
      edgesHint:
        'Leading/trailing black frames are skipped automatically (skipBlackEdges="auto"); pass trim_head/trim_tail to override.',
    },
    notes: meta.notes ?? [],
  }
}

function probeTool(ctx, cfg) {
  return {
    name: 'video_probe',
    description:
      'Inspect a video before reading it. Call this FIRST whenever the user gives a video link (bilibili BV…/b23.tv, YouTube, or a direct mp4 URL) or a local video file and asks anything about its content. Returns metadata (title, duration, resolution, audio, subtitle languages and a short subtitle preview), the artifact directory, ffmpeg availability, and which reading path fits the current routed model (image+text vs text-only). For Bilibili this does not download the media; it only calls the public APIs (a cookie file improves quality and subtitle access).',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description:
            'Bilibili video URL (bilibili.com/video/BV..., av..., b23.tv short link), a YouTube page URL, a direct video media URL (.mp4/.webm/...), or a local video file path (absolute, or relative to the workspace).',
        },
      },
      required: ['source'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [text(jsonText(value))] },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const source = String(args?.source ?? '').trim()
      if (!source) throw new Error('source is required')
      const progress = startRun({ cfg, source, mode: 'probe', maxFrames: null })
      try {
        updateRun(progress, 'resolving')
        const meta = await resolveSource({
          ctx,
          cfg,
          cwd: sessionCwd(ctx, exec),
          signal: exec?.signal,
          download: false,
          source,
          onEvent: runtimeReporter(progress),
        })
        updateRun(progress, 'probing', {
          detail: `${meta.kind}${meta.durationLabel ? ` · ${meta.durationLabel}` : ''}`,
          artifactsDir: meta.artifactsDir ?? null,
          title: meta.title ?? null,
        })
        const route = await imageRoute(ctx, exec)
        const value = probeValue(meta, route, cfg)
        finishRun(progress, { ok: true, artifactsDir: meta.artifactsDir ?? null })
        return value
      } catch (error) {
        finishRun(progress, { ok: false, error })
        throw error
      }
    },
  }
}

function framesTool(ctx, cfg) {
  return {
    name: 'video_frames',
    description:
      'Sample frames from a video for visual inspection. Call this when the user asks what a video looks like, what happens in it, or at specific moments. Acquires the media when needed (Bilibili DASH download + ffmpeg mux; ffmpeg is auto-downloaded on first use), then samples frames and returns them as images in time order, each labeled with its timestamp and nearest subtitle, plus a manifest under <workspace>/.video-read/. The routed model MUST declare image input; otherwise the frames are written to disk but returned as text diagnostics only. Use mode="even" with fps over a time range, mode="times" for explicit seconds, mode="scene" for scene-change detection, or mode="grid" to tile the sample into ONE contact-sheet image with burned-in timestamps (best token/coverage tradeoff when you want many frames). Leading/trailing black frames are skipped automatically. Max 32 frames per call.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Bilibili or YouTube page URL, a direct video media URL (.mp4/.webm/...), or a local video file path.' },
        fps: {
          type: 'number',
          description: 'Frames per second for even sampling (default 1). Values above 32/max_frames saturate at max_frames; 0.05-60 accepted.',
        },
        max_frames: { type: 'integer', minimum: 1, maximum: 32, description: 'Frame cap (default 16, hard max 32).' },
        mode: {
          type: 'string',
          enum: ['even', 'times', 'scene', 'grid'],
          description:
            'Sampling strategy. Default even = evenly spaced by fps; times = exact timestamps; scene = scene-change detection; grid = even sampling tiled into ONE contact-sheet image (token-cheap way to raise fps).',
        },
        times: {
          type: 'array',
          items: { type: 'number', minimum: 0 },
          maxItems: MAX_TIMES,
          description:
            'Explicit timestamps in seconds; only with mode="times". Lists longer than 32 are thinned (evenly kept) to the frame cap with a note, not rejected.',
        },
        start: { type: 'number', description: 'Optional start of the sampled range in seconds (default 0).' },
        end: { type: 'number', description: 'Optional end of the sampled range in seconds (default video duration).' },
        include_timeline: { type: 'boolean', description: 'Include the subtitle timeline text in the result (default true).' },
        include_danmaku: { type: 'boolean', description: 'Also return a short Bilibili danmaku timeline (default false).' },
        captions: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description:
            'Caption frames with an image-capable model for text-only readers: auto (default) only when the routed model cannot see images AND captionModel is configured; always = caption regardless; never = skip.',
        },
        skip_black_edges: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description:
            'Skip leading/trailing black frames by analysing the first/last ~3s (default auto = on). Use "never" to keep the exact range.',
        },
        trim_head: { type: 'number', minimum: 0, description: 'Skip this many seconds from the start of the video (absolute).' },
        trim_tail: { type: 'number', minimum: 0, description: 'Skip this many seconds from the end of the video (absolute).' },
        burn_timestamps: {
          type: 'boolean',
          description: 'Burn the timestamp into each contact-sheet cell (default true; only affects mode="grid").',
        },
      },
      required: ['source'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => frameBlocks(value),
    },
    timeoutMs: 600_000,
    async execute(args, exec) {
      const source = String(args?.source ?? '').trim()
      if (!source) throw new Error('source is required')
      const params = normalizeParams(args)
      if (params.mode === 'grid') {
        // Grid = even sampling (+ optional danmaku/captions) tiled into one image.
        return capture({
          ctx,
          cfg,
          exec,
          source,
          params: { ...params, mode: 'even' },
          includeTimeline: params.include_timeline,
          captions: params.captions,
          includeDanmaku: params.include_danmaku === true,
          grid: true,
        })
      }
      return capture({
        ctx,
        cfg,
        exec,
        source,
        params,
        includeTimeline: params.include_timeline,
        captions: params.captions,
        includeDanmaku: params.include_danmaku === true,
      })
    },
  }
}

function readTool(ctx, cfg) {
  return {
    name: 'video_read',
    description:
      'One-shot video reading. Call this when the user gives a video link or file and asks what happens in it, or asks to summarize/describe/answer questions about a video. Acquires the media, samples frames (default 1 fps, capped at 8 frames per call, max 32), pairs each frame with the timeline subtitle text, and returns an ordered evidence set (images + per-frame timestamp/subtitle labels + subtitle timeline) so you can answer questions about the video. Prefer this for short clips; for long videos pass start/end, use mode via video_frames, or use video_digest for a text-only digest. Text-only models receive a metadata + subtitle-timeline + caption fallback. Leading/trailing black frames are skipped automatically; repeated calls reuse the cached download.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Bilibili or YouTube page URL, a direct video media URL (.mp4/.webm/...), or a local video file path.' },
        fps: { type: 'number', description: 'Even-sampling fps (default 1; 0.05-60 accepted, saturating at max_frames).' },
        max_frames: { type: 'integer', minimum: 1, maximum: 32, description: 'Frame cap (default 8 for video_read, hard max 32).' },
        start: { type: 'number', description: 'Optional range start in seconds (default 0).' },
        end: { type: 'number', description: 'Optional range end in seconds (default video duration).' },
        include_timeline: { type: 'boolean', description: 'Include the subtitle timeline text in the result (default true).' },
        captions: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: 'C1 visual bridge: caption frames with a configured captionModel. auto (default) captions only when the routed model cannot see images and a captionModel is configured; never disables it.',
        },
        include_danmaku: { type: 'boolean', description: 'Also return a short Bilibili danmaku timeline (default false).' },
        skip_black_edges: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: 'Skip leading/trailing black frames (default auto).',
        },
        trim_head: { type: 'number', minimum: 0, description: 'Skip this many seconds from the start of the video (absolute).' },
        trim_tail: { type: 'number', minimum: 0, description: 'Skip this many seconds from the end of the video (absolute).' },
      },
      required: ['source'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => frameBlocks(value),
    },
    timeoutMs: 600_000,
    async execute(args, exec) {
      const source = String(args?.source ?? '').trim()
      if (!source) throw new Error('source is required')
      const params = normalizeParams(args)
      if (params.max_frames === undefined) params.max_frames = 8
      return capture({
        ctx,
        cfg,
        exec,
        source,
        params,
        includeTimeline: params.include_timeline,
        captions: params.captions,
        includeDanmaku: params.include_danmaku === true,
      })
    },
  }
}

async function metaOnly(ctx, cfg, exec, source, onEvent) {
  const meta = await resolveSource({
    ctx,
    cfg,
    cwd: sessionCwd(ctx, exec),
    signal: exec?.signal,
    download: false,
    source,
    onEvent,
  })
  return meta
}

function digestTool(ctx, cfg) {
  return {
    name: 'video_digest',
    description:
      "Text-only long-video digest (path C2). Segments a video's subtitle timeline (plus Bilibili danmaku when available) into readable time blocks WITHOUT downloading media or spending image tokens. Use it first for long videos or text-only models, then video_frames/video_shots for visual evidence, or video_ask to retrieve specific moments.",
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Bilibili or YouTube page URL, a direct video media URL (.mp4/.webm/...), or a local video file path.' },
        start: { type: 'number', description: 'Optional start second (default 0).' },
        end: { type: 'number', description: 'Optional end second (default video duration).' },
        segment_seconds: { type: 'number', description: 'Target segment length in seconds (default 120; adapted so max_segments is respected).' },
        max_segments: { type: 'integer', minimum: 1, maximum: 50, description: 'Segment cap (default 12).' },
        include_danmaku: { type: 'boolean', description: 'Include Bilibili danmaku lines (default true when available).' },
      },
      required: ['source'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [text(value.digestText ?? summaryText(value))] },
    timeoutMs: 180_000,
    async execute(args, exec) {
      const source = String(args?.source ?? '').trim()
      if (!source) throw new Error('source is required')
      const progress = startRun({ cfg, source, mode: 'digest', maxFrames: null })
      try {
        updateRun(progress, 'resolving')
        const meta = await metaOnly(ctx, cfg, exec, source, runtimeReporter(progress))
        updateRun(progress, 'probing', {
          detail: `${meta.kind}${meta.durationLabel ? ` · ${meta.durationLabel}` : ''}`,
          artifactsDir: meta.artifactsDir ?? null,
          title: meta.title ?? null,
        })
        const cues = Array.isArray(meta.subtitles?.cues) ? meta.subtitles.cues : []
        const notes = [...(meta.notes ?? [])]
        let danmaku = { count: 0, total: 0, lines: [], note: null }
        if (args?.include_danmaku !== false && meta.kind === 'bilibili' && meta.cid) {
          try {
            updateRun(progress, 'danmaku')
            danmaku = await fetchDanmaku({ cid: meta.cid, signal: exec?.signal })
          } catch (error) {
            notes.push(`danmaku unavailable: ${error.message}`)
          }
        }
        const start = Math.max(0, Number(args?.start ?? 0) || 0)
        const end = args?.end === undefined ? Number(meta.durationSec) : Math.max(start + 0.5, Number(args.end) || 0)
        const built = buildSegments({
          cues,
          danmaku: danmaku.lines,
          startSec: start,
          endSec: end,
          segmentSeconds: Number(args?.segment_seconds) || cfg.digestSegmentSeconds,
          maxSegments: Number(args?.max_segments) || cfg.maxDigestSegments,
        })
        const value = baseValue(meta, {
          notes: [...notes, ...(danmaku.note ? [danmaku.note] : []), ...(meta.subtitles?.note ? [meta.subtitles.note] : [])],
          value: {
            range: { start, end },
            evidenceStatus: built.totalCues || built.totalDanmaku ? 'ready' : 'no-text-evidence',
            nextAction: built.totalCues ? null : 'Use video_frames or video_shots to inspect the visuals; text-only summary cannot infer visual-only content.',
            segments: built.segments,
            segmentSeconds: built.segmentSeconds,
            totalCues: built.totalCues,
            totalDanmaku: built.totalDanmaku,
            danmaku: { count: danmaku.count, note: danmaku.note },
        },
      })
      value.digestText = renderDigestText({
        source: value.source,
        segments: built.segments,
        segmentSeconds: built.segmentSeconds,
        totalCues: built.totalCues,
        totalDanmaku: built.totalDanmaku,
        coveredUntilSec: built.coveredUntilSec,
        evidenceNote: value.nextAction,
        notes: value.notes,
      })
      finishRun(progress, { ok: true, artifactsDir: meta.artifactsDir ?? null })
      return value
    } catch (error) {
      finishRun(progress, { ok: false, error })
      throw error
    }
    },
  }
}

function askTool(ctx, cfg) {
  return {
    name: 'video_ask',
    description:
      "Retrieve the best-matching moments of a video's text evidence: ranks subtitle cues and Bilibili danmaku against a question, locally and without a model call or media download. Returns time-stamped lines. Follow up with video_frames mode=\"times\" at those timestamps to see the frames.",
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Bilibili or YouTube page URL, a direct video media URL (.mp4/.webm/...), or a local video file path.' },
        question: { type: 'string', description: 'Natural-language question or keywords to retrieve moments for.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum matching lines (default 12).' },
        start: { type: 'number', description: 'Optional start second filter.' },
        end: { type: 'number', description: 'Optional end second filter.' },
        include_danmaku: { type: 'boolean', description: 'Also search Bilibili danmaku (default true).' },
      },
      required: ['source', 'question'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [text(value.evidenceText ?? summaryText(value))] },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const source = String(args?.source ?? '').trim()
      const question = String(args?.question ?? '').trim()
      if (!source) throw new Error('source is required')
      if (!question) throw new Error('question is required')
      const progress = startRun({ cfg, source, mode: 'ask', maxFrames: null })
      try {
        updateRun(progress, 'resolving')
        const meta = await metaOnly(ctx, cfg, exec, source, runtimeReporter(progress))
        updateRun(progress, 'probing', {
          detail: `${meta.kind}${meta.durationLabel ? ` · ${meta.durationLabel}` : ''}`,
          artifactsDir: meta.artifactsDir ?? null,
          title: meta.title ?? null,
        })
        const start = Math.max(0, Number(args?.start ?? 0) || 0)
      const end = args?.end === undefined ? Number(meta.durationSec) : Number(args.end)
      const cues = (Array.isArray(meta.subtitles?.cues) ? meta.subtitles.cues : []).filter(
        (cue) => Number(cue.from) >= start - 0.2 && Number(cue.from) <= end,
      )
      let danmaku = []
      const notes = [...(meta.notes ?? [])]
      if (args?.include_danmaku !== false && meta.kind === 'bilibili' && meta.cid) {
        try {
          const fetched = await fetchDanmaku({ cid: meta.cid, signal: exec?.signal })
          danmaku = fetched.lines.filter((line) => line.time >= start - 0.2 && line.time <= end)
        } catch (error) {
          notes.push(`danmaku search unavailable: ${error.message}`)
        }
      }
      const retrieved = rankEvidence({
        question,
        cues,
        danmaku,
        limit: Number(args?.limit) || 12,
      })
      const lines = retrieved.items.map(
        (item) => `${item.timeLabel} [${item.kind}] ${item.text} (score ${item.score})`,
      )
      const evidenceText = [
        `Question: ${question}`,
        `Evidence pool: ${cues.length} subtitle cue(s), ${danmaku.length} danmaku line(s)`,
        retrieved.note ? `Note: ${retrieved.note}` : null,
        ...lines,
        lines.length ? 'Use video_frames with mode="times" and these timestamps to see the frames.' : null,
      ]
        .filter(Boolean)
        .join('\n')
      const value = baseValue(meta, {
        notes,
        value: {
          question,
          retrieval: { items: retrieved.items, query: retrieved.query, note: retrieved.note },
          evidenceText,
        },
      })
      finishRun(progress, { ok: true, artifactsDir: meta.artifactsDir ?? null })
      return value
      } catch (error) {
        finishRun(progress, { ok: false, error })
        throw error
      }
    },
  }
}

function scenesTool(ctx, cfg) {
  return {
    name: 'video_scenes',
    description:
      'Detect scene cuts in a Bilibili video or local file and return one image per detected cut (max 32) with timestamps, nearest subtitles, and a manifest. Equivalent to video_frames mode="scene" but focused on the cut list. When no cut is detected (single long shot), a middle frame is returned as a fallback and the result says so. Requires a routed model with image input; downloads the media once and reuses the cache.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Bilibili or YouTube page URL, a direct video media URL (.mp4/.webm/...), or a local video file path.' },
        max_frames: { type: 'integer', minimum: 1, maximum: 32, description: 'Maximum cuts to return (default 16).' },
        start: { type: 'number', description: 'Optional start second.' },
        end: { type: 'number', description: 'Optional end second.' },
      },
      required: ['source'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => frameBlocks(value) },
    timeoutMs: 600_000,
    async execute(args, exec) {
      const source = String(args?.source ?? '').trim()
      if (!source) throw new Error('source is required')
      const params = normalizeParams({ ...args, mode: 'scene' })
      return capture({ ctx, cfg, exec, source, params })
    },
  }
}

function shotsTool(ctx, cfg) {
  return {
    name: 'video_shots',
    description:
      "Keyframe screenshots from Bilibili's own videoshot sprite: the platform publishes a 10x10 tile strip of keyframes plus their timestamps, so one page image yields many keyframes without decoding the whole video. Cheap visual evidence for long videos. Bilibili only; for local files use video_frames mode=\"times\" or mode=\"scene\".",
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Bilibili video URL.' },
        max_shots: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum keyframes (default 8).' },
        start: { type: 'number', description: 'Optional start second filter.' },
        end: { type: 'number', description: 'Optional end second filter.' },
      },
      required: ['source'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => frameBlocks(value) },
    timeoutMs: 300_000,
    async execute(args, exec) {
      const source = String(args?.source ?? '').trim()
      if (!source) throw new Error('source is required')
      const progress = startRun({ cfg, source, mode: 'shots', maxFrames: null })
      try {
        updateRun(progress, 'resolving')
        const meta = await metaOnly(ctx, cfg, exec, source, runtimeReporter(progress))
        updateRun(progress, 'probing', {
          detail: `${meta.kind}${meta.durationLabel ? ` · ${meta.durationLabel}` : ''}`,
          artifactsDir: meta.artifactsDir ?? null,
          title: meta.title ?? null,
        })
        if (meta.kind !== 'bilibili') {
          throw new Error('video_shots only supports Bilibili; for local files use video_frames with mode="times" or mode="scene"')
        }
        const ff = meta.ffmpeg ?? (await resolveFfmpeg(cfg, { signal: exec?.signal }))
        if (!ff?.available) {
          const error = new Error('ffmpeg is required to crop keyframe tiles but is unavailable')
          error.code = 'E_FFMPEG_MISSING'
          throw error
        }
        const notes = [...(meta.notes ?? [])]
        const shots = await fetchVideoShots({ bvid: meta.bvid, cid: meta.cid, signal: exec?.signal })
        if (!shots.times.length || !shots.images.length) {
          const error = new Error('Bilibili returned no videoshot keyframe sprite for this video; use video_frames instead')
          error.code = 'E_NO_SPRITE'
          throw error
        }
        const start = Math.max(0, Number(args?.start ?? 0) || 0)
      const end = args?.end === undefined ? Number(meta.durationSec) : Number(args.end)
      const picks = pickShotIndices({
        shots,
        start,
        end,
        max: Number(args?.max_shots) || Number(cfg.maxShots) || 8,
      })
      if (!picks.length) throw new Error('no keyframe from the sprite falls inside the requested range')
      const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-shots`
      const outDir = join(meta.artifactsDir, 'shots', runId)
      const captured = await materializeShots({
        ff,
        shots,
        picks,
        cacheDir: join(meta.artifactsDir, 'videoshot'),
        outDir,
        signal: exec?.signal,
        quality: Number(cfg.quality) || 3,
      })
      if (!captured.length) throw new Error('no keyframe tile could be cropped from the sprite')
      const cues = Array.isArray(meta.subtitles?.cues) ? meta.subtitles.cues : []
      const frames = captured.map((frame, index) => ({
        index: index + 1,
        time: Number(Number(frame.time).toFixed(3)),
        timeLabel: formatClock(frame.time),
        requestedTime: Number(Number(frame.time).toFixed(3)),
        adjusted: false,
        path: frame.path,
        bytes: frame.bytes,
        subtitle: nearestCue(cues, frame.time)?.text ?? null,
        error: null,
      }))
      const route = await imageRoute(ctx, exec)
      const withAttachments = route.capable
        ? await attachFrames(ctx, frames, { maxImages: Math.min(20, Number(cfg.maxAttachImages) || 20) })
        : frames.map((frame) => ({ ...frame, attachment: null }))
      if (!route.capable) notes.push(`no image evidence attached: ${route.reason}`)
      const timeline = formatTimeline(cues, { maxCues: Number(cfg.maxTimelineCues) || 300, maxChars: 24_000 })
      const value = baseValue(meta, {
        notes,
        value: {
          framesDir: outDir,
          sampling: { mode: 'shots', requestedFps: null, maxFrames: picks.length, range: { start, end }, captured: withAttachments.filter((frame) => frame.path).length },
          frames: withAttachments,
          timeline,
          textOnlyFallback: !route.capable,
          textOnlyFallbackReason: route.reason ?? null,
          route: { provider: route.provider ?? null, model: route.model ?? null, imageInput: Boolean(route.capable) },
          shots: { pages: shots.images.length, tileSize: `${shots.xSize}x${shots.ySize}`, available: shots.times.length },
        },
      })
      await persistJson(join(outDir, 'manifest.json'), {
        manifestVersion: 2,
        generatedAt: new Date().toISOString(),
        runId,
        source: value.source,
        shots: value.shots,
        frames: withAttachments.map(({ attachment: _attachment, ...frame }) => frame),
      })
      finishRun(progress, { ok: true, frames: frames.length, artifactsDir: meta.artifactsDir ?? null })
      return value
      } catch (error) {
        finishRun(progress, { ok: false, error })
        throw error
      }
    },
  }
}

function storyboardTool(ctx, cfg) {
  return {
    name: 'video_storyboard',
    description:
      'Build a shot-by-shot storyboard for a Bilibili video or local file: detect scene cuts with ffmpeg, capture one frame per cut inside start/end (max 32), and return a scene list with time ranges, nearest subtitle and optional model caption, plus the images themselves. Use it for "shot by shot" understanding, visual outlines, or turning a clip into a structured summary. The scene list is returned as text even when the routed model cannot see images.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Bilibili or YouTube page URL, a direct video media URL (.mp4/.webm/...), or a local video file path.' },
        start: { type: 'number', description: 'Optional range start in seconds (default 0).' },
        end: { type: 'number', description: 'Optional range end in seconds (default video duration).' },
        max_frames: { type: 'integer', minimum: 1, maximum: 32, description: 'Scene cap (default 12, hard max 32).' },
        scene_threshold: {
          type: 'number',
          minimum: 0.02,
          maximum: 0.95,
          description: 'Scene-cut sensitivity: lower finds more cuts (default from config, 0.3).',
        },
        captions: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: 'Caption each scene with an image-capable model (auto = only when the routed model has no image input and captionModel is configured).',
        },
        include_timeline: { type: 'boolean', description: 'Include the subtitle timeline text in the result (default true).' },
      },
      required: ['source'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const blocks = frameBlocks(value)
        if (value?.storyboard) blocks.push(text(renderStoryboardText(value.storyboard)))
        return blocks
      },
    },
    timeoutMs: 600_000,
    async execute(args, exec) {
      const source = String(args?.source ?? '').trim()
      if (!source) throw new Error('source is required')
      const params = normalizeParams({ ...args, mode: 'scene' })
      let effective = cfg
      if (args?.scene_threshold !== undefined) {
        const threshold = Number(args.scene_threshold)
        if (!(threshold > 0.01 && threshold < 1)) throw new Error('scene_threshold must be between 0.01 and 1')
        effective = { ...cfg, sceneThreshold: threshold }
      }
      return capture({
        ctx,
        cfg: effective,
        exec,
        source,
        params,
        includeTimeline: params.include_timeline,
        captions: params.captions,
        includeDanmaku: false,
      })
    },
  }
}

function cacheTool(ctx, cfg) {
  return {
    name: 'video_cache',
    description:
      'Inspect or prune the workspace artifact cache used by dsh-video-read (<workspace>/.video-read). status lists every source directory with its byte size and staleness; prune deletes directories older than ttl_days (default from config cacheTtlDays, 14 days) and reports the freed bytes; dry_run previews without deleting. Only directories under the workspace .video-read root are ever touched.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'prune'], description: 'status (default) lists the cache; prune removes stale entries.' },
        ttl_days: { type: 'number', minimum: 0, description: 'Override the staleness window in days (default from config).' },
        dry_run: { type: 'boolean', description: 'For prune: preview without deleting (default true). Must be explicitly false to delete.' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [text(jsonText(value))] },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const rootDir = join(sessionCwd(ctx, exec), '.video-read')
      const action = args?.action === 'prune' ? 'prune' : 'status'
      const ttlDays = args?.ttl_days === undefined ? Number(cfg.cacheTtlDays) || 14 : Number(args.ttl_days)
      if (!Number.isFinite(ttlDays) || ttlDays < 0) throw new Error('ttl_days must be a non-negative number')
      if (action === 'prune') {
        const dryRun = args?.dry_run !== false
        const pruned = await pruneCache(rootDir, { ttlDays, dryRun })
        return { ok: true, action, dryRun, ...pruned }
      }
      const status = await cacheStatus(rootDir, { ttlDays })
      return { ok: true, action, ...status }
    },
  }
}

/** Register the video-reading tools for the whole profile. */
export function apply(ctx, config = {}) {
  // Persisted settings (written by the Web panel) win over the bundle patch so a
  // user change takes effect on the next activation without editing YAML.
  const settings = readSettings({ ...DEFAULT_CONFIG, ...(config ?? {}) })
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}), ...settings }
  // The Web carrier may not be composed yet when a Host plugin first applies
  // (boot order differs from a hot reload), so `ctx.get('webServer')` can be
  // undefined here. Waiting through ctx.inject(['webServer']) mounts the routes
  // as soon as the carrier exists; an Electron-only profile simply never mounts
  // them, and the tools keep working.
  const mountPanelRoutes = (hostCtx) => {
    try {
      mountPanel({ ctx: hostCtx, cfg, version: '0.5.3' })
    } catch {}
  }
  try {
    if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], (webCtx) => mountPanelRoutes(webCtx))
    else mountPanelRoutes(ctx)
  } catch {}
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(probeTool(ctx, cfg)),
      ctx.tools.register(framesTool(ctx, cfg)),
      ctx.tools.register(readTool(ctx, cfg)),
      ctx.tools.register(digestTool(ctx, cfg)),
      ctx.tools.register(askTool(ctx, cfg)),
      ctx.tools.register(scenesTool(ctx, cfg)),
      ctx.tools.register(shotsTool(ctx, cfg)),
      ctx.tools.register(storyboardTool(ctx, cfg)),
      ctx.tools.register(cacheTool(ctx, cfg)),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {}
      }
    }
  })
}
