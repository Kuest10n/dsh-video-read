/**
 * Run progress + persisted user settings shared by the capture pipeline and the
 * settings panel.
 *
 * Progress is one small, throttled JSON file under the cache root, so the
 * browser half can poll it over HTTP without a stream protocol and without the
 * host keeping per-run state in memory. The API is handle-based: `startRun`
 * returns a handle that `updateRun`/`finishRun` must present, so a stale run
 * can never overwrite the snapshot of a newer one.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const WRITE_INTERVAL_MS = 400

/** Effective cache root: plugin option, else the per-user default. */
export function cacheRoot(cfg = {}) {
  const configured = typeof cfg?.cacheDir === 'string' ? cfg.cacheDir.trim() : ''
  if (configured) return configured
  return join(homedir(), '.dsh', 'cache', 'dsh-video-read')
}

/** Path of the panel-written user settings layer. */
export function settingsPath(cfg = {}) {
  return join(cacheRoot(cfg), 'settings.json')
}

/** Path of the latest run progress snapshot. */
export function progressPath(cfg = {}) {
  return join(cacheRoot(cfg), 'progress.json')
}

/** Read one JSON file, returning null for a missing or malformed file. */
export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** One in-flight run handle; only the newest run is ever written. */
let active = null
let timer = null

function flush(immediate) {
  if (!active) return
  const write = () => {
    timer = null
    const run = active
    if (!run) return
    run.value.updatedAt = new Date().toISOString()
    try {
      mkdirSync(run.dir, { recursive: true })
      const target = join(run.dir, 'progress.json')
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
      writeFileSync(tmp, JSON.stringify(run.value, null, 2), { flag: 'wx' })
      try {
        renameSync(tmp, target)
      } catch (error) {
        try { rmSync(tmp, { force: true }) } catch {}
        throw error
      }
    } catch {}
  }
  if (immediate) {
    if (timer) clearTimeout(timer)
    timer = null
    write()
    return
  }
  if (timer) return
  timer = setTimeout(write, WRITE_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
}

/**
 * Start one run and publish its first snapshot.
 * @returns {{runId: string, dir: string}|null}
 */
export function startRun({ cfg, source, artifactsDir = null, mode = 'even', maxFrames = null, title = null } = {}) {
  const dir = cacheRoot(cfg)
  const now = new Date().toISOString()
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  active = {
    dir,
    value: {
      runId,
      source: String(source ?? '').slice(0, 300),
      title: title ? String(title).slice(0, 160) : null,
      mode,
      maxFrames,
      artifactsDir,
      phase: 'starting',
      detail: null,
      bytes: 0,
      totalBytes: null,
      frames: 0,
      startedAt: now,
      finishedAt: null,
      done: false,
      error: null,
      errorCode: null,
      updatedAt: now,
    },
  }
  flush(true)
  return { runId, dir }
}

/** A fresh handle for the currently active run, or null when no run is active. */
export function currentRun() {
  return active ? { runId: active.value.runId, dir: active.dir } : null
}

/** True when `handle` still identifies the active run. */
function owns(handle) {
  return Boolean(active && handle && active.value.runId === handle.runId)
}

/** Advance the phase, optionally with a short human detail or counters. */
export function updateRun(handle, phase, patch = {}) {
  if (!owns(handle)) return
  const value = active.value
  if (typeof phase === 'string' && phase) value.phase = phase
  if (patch && typeof patch === 'object') {
    if (patch.detail !== undefined) value.detail = patch.detail
    if (patch.artifactsDir) value.artifactsDir = patch.artifactsDir
    if (typeof patch.bytes === 'number') value.bytes = patch.bytes
    if (typeof patch.totalBytes === 'number' && patch.totalBytes > 0) value.totalBytes = patch.totalBytes
    if (typeof patch.frames === 'number') value.frames = patch.frames
  }
  flush(phase === 'done' || phase === 'error')
}

/**
 * Report streamed download bytes (called from the shared download helper).
 * Accepts a run handle as the first argument, or the legacy (bytes, total)
 * shape for callers that have not been migrated. A handle must still own the
 * active run, so a slow download from a previous run cannot clobber a new one.
 */
export function noteBytes(handleOrReceived, totalOrReceived, legacyTotal) {
  // `null` is the no-active-run handle from currentRun(); treating it as a
  // handle (not as a numeric byte count) is what makes noteBytes(null, 0, n)
  // a no-op instead of accidentally reporting into a newer run.
  const hasHandle = typeof handleOrReceived === 'object'
  const handle = hasHandle ? handleOrReceived : currentRun()
  const received = hasHandle ? totalOrReceived : handleOrReceived
  const totalBytes = hasHandle ? legacyTotal : totalOrReceived
  if (!owns(handle) || !Number.isFinite(received)) return
  active.value.bytes = received
  if (typeof totalBytes === 'number' && totalBytes > 0) active.value.totalBytes = totalBytes
  flush(false)
}

/** Close the run identified by `handle`; an error marks a failed run. */
export function finishRun(handle, { ok = true, error = null, frames = null, artifactsDir = null } = {}) {
  if (!owns(handle)) return
  const value = active.value
  value.phase = ok ? 'done' : 'error'
  value.done = true
  value.error = ok ? null : String(error?.message ?? error ?? 'unknown error')
  value.errorCode = ok ? null : String(error?.code ?? '') || null
  if (typeof frames === 'number') value.frames = frames
  if (artifactsDir) value.artifactsDir = artifactsDir
  value.finishedAt = new Date().toISOString()
  flush(true)
  active = null
}

/** Read the persisted user settings layer (never throws). */
export function readSettings(cfg = {}) {
  const value = readJsonFile(settingsPath(cfg))
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Invalidate the cached settings snapshot so the next read hits the disk. */
export function invalidateSettingsCache() {
  settingsMemo = { at: 0, value: null }
}

let settingsMemo = { at: 0, value: null }
const SETTINGS_MEMO_MS = 5_000

/**
 * Read the persisted user settings layer with a short process-local memo.
 * Panel GETs hit this on every poll; the settings file changes rarely, so a
 * 5s memo removes the per-poll disk read without observable staleness.
 */
export function readSettingsMemo(cfg = {}) {
  const now = Date.now()
  if (settingsMemo.value && now - settingsMemo.at < SETTINGS_MEMO_MS) return settingsMemo.value
  const value = readSettings(cfg)
  settingsMemo = { at: now, value }
  return value
}

/**
 * Merge a patch into the persisted user settings layer and return the result.
 * The whole read-merge-write runs synchronously, so concurrent callers in this
 * process cannot interleave; cross-process writers are protected by a UUID temp
 * name plus an exclusive ('wx') create, so two writers can never share a temp
 * file and atomically replace each other's content.
 */
export function persistSettings(cfg = {}, patch = {}) {
  const next = { ...readSettings(cfg), ...patch }
  mkdirSync(cacheRoot(cfg), { recursive: true })
  const target = settingsPath(cfg)
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx' })
  try {
    renameSync(tmp, target)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch {}
    throw error
  }
  invalidateSettingsCache()
  return next
}
