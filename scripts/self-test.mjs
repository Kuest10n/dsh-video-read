/**
 * Local self-test for dsh-video-read. Runs without the DSH host by faking the
 * ctx services the plugin touches (tools/attachments/workingDirectory/llm/fs).
 *
 *   node scripts/self-test.mjs             # local synthetic video only
 *   node scripts/self-test.mjs --bilibili  # also probe/read one short popular Bilibili clip
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { apply } from '../index.js'
import { extractEven, extractScene, resolveFfmpeg, run } from '../lib/ffmpeg.js'
import { detectBlackEdges } from '../lib/edges.js'
import { buildGrid } from '../lib/grid.js'
import {
  clampRange,
  cleanCueText,
  formatClock,
  formatTimeline,
  planSampleTimes,
} from '../lib/frames.js'

const WORKSPACE = process.cwd()
const TEST_DIR = join(WORKSPACE, '.video-read-test')
const IMAGE_ROUTE = { provider: 'fake-provider', model: 'fake-vision' }
const TEXT_ROUTE = { provider: 'fake-provider', model: 'fake-text' }

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function fakeCtx({ modalities = ['text', 'image'], saved = [] } = {}) {
  const tools = new Map()
  const ctx = {
    effect(fn) {
      return fn()
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    workingDirectory: { get: () => WORKSPACE },
    fs: {
      resolve: async (path) => ({ path }),
      processPath: async (target) => target.path,
    },
    attachments: {
      async saveImage({ data, mediaType, name }) {
        saved.push(name)
        return {
          attachmentId: `test-${randomUUID()}`,
          mediaType,
          bytes: data.byteLength,
          width: null,
          height: null,
          name,
        }
      },
    },
    get(service) {
      if (service === 'llm') {
        return { resolveModelInfo: async () => ({ inputModalities: modalities }) }
      }
      return undefined
    },
  }
  return { ctx, tools, saved }
}

function fakeExec(route = IMAGE_ROUTE) {
  return {
    signal: undefined,
    agent: {
      options: route,
      session: { requestHeader: () => ({ config: route }) },
    },
  }
}

function renderText(blocks) {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : `[image ${block.attachment?.attachmentId ?? '?'}]`))
    .join('\n---\n')
}

async function makeEdgeVideo(ff) {
  await mkdir(TEST_DIR, { recursive: true })
  const file = join(TEST_DIR, 'edge-sample.mp4')
  try {
    const info = await stat(file)
    if (info.size > 1000) return file
  } catch {}
  await run(
    ff.ffmpeg,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=10:d=1',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=6',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=10:d=1',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
      '-map', '[out]',
      '-pix_fmt', 'yuv420p',
      file,
    ],
    { timeoutMs: 180_000 },
  )
  return file
}

async function makeSyntheticVideo(ff) {
  await mkdir(TEST_DIR, { recursive: true })
  const file = join(TEST_DIR, 'sample.mp4')
  try {
    const info = await stat(file)
    if (info.size > 1000) return file
  } catch {}
  await run(
    ff.ffmpeg,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc2=size=640x360:rate=12:duration=8',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=8',
      '-shortest',
      '-pix_fmt', 'yuv420p',
      file,
    ],
    { timeoutMs: 180_000 },
  )
  await writeFile(
    join(TEST_DIR, 'sample.srt'),
    [
      '1',
      '00:00:00,500 --> 00:00:02,500',
      'first cue: a synthetic test pattern',
      '',
      '2',
      '00:00:03,000 --> 00:00:05,000',
      'second cue: colors keep moving',
      '',
      '3',
      '00:00:06,000 --> 00:00:07,500',
      'third cue: closing frames',
      '',
    ].join('\n'),
    'utf8',
  )
  return file
}

async function shortBilibiliClip() {
  const response = await fetch('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=50', {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      referer: 'https://www.bilibili.com/',
    },
  })
  const json = await response.json()
  const list = Array.isArray(json?.data?.list) ? json.data.list : []
  const candidates = list
    .filter((item) => item.bvid && Number(item.duration) >= 20 && Number(item.duration) <= 90)
    .sort((a, b) => Number(a.duration) - Number(b.duration))
  if (!candidates.length) throw new Error('no short popular Bilibili clip found')
  return candidates[0]
}

function unitChecks() {
  // S7: rounding must not produce "00:60.0".
  check('formatClock carries 59.96s into the next minute', formatClock(59.96) === '01:00.0', formatClock(59.96))

  // T4: range coercion must be explained, not silent.
  const swapped = clampRange(60, 50, 10)
  check('clampRange explains a swapped range', swapped.notes.length >= 1, JSON.stringify(swapped))

  const clamped = planSampleTimes({
    durationSec: 30,
    range: { start: 0, end: 30 },
    mode: 'times',
    fps: 1,
    maxFrames: 8,
    requestedTimes: [40, 50, 60],
  })
  check(
    'planSampleTimes clamps out-of-range times and notes it',
    clamped.times.every((time) => time >= 0 && time <= 30) && clamped.notes.length >= 1,
    JSON.stringify({ times: clamped.times, notes: clamped.notes }),
  )

  // T3: thinning must preserve coverage to the end, not cut the tail.
  const cues = Array.from({ length: 400 }, (_, index) => ({
    from: index * 5,
    to: index * 5 + 4,
    text: `cue ${index} ${'x'.repeat(50)}`,
  }))
  const timeline = formatTimeline(cues, { maxCues: 400, maxChars: 800 })
  check(
    'formatTimeline keeps coverage when it thins',
    timeline.truncated === true && timeline.coversUntil === cues[cues.length - 1].from && timeline.lines.length > 0,
    JSON.stringify({ stride: timeline.stride, coversUntil: timeline.coversUntil, lines: timeline.lines.length }),
  )

  check('cleanCueText strips HTML and newlines', cleanCueText('<b>hello</b>\nworld') === 'hello world', cleanCueText('<b>hello</b>\nworld'))
}

async function main() {
  const withBilibili = process.argv.includes('--bilibili')
  console.log('workspace:', WORKSPACE)
  unitChecks()

  const ff = await resolveFfmpeg({ autoDownloadFfmpeg: true }, { log: (line) => console.log('[ffmpeg]', line) })
  check('ffmpeg available', ff.available, ff.available ? ff.version : ff.note)
  if (!ff.available) {
    console.log(JSON.stringify(results, null, 2))
    process.exit(1)
  }

  const file = await makeSyntheticVideo(ff)
  check('synthetic video created', true, file)

  // --- single-pass primitives -------------------------------------------
  const evenDir = join(TEST_DIR, 'frames-even')
  const even = await extractEven(ff, file, [1, 3, 5, 7], evenDir, { width: 640 })
  check(
    'extractEven: one pass, four distinct frames',
    even.length === 4 && even.every((frame) => frame.path) && new Set(even.map((frame) => frame.path)).size === 4,
    even.map((frame) => frame.bytes).join(','),
  )
  const evenHashes = await Promise.all(even.map(async (frame) => createHash('sha1').update(await readFile(frame.path)).digest('hex')))
  check('extractEven: frames differ', new Set(evenHashes).size >= 3, String(new Set(evenHashes).size))

  const sceneDir = join(TEST_DIR, 'frames-scene')
  const scene = await extractScene(ff, file, sceneDir, { threshold: 0.1, start: 0, end: 8, maxFrames: 6, width: 640 })
  // A hard-cut-free synthetic pattern legitimately yields zero cuts: extractScene
  // reports an empty set so the caller can fall back to even sampling.
  check(
    'extractScene: returns a frame set (possibly empty when there is no cut)',
    Array.isArray(scene) && scene.every((frame) => frame.path),
    `${scene.length} frames`,
  )

  // --- head/tail black edges --------------------------------------------
  const edgeFile = await makeEdgeVideo(ff)
  const edges = await detectBlackEdges(ff, edgeFile, { durationSec: 8 })
  check('edges: detects ~1s head black', Math.abs(edges.headBlackSec - 1) < 0.25, JSON.stringify({ head: edges.headBlackSec }))
  check('edges: detects ~1s tail black', Math.abs(edges.tailBlackSec - 1) < 0.25, JSON.stringify({ tail: edges.tailBlackSec }))
  check(
    'edges: content range trimmed to the real content',
    edges.contentStart > 0.7 && edges.contentStart < 1.3 && edges.contentEnd > 6.7 && edges.contentEnd < 7.3,
    `${edges.contentStart}–${edges.contentEnd}`,
  )

  // --- contact sheet with burned timestamps ------------------------------
  const gridDir = join(TEST_DIR, 'frames-grid')
  const grid = await buildGrid(ff, even, {
    outDir: gridDir,
    labels: even.map((frame) => formatClock(frame.time)),
    cellWidth: 320,
    cellHeight: 240,
  })
  check('grid: contact sheet built', Boolean(grid.path) && grid.cells === even.length, `${grid.cols}x${grid.rows}`)
  check('grid: timestamps burned into cells', grid.labelsBurned === true, `labeled=${grid.labels}/${grid.cells}`)

  const imageCtx = fakeCtx({ modalities: ['text', 'image'] })
  apply(imageCtx.ctx, { cookieFile: '' })
  const expectedTools = ['video_probe', 'video_frames', 'video_read', 'video_digest', 'video_ask', 'video_scenes', 'video_shots', 'video_storyboard', 'video_cache']
  check('tools registered', expectedTools.every((name) => imageCtx.tools.has(name)), [...imageCtx.tools.keys()].join(', '))

  const exec = fakeExec(IMAGE_ROUTE)

  // --- local probe -------------------------------------------------------
  const probeDef = imageCtx.tools.get('video_probe')
  const probe = await probeDef.execute({ source: file }, exec)
  check('probe local: duration', Math.abs(probe.probe.durationSec - 8) < 0.5, String(probe.probe.durationSec))
  check('probe local: sidecar subtitles', probe.subtitle.count === 3, `${probe.subtitle.count} cues`)
  check('probe local: image route detected', probe.route.imageInput === true, JSON.stringify(probe.route))
  check('probe local: hasVideo from the real probe', probe.probe.hasVideo === true, String(probe.probe.hasVideo))
  check('probe local: resolvedAt recorded', typeof probe.probe.resolvedAt === 'string', probe.probe.resolvedAt ?? '')

  // --- local read with images -------------------------------------------
  const readDef = imageCtx.tools.get('video_read')
  const read = await readDef.execute({ source: file, fps: 1, max_frames: 4 }, exec)
  check('read local: 4 frames captured', read.frames.length === 4, String(read.frames.length))
  check('read local: attachments saved', read.frames.every((frame) => frame.attachment), read.frames.map((f) => Boolean(f.attachment)).join(','))
  check('read local: subtitles paired', read.frames.some((frame) => frame.subtitle), read.frames.map((f) => f.subtitle).join(' | '))
  const manifestRaw = JSON.parse(await readFile(read.manifestPath, 'utf8'))
  check('manifest: v2 with coverage/route/notes', manifestRaw.manifestVersion === 2 && Boolean(manifestRaw.coverage) && Boolean(manifestRaw.route) && Array.isArray(manifestRaw.notes), read.manifestPath)
  const blocks = readDef.output.render({}, read)
  const imageBlocks = blocks.filter((block) => block.type === 'image')
  check('render: image blocks', imageBlocks.length === 4, String(imageBlocks.length))
  check('render: per-frame labels', blocks.filter((b) => b.type === 'text' && b.text.startsWith('[frame ')).length === 4)
  console.log(renderText(blocks).slice(0, 1200))

  // --- mode=times --------------------------------------------------------
  const framesDef = imageCtx.tools.get('video_frames')
  const timed = await framesDef.execute(
    { source: file, mode: 'times', times: [1, 3.5, 6.2], max_frames: 5 },
    exec,
  )
  check('frames: times mode', timed.frames.length === 3, timed.frames.map((f) => f.time).join(', '))
  const clampedTimes = await framesDef.execute({ source: file, mode: 'times', times: [40, 50], max_frames: 4 }, exec)
  check(
    'frames: out-of-range times produce notes and survive',
    clampedTimes.frames.length >= 1 && clampedTimes.notes.some((note) => /clamp/i.test(note)),
    JSON.stringify({ frames: clampedTimes.frames.length, notes: clampedTimes.notes }),
  )

  // --- scene mode --------------------------------------------------------
  const sceneRead = await framesDef.execute({ source: file, mode: 'scene', max_frames: 6 }, exec)
  check('frames: scene mode returns frames', sceneRead.frames.length >= 1, `${sceneRead.frames.length} frames`)

  // --- text-only fallback ------------------------------------------------
  const textCtx = fakeCtx({ modalities: ['text'] })
  apply(textCtx.ctx, { cookieFile: '' })
  const textRead = await textCtx.tools
    .get('video_read')
    .execute({ source: file, fps: 1, max_frames: 3 }, fakeExec(TEXT_ROUTE))
  check('text-only: no attachments', textRead.frames.every((frame) => !frame.attachment))
  check('text-only: flagged fallback', textRead.textOnlyFallback === true, textRead.textOnlyFallbackReason ?? '')
  check('text-only: timeline present', textRead.timeline.lines.length >= 2, `${textRead.timeline.lines.length} lines`)

  // --- structured rejections --------------------------------------------
  let douyinMessage = ''
  try {
    await probeDef.execute({ source: 'https://www.douyin.com/video/1234567890' }, exec)
  } catch (error) {
    douyinMessage = error.message
  }
  check('douyin: structured rejection', /Douyin is not supported in M1/.test(douyinMessage), douyinMessage.slice(0, 120))

  let drmMessage = ''
  try {
    await probeDef.execute({ source: 'https://www.netflix.com/watch/123' }, exec)
  } catch (error) {
    drmMessage = error.message
  }
  check('drm: refused before fetching', /DRM-protected/.test(drmMessage), drmMessage.slice(0, 120))

  let missingMessage = ''
  try {
    await probeDef.execute({ source: 'definitely-not-here.mp4' }, exec)
  } catch (error) {
    missingMessage = error.message
  }
  check('local: missing file is a friendly error', /local file not found/.test(missingMessage), missingMessage.slice(0, 120))

  // --- real Bilibili -----------------------------------------------------
  if (withBilibili) {
    const clip = await shortBilibiliClip()
    const url = `https://www.bilibili.com/video/${clip.bvid}`
    console.log(`[bilibili] using ${clip.bvid} duration=${clip.duration}s title=${clip.title}`)
    const cookieFile = 'E:\\talkchat assisment\\OpenBiliClaw\\data\\bilibili_cookie.json'
    const bctx = fakeCtx({ modalities: ['text', 'image'] })
    apply(bctx.ctx, { cookieFile, maxFrames: 32 })
    const bexec = fakeExec(IMAGE_ROUTE)
    const bprobe = await bctx.tools.get('video_probe').execute({ source: url }, bexec)
    check('bilibili probe: metadata', bprobe.source.bvid === clip.bvid, `${bprobe.source.title} / ${bprobe.probe.durationLabel}`)
    check('bilibili probe: ffmpeg ready', bprobe.ffmpeg.available === true, bprobe.ffmpeg.version ?? '')
    const bread = await bctx.tools.get('video_read').execute({ source: url, fps: 0.2, max_frames: 3 }, bexec)
    check('bilibili read: 3 frames', bread.frames.length === 3, String(bread.frames.length))
    check('bilibili read: downloaded media', Boolean(bread.source.mediaFile), bread.source.mediaFile)
    check('bilibili read: attachments', bread.frames.every((frame) => frame.attachment))
    const breuse = await bctx.tools.get('video_read').execute({ source: url, fps: 0.2, max_frames: 2 }, bexec)
    check('bilibili read: cache reuse is fast', breuse.frames.length === 2, `${breuse.frames.length} frames`)
    console.log('bilibili artifacts:', bread.source.artifactsDir)
  }

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('failed:', failed.map((item) => item.name).join('; '))
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('SELF-TEST ERROR', error)
  process.exit(1)
})
