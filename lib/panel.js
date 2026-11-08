/**
 * Same-origin JSON routes behind the settings panel (lib/client.js).
 *
 * The panel is deliberately plain HTTP + a hand-written client bundle, so the
 * plugin keeps needing no build step: the host registers two routes on the Web
 * carrier (read state, write the user settings layer) and the browser polls them.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  cacheRoot,
  persistSettings,
  progressPath,
  readJsonFile,
  readSettings,
  settingsPath,
} from './progress.js'

const PANEL_PATH = '/api/dsh-video-read/panel'
const CONFIG_PATH = '/api/dsh-video-read/config'
const MAX_BODY_BYTES = 64 * 1024

/** Editable keys with type and bounds; anything else is rejected. */
const CONFIG_RULES = {
  autoDownloadFfmpeg: { type: 'boolean' },
  autoDownloadYtdlp: { type: 'boolean' },
  keepSource: { type: 'boolean' },
  pruneArtifacts: { type: 'boolean' },
  burnTimestamps: { type: 'boolean' },
  maxFrames: { type: 'int', min: 1, max: 32 },
  maxAttachImages: { type: 'int', min: 1, max: 20 },
  maxCaptionFrames: { type: 'int', min: 1, max: 8 },
  maxShots: { type: 'int', min: 1, max: 20 },
  maxDigestSegments: { type: 'int', min: 1, max: 50 },
  digestSegmentSeconds: { type: 'int', min: 10, max: 3600 },
  quality: { type: 'int', min: 16, max: 120 },
  imageWidth: { type: 'int', min: 320, max: 2560 },
  gridCellWidth: { type: 'int', min: 160, max: 640 },
  gridCellHeight: { type: 'int', min: 120, max: 480 },
  captionMaxTokens: { type: 'int', min: 64, max: 2048 },
  maxVideoMinutes: { type: 'number', min: 1, max: 600 },
  maxMediaBytes: { type: 'number', min: 1_000_000, max: 20_000_000_000 },
  cacheTtlDays: { type: 'number', min: 0, max: 3650 },
  sceneThreshold: { type: 'number', min: 0.05, max: 0.95 },
  // cookieFile / ytdlpPath are intentionally NOT editable from the web panel:
  // a saved path is later spawned or read, so exposing it would turn a config
  // write into code execution / local-file exfiltration. Set them in the
  // bundle patch (cordis.patch.yml) or settings.json by hand instead.
  captionProvider: { type: 'string', maxLength: 200 },
  captionModel: { type: 'string', maxLength: 200 },
}

/** Project the live config onto the editable subset. */
export function editableConfig(cfg = {}) {
  const value = {}
  for (const key of Object.keys(CONFIG_RULES)) value[key] = cfg[key]
  return value
}

/**
 * Validate and coerce one user-supplied config patch.
 * @returns {{ok: boolean, patch: object, errors: string[], ignored: string[]}}
 */
export function sanitizeConfigPatch(patch, previous = {}) {
  const errors = []
  const ignored = []
  const clean = {}
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, patch: {}, errors: ['config must be a JSON object'], ignored }
  }
  for (const [key, raw] of Object.entries(patch)) {
    const rule = CONFIG_RULES[key]
    if (!rule) {
      ignored.push(key)
      continue
    }
    if (rule.type === 'boolean') {
      if (typeof raw !== 'boolean') errors.push(`${key} must be a boolean`)
      else clean[key] = raw
      continue
    }
    if (rule.type === 'string') {
      if (typeof raw !== 'string') {
        errors.push(`${key} must be a string`)
        continue
      }
      if (raw.length > rule.maxLength) {
        errors.push(`${key} is longer than ${rule.maxLength} characters`)
        continue
      }
      clean[key] = raw.trim()
      continue
    }
    const number = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(number)) {
      errors.push(`${key} must be a finite number`)
      continue
    }
    if (rule.type === 'int' && !Number.isInteger(number)) {
      errors.push(`${key} must be an integer`)
      continue
    }
    if (number < rule.min || number > rule.max) {
      errors.push(`${key} must be between ${rule.min} and ${rule.max}`)
      continue
    }
    clean[key] = number
  }
  if (Object.keys(clean).length === 0 && errors.length === 0) {
    errors.push(`no editable keys supplied (allowed: ${Object.keys(CONFIG_RULES).join(', ')})`)
  }
  // `previous` is accepted for future cross-field validation; keep the call shape stable.
  void previous
  return { ok: errors.length === 0, patch: clean, errors, ignored }
}

function directoryBytes(dir, budget = { entries: 0, bytes: 0 }) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return budget
  }
  for (const entry of entries) {
    if (budget.entries > 5000) return budget
    budget.entries += 1
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      directoryBytes(full, budget)
      continue
    }
    if (entry.isFile()) {
      try {
        budget.bytes += statSync(full).size
      } catch {}
    }
  }
  return budget
}

/** Describe the cache root as rows the panel can render (5s memo). */
let cacheMemo = { root: null, at: 0, value: null }
const CACHE_MEMO_MS = 5_000

export function describeCache(cfg = {}) {
  const root = cacheRoot(cfg)
  const now = Date.now()
  if (cacheMemo.value && cacheMemo.root === root && now - cacheMemo.at < CACHE_MEMO_MS) return cacheMemo.value
  const dirs = []
  let totalBytes = 0
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(root, entry.name)
      const budget = directoryBytes(full)
      const stat = statSync(full)
      dirs.push({ name: entry.name, bytes: budget.bytes, updatedAt: new Date(stat.mtimeMs).toISOString() })
      totalBytes += budget.bytes
    }
  } catch {}
  dirs.sort((a, b) => b.bytes - a.bytes)
  const value = {
    root,
    exists: dirs.length > 0,
    dirCount: dirs.length,
    totalBytes,
    dirs: dirs.slice(0, 8),
    settingsPath: settingsPath(cfg),
    progressPath: progressPath(cfg),
  }
  cacheMemo = { root, at: now, value }
  return value
}

/** Full panel state: config, cache usage, latest run progress. */
export function panelSnapshot({ cfg = {}, version = '0.0.0', progress = null } = {}) {
  return {
    ok: true,
    version,
    config: editableConfig(cfg),
    routes: { panel: PANEL_PATH, config: CONFIG_PATH },
    cache: describeCache(cfg),
    progress: progress ?? null,
    persistence: { settings: readSettings(cfg), path: settingsPath(cfg) },
    artifactsHint:
      'Frame evidence lives per workspace: <workspace>/.video-read/<slug-hash>/. The latest run path is progress.artifactsDir.',
  }
}

function respondJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * The panel is a local control surface: only loopback Host headers are served.
 * A rebinding attack sends the attacker's domain as Host, which fails here even
 * when the socket really points at 127.0.0.1.
 */
function isLoopbackHost(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  if (!host) return false
  const bare = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')
  return bare === '127.0.0.1' || bare === '[::1]' || bare === 'localhost'
}

/**
 * Same-origin guard. Browsers attach `Origin` to POST (and to cross-site GET);
 * a page on another site must not be able to rewrite this plugin's settings.
 * Mutating requests require an explicit Origin so origin-less clients (curl,
 * LAN scripts) cannot POST just because they omit the header.
 */
function isSameOrigin(req, { requireOrigin = false } = {}) {
  const origin = req.headers?.origin
  if (!origin) return !requireOrigin
  const host = req.headers?.host
  if (!host) return false
  try {
    const parsed = new URL(origin)
    return parsed.host === host && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
  } catch {
    return false
  }
}

function isJsonRequest(req) {
  const type = String(req.headers?.['content-type'] ?? '').toLowerCase()
  return type.startsWith('application/json')
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error(`request body exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  if (total === 0) return ''
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Mount the panel routes on the Host web carrier (no-op when no Web carrier is
 * composed, e.g. an Electron-only profile).
 * @returns {{paths: string[], dispose: () => void}|null}
 */
export function mountPanel({ ctx, cfg = {}, version = '0.0.0', log = () => {} } = {}) {
  const webServer = ctx?.get?.('webServer')
  if (!webServer?.register) {
    log('panel: no web server in this composition; routes not mounted')
    return null
  }
  const disposers = []
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: PANEL_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          respondJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!isLoopbackHost(req) || !isSameOrigin(req)) {
          respondJson(res, 403, { ok: false, error: 'cross-origin request refused' })
          return
        }
        try {
          respondJson(res, 200, panelSnapshot({ cfg, version, progress: readJsonFile(progressPath(cfg)) }))
        } catch (error) {
          respondJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
  )
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          respondJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!isLoopbackHost(req) || !isSameOrigin(req, { requireOrigin: true })) {
          respondJson(res, 403, { ok: false, error: 'cross-origin or origin-less write refused' })
          return
        }
        if (!isJsonRequest(req)) {
          respondJson(res, 415, { ok: false, error: 'content-type must be application/json' })
          return
        }
        try {
          const body = await readBody(req)
          const parsed = body ? JSON.parse(body) : {}
          const result = sanitizeConfigPatch(parsed?.config ?? parsed, cfg)
          if (!result.ok) {
            respondJson(res, result.errors.length ? 400 : 422, {
              ok: false,
              errors: result.errors,
              ignored: result.ignored,
            })
            return
          }
          const persisted = persistSettings(cfg, result.patch)
          Object.assign(cfg, result.patch)
          log(`panel: saved ${Object.keys(result.patch).join(', ')}`)
          respondJson(res, 200, {
            ok: true,
            saved: result.patch,
            ignored: result.ignored,
            config: editableConfig(cfg),
            persistence: { settings: persisted, path: settingsPath(cfg) },
          })
        } catch (error) {
          respondJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
  )
  const dispose = () => {
    for (const remove of disposers) {
      try {
        remove()
      } catch {}
    }
  }
  try {
    ctx.effect?.(() => dispose)
  } catch {}
  log(`panel: mounted ${PANEL_PATH} and ${CONFIG_PATH}`)
  return { paths: [PANEL_PATH, CONFIG_PATH], dispose }
}
