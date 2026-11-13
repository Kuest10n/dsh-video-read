// Host-side panel route contract tests (no real Host / browser required).
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editableConfig, mountPanel, panelSnapshot, sanitizeConfigPatch } from '../lib/panel.js'

const checks = []
const ok = (name, value) => {
  assert.ok(value, name)
  checks.push(name)
}

ok('JPEG quality accepts the documented default 3', sanitizeConfigPatch({ quality: 3 }).patch.quality === 3)
ok('JPEG quality rejects the old Bilibili lower bound', sanitizeConfigPatch({ quality: 16 }).ok)
ok('Bilibili quality has its own qn setting', sanitizeConfigPatch({ bilibiliQuality: 64 }).patch.bilibiliQuality === 64)
ok('panel never exposes executable or cookie paths', !('cookieFile' in editableConfig({ cookieFile: 'C:/secret' })) && !('ytdlpPath' in editableConfig({ ytdlpPath: 'C:/tool.exe' })))

const routes = new Map()
const disposers = []
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
    return undefined
  },
  effect(callback) { disposers.push(callback()) },
}
const cfg = { cacheDir: '', cacheTtlDays: 14, quality: 3 }
const mounted = mountPanel({ ctx: context, cfg, version: '0.5.0' })
ok('panel mounts three namespaced exact routes', mounted.paths.length === 3 && routes.has('/api/dsh-video-read/cache'))

function request(path, { method = 'GET', origin = 'http://127.0.0.1:60299', contentType = 'application/json', body = null, host = '127.0.0.1:60299' } = {}) {
  let finished = false
  const req = { method, headers: { host }, [Symbol.asyncIterator]: async function * () { if (body !== null) yield Buffer.from(body) } }
  if (origin !== null) req.headers.origin = origin
  if (contentType !== null) req.headers['content-type'] = contentType
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
  const snapshot = await panelSnapshot({ cfg, version: '0.5.0' })
  ok('snapshot reports its version and no-cache workspace', snapshot.version === '0.5.0' && snapshot.workspaceCache.totalBytes === 0)
} finally {
  process.chdir(oldCwd)
  await rm(temporaryWorkspace, { recursive: true, force: true })
  mounted.dispose()
  for (const dispose of disposers) dispose()
}

console.log(`ALL OK ${checks.length}/${checks.length}`)
