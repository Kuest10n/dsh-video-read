/**
 * Shared HTTP helpers with hard bounds: per-attempt deadlines, idle (stall)
 * detection while streaming, byte caps, and safe partial-file cleanup.
 *
 * Every download in this plugin goes through here so a stalled or malicious
 * server can never hang a tool call or fill the disk arbitrarily. Progress of
 * the streaming download is mirrored into the run-progress record so the Web
 * panel can show a percentage (see lib/progress.js).
 */
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { noteBytes } from './progress.js'

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
  const request = (target, hop) =>
    fetch(target, {
      method,
      headers,
      body: hop === 0 ? body : undefined,
      redirect: validateUrl ? 'manual' : redirect,
      signal: controller.signal,
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
 * Read a fetch response body as text with a byte cap and an idle timeout.
 * Throws (never silently truncates) when either bound is exceeded.
 */
export async function readTextCapped(response, options = {}) {
  const { maxBytes = 8 * 1024 * 1024, idleTimeoutMs = 20_000, signal } = options
  if (!response.body) return ''
  const controller = new AbortController()
  let timer = null
  const armIdle = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(
      () => controller.abort(new Error(`response body stalled for ${idleTimeoutMs}ms`)),
      Math.max(1_000, idleTimeoutMs),
    )
  }
  const onAbort = () => controller.abort(signal?.reason ?? new Error('cancelled'))
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  armIdle()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(`response body exceeds the ${maxBytes} byte cap`)
      armIdle()
      chunks.push(value)
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
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
 * cap. On any failure the partial file is removed before rethrowing.
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
  } = options
  log(`downloading ${url}`)
  const response = await fetchWithDeadline(url, { signal, timeoutMs, headers, validateUrl })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`)

  const totalBytes = Math.max(0, Number(response.headers.get('content-length')) || 0)
  const controller = new AbortController()
  let idleTimer = null
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => controller.abort(new Error(`download stalled for ${idleTimeoutMs}ms`)),
      Math.max(1_000, idleTimeoutMs),
    )
  }
  const onAbort = () => controller.abort(signal?.reason ?? new Error('cancelled'))
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  armIdle()

  let received = 0
  let out = null
  try {
    out = createWriteStream(dest)
    const source = Readable.fromWeb(response.body)
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > maxBytes) {
          callback(new Error(`download exceeded the ${maxBytes} byte cap`))
          return
        }
        armIdle()
        noteBytes(received, totalBytes)
        callback(null, chunk)
      },
    })
    await pipeline(source, counter, out)
    const size = received
    if (size < minBytes) throw new Error(`downloaded file is too small (${size} bytes)`)
    noteBytes(size, totalBytes)
    return size
  } catch (error) {
    try {
      out?.destroy()
    } catch {}
    await unlink(dest).catch(() => {})
    if (error?.name === 'AbortError' || /abort|stalled|cancelled|timed out/i.test(String(error?.message))) {
      const wrapped = new Error(`download failed or stalled (${url}): ${error?.message ?? 'aborted'}`)
      wrapped.code = 'E_DOWNLOAD'
      throw wrapped
    }
    if (error instanceof Error && !error.code) error.code = 'E_DOWNLOAD'
    throw error
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
