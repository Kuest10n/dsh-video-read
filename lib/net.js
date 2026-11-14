/**
 * Shared HTTP helpers with hard bounds: per-attempt deadlines, idle (stall)
 * detection while streaming, byte caps, and safe partial-file cleanup.
 *
 * Every download in this plugin goes through here so a stalled or malicious
 * server can never hang a tool call or fill the disk arbitrarily. Progress of
 * the streaming download is mirrored into the run-progress record so the Web
 * panel can show a percentage (see lib/progress.js).
 */
import { randomUUID } from 'node:crypto'
import { createWriteStream, renameSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { currentRun, noteBytes } from './progress.js'

/** fetch() bounded by a total deadline and, optionally, the caller's signal.
 *
 * When `validateUrl` is supplied the request follows redirects manually and
 * calls `validateUrl(nextUrl)` for every hop, so an attacker-controlled public
 * URL cannot redirect the fetch into a private network (SSRF).
 */
export async function fetchWithDeadline(url, options = {}) {
  const {
    signal,
    timeoutMs = 30_000,
    headers,
    method = 'GET',
    body,
    redirect = 'follow',
    validateUrl = null,
  } = options
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)),
    Math.max(1_000, timeoutMs),
  )
  const onAbort = () => controller.abort(signal?.reason ?? new Error('cancelled'))
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  // Keep the caller's signal wired into the underlying fetch even after the
  // header deadline timer is cleared. downloadToFile passes its combined
  // (deadline + idle + external) signal here, so aborting that signal also
  // aborts the response body stream while it is being consumed.
  const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  const request = (target, hop) =>
    fetch(target, {
      method,
      headers,
      body: hop === 0 ? body : undefined,
      redirect: validateUrl ? 'manual' : redirect,
      signal: fetchSignal,
    })
  try {
    if (!validateUrl) return await request(url, 0)
    let current = String(url)
    const maxHops = 5
    for (let hop = 0; hop <= maxHops; hop += 1) {
      await validateUrl(current)
      const response = await request(current, hop)
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        // A redirect response's body is never consumed. Cancel it before the
        // next hop (and before the "too many redirects" throw) so the socket
        // is released instead of leaking a live, unread body.
        try { await response.body?.cancel?.() } catch {}
        if (hop === maxHops) throw new Error(`too many redirects while fetching ${url}`)
        current = new URL(location, current).href
        continue
      }
      return response
    }
    throw new Error(`too many redirects while fetching ${url}`)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Read a fetch response body as text with a byte cap, an idle timeout and a
 * total deadline. Throws (never silently truncates) when a bound is exceeded.
 * The external signal, the idle timer and the total deadline are all raced
 * against every reader.read(); the reader is cancelled on abort/cap/error.
 */
export async function readTextCapped(response, options = {}) {
  const {
    maxBytes = 8 * 1024 * 1024,
    idleTimeoutMs = 20_000,
    totalTimeoutMs = 120_000,
    signal,
  } = options
  if (!response.body) return ''

  const idleController = new AbortController()
  const totalController = new AbortController()
  const signals = [idleController.signal, totalController.signal]
  if (signal) signals.push(signal)
  const combined = AbortSignal.any(signals)

  // A total body deadline of at least idleTimeoutMs bounds slow-but-steady
  // streams that would otherwise never trip the idle guard.
  const totalMs = Math.max(1_000, Number(totalTimeoutMs) || 120_000, Number(idleTimeoutMs) || 0)
  const totalTimer = setTimeout(
    () => totalController.abort(new Error(`response body exceeded the ${totalMs}ms total deadline`)),
    totalMs,
  )
  let idleTimer = null
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => idleController.abort(new Error(`response body stalled for ${idleTimeoutMs}ms`)),
      Math.max(1_000, idleTimeoutMs),
    )
  }
  armIdle()

  const reader = response.body.getReader()
  // Racing read() against this promise means an abort cannot leave a pending
  // read() hanging; the handler also cancels the reader to unblock it.
  let rejectAbort
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject })
  // Prevent an unhandled rejection when the signal is already aborted before
  // the first Promise.race() attaches its handler.
  aborted.catch(() => {})
  const onAbort = () => {
    try { reader.cancel(combined.reason).catch(() => {}) } catch {}
    rejectAbort(combined.reason ?? new Error('cancelled'))
  }
  if (combined.aborted) onAbort()
  else combined.addEventListener('abort', onAbort, { once: true })

  const chunks = []
  let total = 0
  try {
    for (;;) {
      const step = await Promise.race([reader.read(), aborted])
      // Check the signal BEFORE `done`: an abort calls reader.cancel(), which
      // resolves the pending read as {done: true}. Treating that as a normal
      // end-of-stream would silently return truncated text.
      if (combined.aborted) throw combined.reason ?? new Error('cancelled')
      if (step.done) break
      const value = step.value
      total += value.byteLength
      if (total > maxBytes) throw new Error(`response body exceeds the ${maxBytes} byte cap`)
      armIdle()
      chunks.push(value)
    }
  } catch (error) {
    try { await reader.cancel(error) } catch {}
    throw error
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(totalTimer)
    combined.removeEventListener('abort', onAbort)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

/**
 * Stream a URL to disk with an idle timeout, a total deadline and a hard byte
 * cap. On any failure the partial (temp) file is removed before rethrowing.
 */
export async function downloadToFile(url, dest, options = {}) {
  const {
    signal,
    headers,
    validateUrl = null,
    timeoutMs = 900_000,
    idleTimeoutMs = 45_000,
    maxBytes = 1_200_000_000,
    minBytes = 10_000,
    log = () => {},
    onResponse = null,
  } = options
  log(`downloading ${url}`)

  // Capture the owning run once, before any await, so a slow/old download can
  // never write byte counters into a newer run's progress record.
  const progressHandle = currentRun()

  // One total deadline spans the whole operation (headers + streamed body).
  // It is cleared only in finally, so streaming is bounded too.
  const deadlineController = new AbortController()
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new Error(`download timed out after ${timeoutMs}ms`)),
    Math.max(1_000, timeoutMs),
  )
  // The idle controller trips when no chunk arrived for idleTimeoutMs;
  // armIdle() resets it on every chunk.
  const idleController = new AbortController()
  let idleTimer = null
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => idleController.abort(new Error(`download stalled for ${idleTimeoutMs}ms`)),
      Math.max(1_000, idleTimeoutMs),
    )
  }
  const signals = [deadlineController.signal, idleController.signal]
  if (signal) signals.push(signal)
  const combinedSignal = AbortSignal.any(signals)

  // Each attempt streams into its own temp file and atomically renames on
  // success, so two concurrent downloads cannot unlink each other's data.
  const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`
  let response = null
  let source = null
  let out = null
  let received = 0
  let totalBytes = 0
  try {
    response = await fetchWithDeadline(url, { signal: combinedSignal, timeoutMs, headers, validateUrl })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`)
    if (typeof onResponse === 'function') await onResponse(response)
    totalBytes = Math.max(0, Number(response.headers.get('content-length')) || 0)
    noteBytes(progressHandle, 0, totalBytes)

    armIdle()
    source = Readable.fromWeb(response.body)
    out = createWriteStream(tmp)
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > maxBytes) {
          callback(new Error(`download exceeded the ${maxBytes} byte cap`))
          return
        }
        armIdle()
        noteBytes(progressHandle, received, totalBytes)
        callback(null, chunk)
      },
    })
    await pipeline(source, counter, out, { signal: combinedSignal })

    const size = received
    if (size < minBytes) throw new Error(`downloaded file is too small (${size} bytes)`)
    renameSync(tmp, dest)
    noteBytes(progressHandle, size, totalBytes)
    return size
  } catch (error) {
    try { source?.destroy?.() } catch {}
    try { out?.destroy?.() } catch {}
    try { await response?.body?.cancel?.() } catch {}
    await unlink(tmp).catch(() => {})
    if (error?.name === 'AbortError' || /abort|stalled|cancelled|timed out/i.test(String(error?.message))) {
      const wrapped = new Error(`download failed or stalled (${url}): ${error?.message ?? 'aborted'}`)
      wrapped.code = 'E_DOWNLOAD'
      throw wrapped
    }
    if (error instanceof Error && !error.code) error.code = 'E_DOWNLOAD'
    throw error
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(deadlineTimer)
  }
}
