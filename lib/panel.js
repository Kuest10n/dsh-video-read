/**
 * Same-origin JSON routes behind the settings panel (lib/client.js).
 *
 * The panel is deliberately plain HTTP + a hand-written client bundle, so the
 * plugin keeps needing no build step: the host registers two routes on the Web
 * carrier (read state, write the user settings layer) and the browser polls them.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { cacheStatus, pruneCache } from './cache.js'
import {
  cacheRoot,
  persistSettings,
  progressPath,
  readJsonFile,
  readSettings,
  readSettingsMemo,
  settingsPath,
} from './progress.js'

const PANEL_PATH = '/api/dsh-video-read/panel'
const CONFIG_PATH = '/api/dsh-video-read/config'
const CACHE_PATH = '/api/dsh-video-read/cache'
const MAX_BODY_BYTES = 64 * 1024
const CAPTION_MODEL_MEMO_MS = 30_000
const MODEL_PROVIDER_TIMEOUT_MS = 4_000

/** Compact, reversible encoding for a provider/model pair in <option value>. */
export function encodeCaptionRoute(provider, model) {
  return JSON.stringify([String(provider ?? ''), String(model ?? '')])
}

export function decodeCaptionRoute(value) {
  try {
    const parsed = JSON.parse(String(value ?? ''))
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return { provider: parsed[0], model: parsed[1] }
    }
  } catch {}
  return null
}

function llmRuntimeFrom(input) {
  const candidates = []
  if (input && typeof input.get === 'function') {
    try { candidates.push(input.get('llm')) } catch {}
  }
  // Cordis exposes injected services as accessors on a proxy Context. Reading
  // `.llm` can itself throw "without inject" on a derived web carrier that
  // was not composed with the llm service, so keep this probe isolated too.
  try { if (input?.llm) candidates.push(input.llm) } catch {}
  candidates.push(input)
  for (const candidate of candidates) {
    try {
      if (candidate && typeof candidate.listProviders === 'function' && typeof candidate.listModels === 'function') return candidate
    } catch {}
  }
  return null
}

async function withDeadline(promise, timeoutMs) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`model enumeration timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([Promise.resolve(promise), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function emptyCaptionModelCatalog(note) {
  return {
    generatedAt: new Date().toISOString(),
    source: 'llm.listProviders/listModels',
    note,
    count: 0,
    items: [],
    groups: [],
  }
}

let captionModelMemo = { key: '', at: 0, value: null, pending: null }

/** Invalidate the model list after the Host registers or reloads adapters. */
export function invalidateCaptionModelsMemo() {
  captionModelMemo = { key: '', at: 0, value: null, pending: null }
}

function buildCaptionModelGroups(items) {
  const groups = new Map()
  for (const item of items) {
    let group = groups.get(item.provider)
    if (!group) {
      group = { provider: item.provider, providerName: item.providerName, models: [] }
      groups.set(item.provider, group)
    }
    group.models.push(item)
  }
  return [...groups.values()].sort((a, b) => a.providerName.localeCompare(b.providerName))
}

/**
 * Enumerate locally registered LLM models that explicitly declare image input.
 * The Client model catalog drops inputModalities, so the Host half must ask the
 * llm service directly. Each provider is isolated and memoized: the settings
 * panel polls every 2–15s, but adapter enumeration is comparatively expensive.
 */
export async function captionModelCatalog(input) {
  const llm = llmRuntimeFrom(input)
  if (!llm) return emptyCaptionModelCatalog('模型清单暂不可用：Host LLM 服务尚未就绪。')
  let providers = []
  try {
    providers = llm.listProviders().filter((provider) => provider && typeof provider.id === 'string')
  } catch (error) {
    return emptyCaptionModelCatalog(`无法读取模型提供方：${error?.message ?? error}`)
  }
  if (!providers.length) return emptyCaptionModelCatalog('尚未注册任何 LLM 提供方。')
  const key = providers.map((provider) => provider.id).sort().join('\u0000')
  const now = Date.now()
  if (captionModelMemo.value && captionModelMemo.key === key && now - captionModelMemo.at < CAPTION_MODEL_MEMO_MS) {
    return captionModelMemo.value
  }
  if (captionModelMemo.pending && captionModelMemo.key === key) return captionModelMemo.pending
  const pending = (async () => {
    const items = []
    const seen = new Set()
    await Promise.all(providers.map(async (provider) => {
      let models
      try {
        models = await withDeadline(llm.listModels(provider.id), MODEL_PROVIDER_TIMEOUT_MS)
      } catch {
        return
      }
      if (!Array.isArray(models)) return
      const providerName = String(provider.name || provider.displayName || provider.id)
      for (const model of models) {
        if (!model || typeof model !== 'object') continue
        const inputModalities = Array.isArray(model.inputModalities) ? model.inputModalities.map(String) : []
        if (!inputModalities.includes('image')) continue
        const modelProvider = String(model.provider || provider.id).trim()
        const modelId = String(model.id || model.name || '').trim()
        if (!modelProvider || !modelId) continue
        const value = encodeCaptionRoute(modelProvider, modelId)
        if (seen.has(value)) continue
        seen.add(value)
        items.push({
          provider: modelProvider,
          model: modelId,
          value,
          label: String(model.name || modelId),
          providerName,
          inputModalities,
          supportsImage: true,
        })
      }
    }))
    items.sort((a, b) => `${a.providerName}\u0000${a.label}`.localeCompare(`${b.providerName}\u0000${b.label}`))
    return {
      generatedAt: new Date().toISOString(),
      source: 'llm.listProviders/listModels',
      note: items.length ? null : '没有找到明确声明 image 输入能力的模型；可留空并改用当前图文路由。',
      count: items.length,
      items,
      groups: buildCaptionModelGroups(items),
    }
  })()
    .then((value) => {
      captionModelMemo = { key, at: Date.now(), value, pending: null }
      return value
    })
    .catch((error) => {
      captionModelMemo = { key, at: 0, value: null, pending: null }
      return emptyCaptionModelCatalog(`模型清单读取失败：${error?.message ?? error}`)
    })
  captionModelMemo = { key, at: 0, value: null, pending }
  return pending
}

function captionModelsForConfig(catalog, cfg) {
  const provider = String(cfg.captionProvider ?? '').trim()
  const model = String(cfg.captionModel ?? '').trim()
  const selected = provider && model ? encodeCaptionRoute(provider, model) : ''
  const current = provider && model ? { provider, model } : null
  if (!current || catalog.items.some((item) => item.value === selected)) {
    return { ...catalog, selected, current }
  }
  const currentItem = {
    provider,
    model,
    value: selected,
    label: model,
    providerName: '当前设置（未在实时清单中）',
    inputModalities: [],
    supportsImage: false,
    currentOnly: true,
  }
  return {
    ...catalog,
    selected,
    current,
    count: catalog.count + 1,
    items: [currentItem, ...catalog.items],
    groups: [
      { provider, providerName: currentItem.providerName, models: [currentItem] },
      ...catalog.groups,
    ],
  }
}

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
  quality: { type: 'int', min: 1, max: 51 },
  bilibiliQuality: { type: 'int', min: 16, max: 120 },
  imageWidth: { type: 'int', min: 320, max: 2560 },
  gridCellWidth: { type: 'int', min: 160, max: 640 },
  gridCellHeight: { type: 'int', min: 120, max: 480 },
  captionMaxTokens: { type: 'int', min: 64, max: 1024 },
  maxVideoMinutes: { type: 'number', min: 1, max: 600 },
  maxMediaBytes: { type: 'number', min: 1_000_000, max: 20_000_000_000 },
  cacheTtlDays: { type: 'number', min: 1, max: 3650 },
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
    const number = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== '' && !Array.isArray(raw)
        ? Number(raw)
        : NaN
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

export async function describeWorkspaceCache(cfg = {}) {
  const ttlDays = Math.max(0, Number(cfg.cacheTtlDays) || 14)
  const root = join(process.cwd(), '.video-read')
  const now = Date.now()
  if (workspaceCacheMemo.value && workspaceCacheMemo.root === root && now - workspaceCacheMemo.at < WORKSPACE_CACHE_MEMO_MS) {
    return workspaceCacheMemo.value
  }
  const cache = await cacheStatus(root, { ttlDays })
  const value = {
    ...cache,
    // The Host may serve sessions from another cwd. Never invent an arbitrary
    // scan path: no progress record means the workspace cannot be inferred.
    hint: 'Workspace cache is measured from the Host cwd. If a session uses another workspace, call video_cache there.',
  }
  workspaceCacheMemo = { root, at: now, value }
  return value
}

/** Drop the workspace-cache memo so the next read reflects a prune. */
export function invalidateWorkspaceCacheMemo() {
  workspaceCacheMemo = { root: null, at: 0, value: null }
}

let workspaceCacheMemo = { root: null, at: 0, value: null }
const WORKSPACE_CACHE_MEMO_MS = 5_000

/** Full panel state: config, cache usage, latest run progress. */
export async function panelSnapshot({ cfg = {}, version = '0.0.0', progress = null, ctx = null, llm = null } = {}) {
  const workspaceCache = await describeWorkspaceCache(cfg)
  const catalog = await captionModelCatalog(llm || ctx)
  return {
    ok: true,
    version,
    config: editableConfig(cfg),
    captionModels: captionModelsForConfig(catalog, cfg),
    routes: { panel: PANEL_PATH, config: CONFIG_PATH, cache: CACHE_PATH },
    cache: describeCache(cfg),
    workspaceCache,
    progress: progress ?? null,
    persistence: { settings: readSettingsMemo(cfg), path: settingsPath(cfg) },
    artifactsHint:
      'Frame evidence lives per workspace: <workspace>/.video-read/<slug-hash>/. The latest run path is progress.artifactsDir.',
  }
}

export async function clearStaleWorkspaceCache({ cfg = {}, dryRun = true } = {}) {
  const ttlDays = Number(cfg.cacheTtlDays)
  if (!(ttlDays > 0)) throw new Error('set cacheTtlDays to a positive number before clearing stale artifacts')
  const root = join(process.cwd(), '.video-read')
  const result = await pruneCache(root, { ttlDays, dryRun: dryRun !== false })
  if (dryRun === false) invalidateWorkspaceCacheMemo()
  return { ok: true, ...result, cache: await describeWorkspaceCache(cfg) }
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
 */
function isSameOrigin(req, { requireOrigin = false } = {}) {
  const origin = req.headers?.origin
  if (!origin) return !requireOrigin
  return isAbsoluteSameOrigin(origin, req)
}

function isAbsoluteSameOrigin(origin, req) {
  const host = req.headers?.host
  if (!host) return false
  try {
    const parsed = new URL(origin)
    return parsed.host === host && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
  } catch {
    return false
  }
}

/**
 * Write guard for mutating requests. The GUI's own embedded client can send a
 * fetch with neither an Origin header nor a usable one (opaque origin), which
 * a plain "Origin required" policy wrongly rejects — that broke saving from
 * the real settings panel. Origin-less writes are therefore accepted only on
 * signals a cross-site `mode:'no-cors'` POST cannot forge: Chromium's own
 * `Sec-Fetch-Site: same-origin`, or this plugin's custom client header, whose
 * presence would force a CORS preflight this server never answers. curl-style
 * scripts send neither signal and stay refused.
 */
function isSameOriginWrite(req) {
  const origin = req.headers?.origin
  if (origin && origin !== 'null') return isAbsoluteSameOrigin(origin, req)
  const fetchSite = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (fetchSite) return fetchSite === 'same-origin'
  return String(req.headers?.['x-dsh-video-read-client'] ?? '') === '1'
}

function isJsonRequest(req) {
  const type = String(req.headers?.['content-type'] ?? '').toLowerCase()
  return type.startsWith('application/json')
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const declared = Number(req.headers?.['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > limit) {
    try { req.destroy() } catch {}
    throw new Error(`request body exceeds ${limit} bytes`)
  }
  const chunks = []
  let total = 0
  try {
    for await (const chunk of req) {
      total += chunk.length
      if (total > limit) {
        try { req.destroy() } catch {}
        throw new Error(`request body exceeds ${limit} bytes`)
      }
      chunks.push(chunk)
    }
  } catch (error) {
    try { req.destroy() } catch {}
    throw error
  }
  if (total === 0) return ''
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Mount the panel routes on the Host web carrier (no-op when no Web carrier is
 * composed, e.g. an Electron-only profile).
 * @returns {{paths: string[], dispose: () => void}|null}
 */
export function mountPanel({ ctx, cfg = {}, version = '0.0.0', llm = null, log = () => {} } = {}) {
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
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          respondJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!isLoopbackHost(req) || !isSameOrigin(req)) {
          respondJson(res, 403, { ok: false, error: 'cross-origin request refused' })
          return
        }
        try {
          respondJson(res, 200, await panelSnapshot({ cfg, version, progress: readJsonFile(progressPath(cfg)), ctx, llm }))
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
        if (!isLoopbackHost(req) || !isSameOriginWrite(req)) {
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
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: CACHE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          respondJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const writeAllowed = req.method === 'POST' ? isSameOriginWrite(req) : isSameOrigin(req)
        if (!isLoopbackHost(req) || !writeAllowed) {
          respondJson(res, 403, { ok: false, error: 'cross-origin or origin-less request refused' })
          return
        }
        if (req.method === 'POST' && !isJsonRequest(req)) {
          respondJson(res, 415, { ok: false, error: 'content-type must be application/json' })
          return
        }
        try {
          let dryRun = true
          if (req.method === 'POST') {
            const body = await readBody(req)
            const parsed = body ? JSON.parse(body) : {}
            if (parsed?.action !== 'prune-stale') throw new Error('action must be "prune-stale"')
            // Destructive deletion requires two independent client signals:
            // explicit confirmation plus dryRun=false. No path is accepted from
            // the request; pruneCache itself enforces the .video-read root.
            if (parsed?.dryRun === false && parsed?.confirm === 'PRUNE_STALE') dryRun = false
          }
          respondJson(res, 200, await clearStaleWorkspaceCache({ cfg, dryRun }))
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
  log(`panel: mounted ${PANEL_PATH}, ${CONFIG_PATH} and ${CACHE_PATH}`)
  return { paths: [PANEL_PATH, CONFIG_PATH, CACHE_PATH], dispose }
}
