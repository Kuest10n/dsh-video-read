// Quick smoke test for the M1.5/M2/M3 pure functions (no network, no ffmpeg).
import { parseDanmakuXml } from '../lib/danmaku.js'
import { buildSegments, renderDigestText } from '../lib/digest.js'
import { rankEvidence } from '../lib/ask.js'
import { assertShotCdnUrl, pickShotIndices, spriteStripName, assertJpegStrip } from '../lib/shots.js'
import { parseYtdlpJson, ytdlpCandidates } from '../lib/youtube.js'
import { planSampleTimes } from '../lib/frames.js'
import { buildStoryboard } from '../lib/storyboard.js'
import { planGridCells } from '../lib/grid.js'
import { cacheStatus, pruneCache } from '../lib/cache.js'
import { editableConfig, mountPanel, sanitizeConfigPatch } from '../lib/panel.js'
import { assertPublicHttpUrl, assertPublicUrlResolvesPublicly, directMediaExtension, isPrivateAddress, prepareArtifactsBase } from '../lib/sources.js'
import { assertBilibiliCdnUrl } from '../lib/bilibili.js'
import { fetchWithDeadline } from '../lib/net.js'
import { parseBlackIntervals } from '../lib/edges.js'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, stat, writeFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`ok   ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name} ${detail}`)
  }
}

// 1. danmaku XML parsing
const xml = `<?xml version="1.0" encoding="UTF-8"?><i><d p="1.5,1,25,16777215,1,0,0,x">草鞋&lt;3</d><d p="3.2,1,25,16777215,1,0,0,x">破旧的草鞋</d></i>`
const dm = parseDanmakuXml(xml)
check('danmaku count', dm.count === 2, `count=${dm.count}`)
check('danmaku time', Math.abs(dm.lines[0].time - 1.5) < 1e-9, `t=${dm.lines[0]?.time}`)
check('danmaku entity', dm.lines[0].text.includes('草鞋<3'), dm.lines[0]?.text)

// 2. digest segmentation
const cues = Array.from({ length: 61 }, (_, i) => ({ from: i * 10, to: i * 10 + 6, text: `第${i}段 草鞋 故事` }))
const built = buildSegments({ cues, danmaku: [], startSec: 0, endSec: 600, segmentSeconds: 120, maxSegments: 6 })
check('digest segments <= max', built.segments.length <= 6, `segments=${built.segments.length}`)
check('digest covered', built.segments.at(-1).end >= 599, `last=${built.segments.at(-1)?.end}`)
const text = renderDigestText({ source: { title: 'T', kind: 'local', durationLabel: '10:00' }, segments: built.segments, segmentSeconds: built.segmentSeconds, totalCues: built.totalCues, totalDanmaku: 0, notes: [] })
check('digest text', text.includes('草鞋') && /0[01]:/.test(text), text.slice(0, 80))

// 3. retrieval ranking
const hit = cues.map((cue, i) => ({ ...cue, from: i * 10, text: i === 42 ? '这双破旧的草鞋' : `无关台词 ${i}` }))
const ranked = rankEvidence({ question: '破旧草鞋', cues: hit, danmaku: [], limit: 5 })
check('ask top hit', ranked.items[0]?.text.includes('草鞋'), ranked.items[0]?.text)
check('ask matched tokens', ranked.items[0]?.matched?.length > 0, JSON.stringify(ranked.items[0]?.matched))

// 4. videoshot tile picking
const shots = { times: [0, 5, 10, 15, 20, 25], xLen: 10, yLen: 10, xSize: 480, ySize: 270 }
const picks = pickShotIndices({ shots, start: 0, end: 60, max: 2 })
check('shots picks count', picks.length === 2, JSON.stringify(picks))
check('shots picks ascending', picks[0].time < picks[1].time, JSON.stringify(picks))

// 5. yt-dlp metadata JSON (raw `yt-dlp -J` payload)
const parsed = parseYtdlpJson(JSON.stringify({ id: 'abc123', title: 'Demo', duration: 12.5, webpage_url: 'https://youtu.be/abc123' }))
check('ytdlp title', parsed.title === 'Demo', parsed.title)
check('ytdlp id', parsed.id === 'abc123', parsed.id)
check('ytdlp duration', Math.abs(parsed.duration - 12.5) < 1e-9, parsed.duration)
check('ytdlp candidates', ytdlpCandidates({}).includes('yt-dlp.exe'), JSON.stringify(ytdlpCandidates({})))

// 6. even sampling at the video end
const plan = planSampleTimes({ durationSec: 60, start: 0, end: 60, mode: 'even', fps: 1, maxFrames: 2 })
check('even plan array', Array.isArray(plan.times) && plan.times.length > 0, JSON.stringify(plan))

// 7. storyboard view (pure)
const sbValue = {
  frames: [
    { time: 0, timeLabel: '00:00.0', subtitle: '开场', path: 'a.jpg', bytes: 10 },
    { time: 5.5, timeLabel: '00:05.5', subtitle: null, caption: '画面B', path: 'b.jpg', bytes: 20 },
  ],
  sampling: { range: { start: 0, end: 10 } },
}
const sb = buildStoryboard(sbValue)
check('storyboard count', sb.sceneCount === 2, JSON.stringify(sb.sceneCount))
check('storyboard last end', sb.scenes[1].end === 10, JSON.stringify(sb.scenes[1].end))
check('storyboard label', sb.scenes[1].startLabel === '00:05.5', sb.scenes[1].startLabel)
check('storyboard text', sb.text.includes('第2镜') && sb.text.includes('画面B'), sb.text.slice(0, 120))

// 8. cache accounting + prune guard
const tmp = await mkdtemp(join(tmpdir(), 'vrcache-'))
const root = join(tmp, '.video-read')
await mkdir(join(root, 'a'), { recursive: true })
await writeFile(join(root, 'a', 'x.bin'), Buffer.alloc(2048))
const old = new Date(Date.now() - 3 * 86_400_000)
await utimes(join(root, 'a'), old, old)
// cacheStatus uses the newest mtime in the whole source tree, so the child
// artifact must be old too; otherwise an active frames/<runId>/ write would
// (correctly) keep the directory fresh and this stale fixture would not prune.
await utimes(join(root, 'a', 'x.bin'), old, old)
await mkdir(join(root, 'b'), { recursive: true })
await writeFile(join(root, 'b', 'y.bin'), Buffer.alloc(1024))
const st = await cacheStatus(root, { ttlDays: 1 })
check('cache dirs', st.exists && st.dirCount === 2, JSON.stringify({ exists: st.exists, count: st.dirCount }))
check('cache stale bytes', st.staleBytes === 2048, JSON.stringify(st.staleBytes))
const dry = await pruneCache(root, { ttlDays: 1, dryRun: true })
check('cache dry run', dry.removedCount === 1 && dry.removedBytes === 2048, JSON.stringify(dry))
const pruned = await pruneCache(root, { ttlDays: 1 })
check('cache prune', pruned.removedCount === 1 && (await cacheStatus(root, { ttlDays: 1 })).dirCount === 1)
let guard = false
try {
  await pruneCache(tmp, { ttlDays: 1 })
} catch {
  guard = true
}
check('cache prune guard', guard)
await rm(tmp, { recursive: true, force: true })

// 8b. prepareArtifactsBase must not delete a source directory whose root is
// old but whose frames/<runId>/ artifacts were just written.
const cleanTmp = await mkdtemp(join(tmpdir(), 'vrartifacts-'))
const cleanRoot = join(cleanTmp, '.video-read')
const oldRoot = join(cleanRoot, 'active-source')
const staleRoot = join(cleanRoot, 'stale-source')
await mkdir(join(oldRoot, 'frames', 'run-1'), { recursive: true })
await mkdir(staleRoot, { recursive: true })
await writeFile(join(oldRoot, 'frames', 'run-1', 'frame.jpg'), Buffer.alloc(1024))
await writeFile(join(staleRoot, 'source.mp4'), Buffer.alloc(1024))
const staleTime = new Date(Date.now() - 3 * 86_400_000)
await utimes(oldRoot, staleTime, staleTime)
await utimes(join(oldRoot, 'frames'), staleTime, staleTime)
await utimes(join(oldRoot, 'frames', 'run-1'), staleTime, staleTime)
await utimes(staleRoot, staleTime, staleTime)
await utimes(join(staleRoot, 'source.mp4'), staleTime, staleTime)
await prepareArtifactsBase(cleanTmp, { cacheTtlDays: 1 })
let activeKept = false
let staleDeleted = false
try {
  await stat(oldRoot)
  activeKept = true
} catch {}
try {
  await stat(staleRoot)
} catch {
  staleDeleted = true
}
check('artifact prune keeps active frames tree', activeKept, oldRoot)
check('artifact prune removes fully stale tree', staleDeleted, staleRoot)
await rm(cleanTmp, { recursive: true, force: true })

// 9. contact-sheet grid planning
const g16 = planGridCells(16)
check('grid 16 -> 4x4', g16.cols === 4 && g16.rows === 4 && g16.cells === 16, JSON.stringify(g16))
const g10 = planGridCells(10)
check('grid 10 -> 4x3', g10.cols === 4 && g10.rows === 3, JSON.stringify(g10))
const g1 = planGridCells(1)
check('grid 1 -> 1x1', g1.cols === 1 && g1.rows === 1, JSON.stringify(g1))
const g34 = planGridCells(34)
check('grid max cols', g34.cols === 4 && g34.rows === 9, JSON.stringify(g34))

// 10. settings-panel config validation (lib/panel.js)
// cookieFile / ytdlpPath are deliberately NOT panel-editable (they would turn a
// config write into code execution / file exfiltration), so they must be ignored.
const good = sanitizeConfigPatch({ maxFrames: '24', keepSource: false, cookieFile: 'C:\\c.json', ytdlpPath: 'C:\\y.exe', unknownKey: 1 })
check('panel patch ok', good.ok && good.patch.maxFrames === 24 && good.patch.keepSource === false && good.patch.cookieFile === undefined, JSON.stringify(good))
check('panel patch ignored', good.ignored.length === 3 && good.ignored.includes('cookieFile') && good.ignored.includes('ytdlpPath') && good.ignored.includes('unknownKey'), JSON.stringify(good.ignored))
const bad = sanitizeConfigPatch({ maxFrames: 999, quality: 'abc', autoDownloadFfmpeg: 'yes' })
check('panel patch rejects', !bad.ok && bad.errors.length === 3, JSON.stringify(bad.errors))
const empty = sanitizeConfigPatch({})
check('panel patch empty', !empty.ok, JSON.stringify(empty.errors))
const projected = editableConfig({ autoDownloadFfmpeg: true, maxFrames: 32, cookieFile: 'x', nested: { a: 1 } })
check('panel config projection', projected.autoDownloadFfmpeg === true && projected.maxFrames === 32 && projected.nested === undefined, JSON.stringify(projected))
const ytdlpPatch = sanitizeConfigPatch({ autoDownloadYtdlp: false })
check('panel ytdlp toggle', ytdlpPatch.ok && ytdlpPatch.patch.autoDownloadYtdlp === false, JSON.stringify(ytdlpPatch))
check('panel config ytdlp projection', editableConfig({ autoDownloadYtdlp: true }).autoDownloadYtdlp === true)

// 10b. panel mount depends on the Web carrier: with one it mounts both exact
// routes, without one it is a no-op (the tools keep working).
const registeredRoutes = []
const fakeWebCtx = {
  get: (name) =>
    name === 'webServer'
      ? {
          register: (spec) => {
            registeredRoutes.push(spec.path)
            return () => {}
          },
        }
      : undefined,
}
const mounted = mountPanel({ ctx: fakeWebCtx, cfg: {}, version: 'test' })
check('panel mounts all routes', mounted && mounted.paths.length === 3 && registeredRoutes.length === 3, JSON.stringify(registeredRoutes))
mounted.dispose()
check('panel mount is a no-op without a web carrier', mountPanel({ ctx: { get: () => undefined }, cfg: {} }) === null)

// 11. generic web fallback URL guard (lib/sources.js)
let publicOk = true
try {
  assertPublicHttpUrl('https://www.example.com/video/123')
} catch (error) {
  publicOk = false
}
check('url allows public host', publicOk)
const rejectedUrls = ['http://localhost:8080/x', 'http://127.0.0.1/x', 'http://192.168.1.5/x', 'http://169.254.1.1/x', 'ftp://example.com/x']
let rejectedCount = 0
for (const candidate of rejectedUrls) {
  try {
    assertPublicHttpUrl(candidate)
  } catch {
    rejectedCount += 1
  }
}
check('url rejects local/private', rejectedCount === rejectedUrls.length, `rejected=${rejectedCount}/${rejectedUrls.length}`)

// 12. direct media URL fast path (lib/sources.js)
check('direct mp4 detected', directMediaExtension('https://cdn.example.com/a/b/clip.mp4?token=x') === '.mp4')
check('direct ext lowercased', directMediaExtension('https://cdn.example.com/CLIP.MP4') === '.mp4')
check('direct webm detected', directMediaExtension('https://cdn.example.com/clip.webm') === '.webm')
check('direct non-media rejected', directMediaExtension('https://example.com/watch/page.html') === null)

// 13. SSRF guards: private-address classification + DNS guard + redirect hops
check('private ipv4 loopback', isPrivateAddress('127.0.0.1') === true)
check('private ipv4 rfc1918', isPrivateAddress('10.1.2.3') === true && isPrivateAddress('192.168.0.1') === true)
check('private link-local', isPrivateAddress('169.254.1.1') === true)
check('private ipv6 loopback', isPrivateAddress('::1') === true)
check('private ipv6 ULA', isPrivateAddress('fd00::1') === true)
check('public ipv4 allowed', isPrivateAddress('8.8.8.8') === false)
check('hostname not private', isPrivateAddress('cdn.example.com') === false)

let asyncRejected = 0
for (const candidate of ['http://127.0.0.1:9/clip.mp4', 'http://localhost/clip.mp4']) {
  try {
    await assertPublicUrlResolvesPublicly(candidate)
  } catch {
    asyncRejected += 1
  }
}
check('async guard rejects private literals', asyncRejected === 2, `rejected=${asyncRejected}/2`)

// A public URL that 302-redirects into the private network must not be followed.
const hopServer = createServer((req, res) => {
  res.writeHead(302, { location: 'http://127.0.0.1:9/secret' })
  res.end()
})
await new Promise((resolve) => hopServer.listen(0, '127.0.0.1', resolve))
const hopPort = hopServer.address().port
const hopValidate = (target) => {
  if (String(target).includes('/secret')) throw new Error('refused private redirect hop')
  return new URL(target)
}
let hopBlocked = false
try {
  await fetchWithDeadline(`http://127.0.0.1:${hopPort}/start`, { validateUrl: hopValidate, timeoutMs: 5_000 })
} catch (error) {
  hopBlocked = /private redirect hop/.test(String(error?.message))
}
hopServer.close()
check('redirect hop validated', hopBlocked)

// 14. black-edge parsing (lib/edges.js)
const blackStderr =
  '[blackdetect @ 0000] black_start:0 black_end:1.500000 black_duration:1.500000\n' +
  '[blackdetect @ 0000] black_start:6.2 black_end:8.000000 black_duration:1.800000\n' +
  'frame= 80 fps=0.0 q=-0.0 size=N/A time=00:00:08.00 bitrate=N/A speed=8.9x'
const intervals = parseBlackIntervals(blackStderr)
check('blackdetect parses two intervals', intervals.length === 2, JSON.stringify(intervals))
check('blackdetect keeps start/end', Math.abs(intervals[0].start) < 1e-9 && Math.abs(intervals[0].end - 1.5) < 1e-9, JSON.stringify(intervals[0]))
check('blackdetect duration fallback', Math.abs(intervals[1].duration - 1.8) < 1e-9, String(intervals[1]?.duration))
check('blackdetect ignores logs', parseBlackIntervals('nothing to see here').length === 0)

// 15. grid planning and 20-image attachment cap (DSH per-message limit)
check('grid 64 cells -> 4x4', JSON.stringify(planGridCells(64)) === JSON.stringify({ cells: 64, cols: 4, rows: 16 }))
check('grid 3 cells -> 2x2', JSON.stringify(planGridCells(3)) === JSON.stringify({ cells: 3, cols: 2, rows: 2 }))

const baseConfig = editableConfig({})
const tooManyImages = sanitizeConfigPatch({ maxAttachImages: 32 }, baseConfig)
check('attach cap rejects 32', tooManyImages.ok === false, JSON.stringify(tooManyImages.errors))
const allowedImages = sanitizeConfigPatch({ maxAttachImages: 20 }, baseConfig)
check('attach cap allows 20', allowedImages.ok === true && allowedImages.patch?.maxAttachImages === 20, JSON.stringify(allowedImages))

// 16. videoshot sprite URL allowlist + URL-derived cache name + JPEG magic check.
let shotCdnOk = false
try {
  shotCdnOk = assertShotCdnUrl('https://i0.hdslb.com/bfs/videoshot/abc.jpg', 'test sprite').startsWith('https://')
} catch {}
check('shot CDN allows Bilibili host', shotCdnOk)
let shotPrivateBlocked = false
let shotForeignBlocked = false
try {
  assertShotCdnUrl('https://127.0.0.1/strip.jpg', 'test sprite')
} catch {
  shotPrivateBlocked = true
}
try {
  assertShotCdnUrl('https://evil.example/strip.jpg', 'test sprite')
} catch {
  shotForeignBlocked = true
}
check('shot CDN blocks private and foreign hosts', shotPrivateBlocked && shotForeignBlocked)
check('shot strip cache name includes URL hash', spriteStripName('https://i0.hdslb.com/a.jpg', 1) !== spriteStripName('https://i0.hdslb.com/b.jpg', 1))
const shotProbe = await mkdtemp(join(tmpdir(), 'vrshot-'))
const jpegProbe = join(shotProbe, 'strip.jpg')
const htmlProbe = join(shotProbe, 'strip.html')
await writeFile(jpegProbe, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
await writeFile(htmlProbe, Buffer.from('<!doctype html>', 'utf8'))
let jpegOk = false
let htmlBlocked = false
try {
  await assertJpegStrip(jpegProbe)
  jpegOk = true
} catch {}
try {
  await assertJpegStrip(htmlProbe)
} catch {
  htmlBlocked = true
}
check('shot strip JPEG magic guard', jpegOk && htmlBlocked)
await rm(shotProbe, { recursive: true, force: true })

// 17. Bilibili CDN validator is exported and rejects private/foreign hosts.
let biliCdnOk = false
let biliCdnBlocked = false
try {
  biliCdnOk = assertBilibiliCdnUrl('https://upos-sz-mirrorali.bilivideo.cn/upgcxcode/x.m4s', 'test media').startsWith('https://')
} catch {}
try {
  assertBilibiliCdnUrl('https://evil.example/x.m4s', 'test media')
} catch {
  biliCdnBlocked = true
}
check('Bilibili CDN validator exported', biliCdnOk && biliCdnBlocked)

console.log(`
${fail ? 'FAILED' : 'ALL OK'} ${pass}/${pass + fail}`)
if (fail) process.exitCode = 1
