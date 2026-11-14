// Host-side panel route contract tests (no real Host / browser required).
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captionModelCatalog,
  editableConfig,
  encodeCaptionRoute,
  invalidateCaptionModelsMemo,
  mountPanel,
  panelSnapshot,
  sanitizeConfigPatch,
} from '../lib/panel.js'

const checks = []
const ok = (name, value) => {
  assert.ok(value, name)
  checks.push(name)
}

ok('JPEG quality accepts the documented default 3', sanitizeConfigPatch({ quality: 3 }).patch.quality === 3)
ok('JPEG quality rejects the old Bilibili lower bound', sanitizeConfigPatch({ quality: 16 }).ok)
ok('Bilibili quality has its own qn setting', sanitizeConfigPatch({ bilibiliQuality: 64 }).patch.bilibiliQuality === 64)
ok('panel never exposes executable or cookie paths', !('cookieFile' in editableConfig({ cookieFile: 'C:/secret' })) && !('ytdlpPath' in editableConfig({ ytdlpPath: 'C:/tool.exe' })))
const captionPair = sanitizeConfigPatch({ captionProvider: 'vision-provider', captionModel: 'vision-model' })
ok('caption route saves both whitelisted provider and model keys', captionPair.ok && captionPair.patch.captionProvider === 'vision-provider' && captionPair.patch.captionModel === 'vision-model', JSON.stringify(captionPair))
ok('caption route values are encoded as a reversible pair', encodeCaptionRoute('vision-provider', 'vision-model') === '["vision-provider","vision-model"]')

const testCacheDir = await mkdtemp(join(tmpdir(), 'dsh-video-read-settings-'))
await mkdir(join(testCacheDir, 'dsh-video-read'), { recursive: true })
const routes = new Map()
const disposers = []
const llm = {
  listProviders: () => [{ id: 'vision-provider', name: 'Vision Provider' }, { id: 'text-provider', name: 'Text Provider' }],
  listModels: async (provider) => provider === 'vision-provider'
    ? [{ id: 'vision-model', name: 'Vision Model', inputModalities: ['text', 'image'] }]
    : [{ id: 'text-model', name: 'Text Model', inputModalities: ['text'] }],
}
const context = {
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) {
          routes.set(route.path, route.handler)
          return () => routes.delete(route.path)
        },
      }
    }
    if (name === 'llm') return llm
    return undefined
  },
  effect(callback) { disposers.push(callback()) },
}
const cfg = { cacheDir: join(testCacheDir, 'dsh-video-read'), cacheTtlDays: 14, quality: 3 }
const mounted = mountPanel({ ctx: context, cfg, version: '0.5.0' })
ok('panel mounts three namespaced exact routes', mounted.paths.length === 3 && routes.has('/api/dsh-video-read/cache'))

function request(path, { method = 'GET', origin = 'http://127.0.0.1:60299', contentType = 'application/json', body = null, host = '127.0.0.1:60299', fetchSite = null, clientHeader = false } = {}) {
  let finished = false
  const req = { method, headers: { host }, [Symbol.asyncIterator]: async function * () { if (body !== null) yield Buffer.from(body) } }
  if (origin !== null) req.headers.origin = origin
  if (contentType !== null) req.headers['content-type'] = contentType
  if (fetchSite !== null) req.headers['sec-fetch-site'] = fetchSite
  if (clientHeader) req.headers['x-dsh-video-read-client'] = '1'
  const result = new Promise((resolve, reject) => {
    var _res = {
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(payload) { finished = true; resolve({ status: this.status, headers: this.headers, body: JSON.parse(payload) }) },
    }
    Promise.resolve(routes.get(path)(req, _res)).catch(reject)
  })
  return result.then((response) => {
    ok(`${method} ${path} responds`, finished)
    return response
  })
}

const hostile = await request('/api/dsh-video-read/config', { method: 'POST', origin: 'https://evil.example', body: '{"maxFrames":2}' })
ok('cross-origin config write is refused', hostile.status === 403)
const barePost = await request('/api/dsh-video-read/config', { method: 'POST', origin: null, body: '{"maxFrames":9999}' })
ok('origin-less write without any signal is refused', barePost.status === 403)
const fetchSitePost = await request('/api/dsh-video-read/config', { method: 'POST', origin: null, fetchSite: 'same-origin', body: '{"maxFrames":32}' })
ok('origin-less write with Sec-Fetch-Site same-origin is accepted (the GUI path)', fetchSitePost.status === 200 && fetchSitePost.body.ok === true)
const clientPost = await request('/api/dsh-video-read/config', { method: 'POST', origin: null, clientHeader: true, body: '{"maxFrames":32}' })
ok('origin-less write with the client marker header is accepted', clientPost.status === 200 && clientPost.body.ok === true)
const crossSiteFetchPost = await request('/api/dsh-video-read/config', { method: 'POST', origin: null, fetchSite: 'cross-site', body: '{"maxFrames":8}' })
ok('origin-less write claiming cross-site fetch is refused', crossSiteFetchPost.status === 403)
const textPost = await request('/api/dsh-video-read/config', { method: 'POST', contentType: 'text/plain', body: '{"maxFrames":2}' })
ok('non-JSON config write is refused', textPost.status === 415)
const rebound = await request('/api/dsh-video-read/panel', { host: 'evil.example' })
ok('Host-header rebinding is refused', rebound.status === 403)

const oldCwd = process.cwd()
const temporaryWorkspace = await mkdtemp(join(tmpdir(), 'dsh-video-read-panel-'))
process.chdir(temporaryWorkspace)
try {
  const dry = await request('/api/dsh-video-read/cache', { method: 'POST', body: '{"action":"prune-stale","dryRun":true}' })
  ok('cache cleanup defaults to dry-run', dry.status === 200 && dry.body.dryRun === true)
  const unconfirmed = await request('/api/dsh-video-read/cache', { method: 'POST', body: '{"action":"prune-stale","dryRun":false}' })
  ok('destructive cache cleanup requires explicit confirmation', unconfirmed.status === 200 && unconfirmed.body.dryRun === true)
  const confirmed = await request('/api/dsh-video-read/cache', { method: 'POST', body: '{"action":"prune-stale","dryRun":false,"confirm":"PRUNE_STALE"}' })
  ok('confirmed cache cleanup uses the guarded workspace root', confirmed.status === 200 && confirmed.body.dryRun === false && confirmed.body.rootDir === join(temporaryWorkspace, '.video-read'))
  const panel = await request('/api/dsh-video-read/panel')
  ok('panel snapshot separates global and workspace caches', panel.status === 200 && panel.body.cache && panel.body.workspaceCache)
  ok('panel publishes only image-capable caption models in grouped options',
    panel.body.captionModels.count === 1 &&
    panel.body.captionModels.items[0].supportsImage === true &&
    panel.body.captionModels.groups.length === 1 &&
    panel.body.captionModels.groups[0].provider === 'vision-provider',
    JSON.stringify(panel.body.captionModels))
  const staleSnapshot = await panelSnapshot({
    cfg: Object.assign({}, cfg, { captionProvider: 'old-provider', captionModel: 'old-model' }),
    version: '0.5.4',
    ctx: { llm },
  })
  ok('panel keeps an out-of-catalog saved caption route selectable',
    staleSnapshot.captionModels.current?.provider === 'old-provider' &&
    staleSnapshot.captionModels.items.some((item) => item.currentOnly && item.value === '["old-provider","old-model"]'),
    JSON.stringify(staleSnapshot.captionModels.current))
  invalidateCaptionModelsMemo()
  const catalog = await captionModelCatalog({ llm })
  ok('caption model catalog memoizes and filters text-only models', catalog.count === 1 && catalog.items.every((item) => item.supportsImage))
  const snapshot = await panelSnapshot({ cfg, version: '0.5.4', ctx: { llm } })
  ok('snapshot reports its version and no-cache workspace', snapshot.version === '0.5.4' && snapshot.workspaceCache.totalBytes === 0, JSON.stringify(snapshot.workspaceCache))
} finally {
  process.chdir(oldCwd)
  await rm(temporaryWorkspace, { recursive: true, force: true })
  await rm(testCacheDir, { recursive: true, force: true })
  mounted.dispose()
  for (const dispose of disposers) dispose()
}

console.log(`ALL OK ${checks.length}/${checks.length}`)
