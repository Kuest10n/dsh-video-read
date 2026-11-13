/**
 * Minimal, dependency-free Bilibili client: WBI signing, view metadata,
 * DASH play-URL resolution, bounded media download, and subtitle retrieval.
 * Douyin and other sites are intentionally out of scope for M1.
 *
 * Security posture: every URL the API hands back is re-validated against a
 * Bilibili CDN host allowlist before it is fetched (so a hostile/compromised
 * API response cannot redirect the plugin to an arbitrary or private host),
 * all downloads carry byte caps and idle timeouts, and the cookie header is
 * only ever attached to api.bilibili.com requests.
 */
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { muxDash, run } from './ffmpeg.js'
import { cleanCueText } from './frames.js'
import { downloadToFile, fetchWithDeadline, readTextCapped } from './net.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const API = 'https://api.bilibili.com'

const API_TIMEOUT_MS = 30_000
const API_MAX_BYTES = 8 * 1024 * 1024
const SUBTITLE_TIMEOUT_MS = 30_000
const SUBTITLE_MAX_BYTES = 4 * 1024 * 1024
const WBI_TTL_MS = 10 * 60_000
const DEFAULT_MAX_MEDIA_BYTES = 1_200_000_000

/** Hosts Bilibili legitimately serves media/subtitles from. */
const CDN_HOST_SUFFIXES = [
  '.hdslb.com',
  '.bilibili.com',
  '.bilivideo.com',
  '.bilivideo.cn',
  '.szbdyd.com',
  '.mountaintoys.cn',
]

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

const DOUYIN_HOSTS = /(^|\.)(douyin\.com|iesdouyin\.com)$/i
const KUAISHOU_HOSTS = /(^|\.)(kuaishou\.com|chenzhongtech\.com)$/i
const XHS_HOSTS = /(^|\.)(xiaohongshu\.com|xhslink\.com)$/i
const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be)$/i

/** Parse an arbitrary input into a known site kind, or null. */
export function classifyUrl(input) {
  let url
  try {
    url = new URL(input)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host === 'b23.tv') return { kind: 'bilibili-short', url }
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) return { kind: 'bilibili', url }
  if (DOUYIN_HOSTS.test(host)) return { kind: 'douyin', url }
  if (KUAISHOU_HOSTS.test(host)) return { kind: 'kuaishou', url }
  if (XHS_HOSTS.test(host)) return { kind: 'xiaohongshu', url }
  if (YOUTUBE_HOSTS.test(host)) return { kind: 'youtube', url }
  return { kind: 'unknown', url }
}

export function unsupportedMessage(kind) {
  if (kind === 'douyin') {
    return (
      'Douyin is not supported in M1. Since 2026-10 Douyin requires the x-secsdk-web-signature risk-control ' +
      'signature; yt-dlp’s extractor is broken and no maintained workaround exists. Do not attempt a bypass. ' +
      'Ask the user to download the clip and pass a local file path instead, or use a video with a public direct URL.'
    )
  }
  if (kind === 'kuaishou') return 'Kuaishou has no maintained public extractor; please pass a local file instead.'
  if (kind === 'xiaohongshu') return 'Xiaohongshu needs logged-in cookies plus signing; please pass a local file instead.'
  if (kind === 'youtube') {
    return (
      'YouTube is planned for M2. M1 supports Bilibili links and local files only. ' +
      'A local download (e.g. produced by yt-dlp) can be passed as a file path right now.'
    )
  }
  return `Unsupported URL host "${kind}". M1 supports Bilibili links and local files only.`
}

function md5(input) {
  return createHash('md5').update(input).digest('hex')
}

/** True for hosts that are not safe to fetch from arbitrary API data. */
function isForbiddenHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '')
  if (!host) return true
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host === 'metadata.google.internal'
  ) {
    return true
  }
  // Bilibili CDNs always use DNS names; a bare IP literal is not legitimate here.
  return isIP(host) !== 0
}

/**
 * Validate a media/subtitle URL returned by the Bilibili API before fetching.
 * Enforces https, a public DNS host, the standard port, and the CDN allowlist.
 */
function assertBilibiliCdnUrl(value, purpose) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new Error(`${purpose} URL is not a valid URL; refusing to fetch it`)
  }
  if (url.protocol !== 'https:') throw new Error(`${purpose} URL is not https; refusing to fetch it`)
  if (url.username || url.password) throw new Error(`${purpose} URL contains credentials; refusing to fetch it`)
  if (url.port && url.port !== '443') throw new Error(`${purpose} URL uses port ${url.port}; refusing to fetch it`)
  if (isForbiddenHost(url.hostname)) {
    throw new Error(`${purpose} URL points to a non-public host (${url.hostname}); refusing to fetch it`)
  }
  const host = url.hostname.toLowerCase()
  const allowed =
    host === 'bilibili.com' || CDN_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
  if (!allowed) {
    throw new Error(`${purpose} URL host "${host}" is not a known Bilibili CDN; refusing to fetch it`)
  }
  return url.toString()
}

function mixinKey(raw) {
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '').join('').slice(0, 32)
}

function wbiQuery(params, mixin) {
  const wts = Math.round(Date.now() / 1000)
  const entries = Object.entries({ ...params, wts })
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
  const wRid = md5(query + mixin)
  return `${query}&w_rid=${wRid}`
}

/** Read a "cookie" JSON file ({"cookie": "a=b; c=d"}) into a Cookie header value. */
export async function loadCookie(file) {
  // Environment override keeps the secret out of the plugin patch when desired.
  const resolvedFile = file || process.env.DSH_VIDEO_READ_COOKIE_FILE || process.env.BILIBILI_COOKIE_FILE
  if (!resolvedFile) return { header: null, note: 'no cookieFile configured; using anonymous Bilibili access' }
  let raw
  try {
    raw = JSON.parse(await readFile(resolvedFile, 'utf8'))
  } catch (error) {
    // Only the file name is reported: the model must never see the local cookie path.
    return {
      header: null,
      note: `cookie file ${basename(resolvedFile)} is unreadable (${error.code ?? 'parse error'}); using anonymous access`,
    }
  }
  const text = typeof raw === 'string' ? raw : typeof raw.cookie === 'string' ? raw.cookie : ''
  if (!text) return { header: null, note: 'cookie file has no cookie value; using anonymous access' }
  const pairs = text
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=')
      return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : null
    })
    .filter(Boolean)
  if (!pairs.length) return { header: null, note: 'cookie file content did not parse; using anonymous access' }
  const hasSess = pairs.some(([key]) => key === 'SESSDATA')
  return {
    header: pairs.map(([key, value]) => `${key}=${value}`).join('; '),
    note: hasSess ? null : 'cookie has no SESSDATA; AI subtitles may be unavailable',
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('cancelled'))
      },
      { once: true },
    )
  })
}

async function apiJson(path, { cookie, signal, method = 'GET', body, retries = 2 } = {}) {
  const headers = { 'user-agent': UA, referer: REFERER }
  if (cookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response
    try {
      response = await fetchWithDeadline(`${API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        timeoutMs: API_TIMEOUT_MS,
      })
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw error
      if (attempt < retries) {
        await sleep(700 * (attempt + 1), signal)
        continue
      }
      throw new Error(`Bilibili request failed: ${error.message}`)
    }
    if (!response.ok) {
      lastError = new Error(`Bilibili HTTP ${response.status} for ${path}`)
      if ((response.status === 412 || response.status === 429 || response.status >= 500) && attempt < retries) {
        await sleep(1_200 * (attempt + 1), signal)
        continue
      }
      throw lastError
    }
    let json
    try {
      const text = await readTextCapped(response, { maxBytes: API_MAX_BYTES, idleTimeoutMs: 20_000, signal })
      json = JSON.parse(text)
    } catch (error) {
      lastError = error
      if (attempt < retries) {
        await sleep(700 * (attempt + 1), signal)
        continue
      }
      throw new Error(`Bilibili API ${path} returned an unreadable response: ${error.message}`)
    }
    if (json.code !== 0) {
      const retryable = json.code === 412 || json.code === -412 || json.code === -509
      if (retryable && attempt < retries) {
        await sleep(1_500 * (attempt + 1), signal)
        continue
      }
      const hint =
        json.code === -101
          ? ' (not logged in: pass a valid cookie file)'
          : json.code === -403
            ? ' (permission denied: the video may be private or paid)'
            : json.code === 412
              ? ' (risk-control trigger: export cookies from a browser that opened bilibili.com, set cookieFile, and retry)'
              : ''
      const apiError = new Error(`Bilibili API ${path} failed: code=${json.code} message=${json.message}${hint}`)
      apiError.code = json.code === 412 ? 'E_RISK_CONTROL' : json.code === -101 ? 'E_NEEDS_COOKIE' : 'E_BILIBILI_API'
      throw apiError
    }
    return json
  }
  throw lastError ?? new Error(`Bilibili API ${path} failed`)
}

/** Expand b23.tv links while refusing any hop that leaves Bilibili's hosts. */
async function resolveShortLink(url, { signal }) {
  let current = String(url)
  for (let hop = 0; hop < 4; hop += 1) {
    let parsed
    try {
      parsed = new URL(current)
    } catch {
      throw new Error(`short link is not a valid URL: ${current}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('short link is not an http(s) URL; refusing to follow it')
    }
    if (isForbiddenHost(parsed.hostname)) {
      throw new Error('short link points to a non-public host; refusing to follow it')
    }
    const host = parsed.hostname.toLowerCase()
    const isB23 = host === 'b23.tv'
    const isBilibili = host === 'bilibili.com' || host.endsWith('.bilibili.com')
    if (!isB23 && !isBilibili) {
      throw new Error(`short link resolved to a non-Bilibili host (${host}); refusing to follow it`)
    }
    if (isBilibili) return current
    const response = await fetchWithDeadline(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': UA },
      signal,
      timeoutMs: 15_000,
    })
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    if (!location) throw new Error(`could not expand short link: ${url}`)
    current = new URL(location, parsed).toString()
  }
  throw new Error(`could not expand short link after 4 hops: ${url}`)
}

function parseVideoId(url, { signal } = {}) {
  const path = url.pathname
  const bv = path.match(/\/video\/(BV[0-9A-Za-z]{8,16})/i)
  const av = path.match(/\/video\/av(\d+)/i)
  if (!bv && !av) throw new Error(`not a Bilibili video URL (expects /video/BV... or /video/av...): ${url}`)
  const page = Math.max(1, Number(url.searchParams.get('p')) || 1)
  return { bvid: bv ? bv[1] : null, aid: av ? Number(av[1]) : null, page }
}

/** WBI mixin keys rotate slowly; cache them per cookie for a short window. */
const wbiCache = new Map()

async function wbiKeys(cookie, { signal }) {
  const cacheKey = md5(cookie || 'anonymous')
  const hit = wbiCache.get(cacheKey)
  if (hit && Date.now() - hit.at < WBI_TTL_MS) return hit.mixin
  const nav = await apiJson('/x/web-interface/nav', { cookie, signal })
  const img = String(nav.data?.wbi_img?.img_url ?? '')
  const sub = String(nav.data?.wbi_img?.sub_url ?? '')
  const imgKey = img.split('/').pop()?.split('.')[0] ?? ''
  const subKey = sub.split('/').pop()?.split('.')[0] ?? ''
  if (!imgKey || !subKey) throw new Error('could not obtain WBI keys from Bilibili nav API')
  const mixin = mixinKey(imgKey + subKey)
  wbiCache.set(cacheKey, { at: Date.now(), mixin })
  return mixin
}

async function fetchSubtitles({ bvid, cid, cookie, keys, signal }) {
  if (!keys) return { cues: [], languages: [], note: 'no subtitles (subtitle list unavailable: no WBI keys)', reason: 'fetch-failed' }
  const query = wbiQuery({ bvid, cid }, keys)
  let json
  try {
    json = await apiJson(`/x/player/wbi/v2?${query}`, { cookie, signal })
  } catch (error) {
    const reason = error.code === 'E_NEEDS_COOKIE' ? 'needs-cookie' : 'fetch-failed'
    return { cues: [], languages: [], note: `no subtitles (subtitle list unavailable: ${error.message})`, reason }
  }
  const subtitles = json.data?.subtitle?.subtitles ?? []
  if (!subtitles.length) return { cues: [], languages: [], note: 'no subtitles (this video has none; the visuals are fine, there are simply no words)', reason: 'no-subs' }
  const preferred =
    subtitles.find((item) => /zh-CN|zh-Hans|ai-zh/i.test(item.lan ?? '')) ??
    subtitles.find((item) => /^zh/i.test(item.lan ?? '')) ??
    subtitles[0]
  const raw = String(preferred.subtitle_url ?? '')
  if (!raw) return { cues: [], languages: subtitles.map((item) => item.lan), note: 'no subtitles (subtitle URL missing)', reason: 'no-subs' }
  const location = raw.startsWith('//') ? `https:${raw}` : raw
  const subtitleUrl = assertBilibiliCdnUrl(location, 'subtitle')
  const response = await fetchWithDeadline(subtitleUrl, {
    headers: { 'user-agent': UA, referer: REFERER },
    signal,
    timeoutMs: SUBTITLE_TIMEOUT_MS,
  })
  if (!response.ok) throw new Error(`subtitle download failed: HTTP ${response.status}`)
  const text = await readTextCapped(response, {
    maxBytes: SUBTITLE_MAX_BYTES,
    idleTimeoutMs: 20_000,
    signal,
  })
  const payload = JSON.parse(text)
  // Bilibili has returned both a bare array and a {body:[...]} wrapper over time.
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.body)
      ? payload.body
      : Array.isArray(payload?.result)
        ? payload.result
        : []
  const cues = items
    .map((item) => {
      const from = Number(item.from) || 0
      const to = Number(item.to) || from + 2
      return { from, to, text: cleanCueText(item.content ?? item.text ?? '') }
    })
    .filter((cue) => cue.text)
    .sort((a, b) => a.from - b.from)
    .slice(0, 50_000)
  return {
    cues,
    languages: subtitles.map((item) => item.lan),
    note: cues.length ? null : 'no subtitles (payload had no cue entries)',
    reason: cues.length ? null : 'no-subs',
  }
}

function uniquePath(dir, stem, ext) {
  return join(dir, `${stem}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.${ext}`)
}

async function tryUrls(urls, dest, { signal, log, maxMediaBytes = DEFAULT_MAX_MEDIA_BYTES }) {
  let lastError = null
  for (const url of urls) {
    if (!url) continue
    try {
      const safe = assertBilibiliCdnUrl(url, 'media')
      await downloadToFile(safe, dest, {
        signal,
        log,
        headers: { 'user-agent': UA, referer: REFERER, origin: 'https://www.bilibili.com' },
        maxBytes: maxMediaBytes,
        idleTimeoutMs: 45_000,
        timeoutMs: 300_000,
        minBytes: 10_000,
      })
      return dest
    } catch (error) {
      lastError = error
      log(`media URL failed: ${error.message}`)
    }
  }
  throw lastError ?? new Error('no media URL available')
}

function pickVideoStream(dash, qn) {
  const videos = Array.isArray(dash?.video) ? dash.video : []
  if (!videos.length) return null
  const avc = videos.filter((item) => String(item.codecs ?? '').toLowerCase().startsWith('avc'))
  const pool = avc.length ? avc : videos
  const sorted = [...pool].sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))
  const withinQuality = sorted.find((item) => Number(item.id) <= qn) ?? sorted[0]
  const candidates = [withinQuality, ...sorted.filter((item) => item !== withinQuality)]
  return candidates
}

function urlsOf(stream) {
  const list = [stream?.baseUrl, stream?.base_url]
  const backups = Array.isArray(stream?.backupUrl) ? stream.backupUrl : Array.isArray(stream?.backup_url) ? stream.backup_url : []
  return [...list, ...backups].filter(Boolean)
}

/**
 * Resolve Bilibili metadata, subtitles and (optionally) a playable local file.
 * @param {string} input
 * @param {object} options
 * @param {object} [options.existing] previously resolved metadata to reuse (one API pass instead of two)
 * @returns {Promise<object>} normalized metadata plus `filePath` when downloaded
 */
export async function resolveBilibili(input, options) {
  const {
    cookieFile,
    signal,
    download = false,
    ff = null,
    log = () => {},
    quality = 64,
    existing = null,
    wbiMixin: providedMixin = null,
    maxVideoMinutes = 180,
    maxMediaBytes = DEFAULT_MAX_MEDIA_BYTES,
  } = options
  const classified = classifyUrl(input)
  if (!classified) throw new Error(`not a URL: ${input}`)
  let url = classified.url
  if (classified.kind === 'bilibili-short') {
    log('expanding b23.tv short link')
    url = new URL(await resolveShortLink(url.toString(), { signal }))
  }
  if (classifyUrl(url.toString())?.kind !== 'bilibili') throw new Error(`not a Bilibili video URL: ${input}`)
  const { bvid: parsedBv, aid: parsedAid, page } = parseVideoId(url)

  let meta
  const notes = []
  let cookieHeader = null
  let mixin = providedMixin
  if (existing) {
    meta = existing
    if (Array.isArray(existing.notes)) notes.push(...existing.notes)
  } else {
    const cookie = await loadCookie(cookieFile)
    cookieHeader = cookie.header
    if (cookie.note) notes.push(cookie.note)
    const viewQuery = parsedBv ? `bvid=${parsedBv}` : `aid=${parsedAid}`
    const view = await apiJson(`/x/web-interface/view?${viewQuery}`, { cookie: cookieHeader, signal })
    const data = view.data
    const bvid = data.bvid
    const aid = data.aid
    const pages = Array.isArray(data.pages) && data.pages.length ? data.pages : [{ cid: data.cid, page: 1, part: '' }]
    const selected = pages[Math.min(page, pages.length) - 1] ?? pages[0]
    const cid = selected.cid
    meta = {
      kind: 'bilibili',
      input,
      webpageUrl: `https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ''}`,
      bvid,
      aid,
      cid,
      page: selected.page ?? page,
      pageCount: pages.length,
      part: selected.part || null,
      title: data.title,
      owner: data.owner?.name ?? null,
      cover: data.pic ? (String(data.pic).startsWith('//') ? `https:${data.pic}` : data.pic) : null,
      durationSec: Number(selected.duration ?? data.duration) || 0,
      dimension: data.dimension ?? null,
      publishedAt: data.pubdate ? new Date(Number(data.pubdate) * 1000).toISOString() : null,
      subtitles: { cues: [], languages: [], note: null },
      notes,
      filePath: null,
      cacheDir: null,
      hasAudio: null,
    }
    try {
      mixin = await wbiKeys(cookieHeader, { signal })
      meta.subtitles = await fetchSubtitles({ bvid, cid, cookie: cookieHeader, keys: mixin, signal })
    } catch (error) {
      notes.push(`subtitle resolution failed: ${error.message}`)
    }
    Object.defineProperty(meta, 'wbiMixin', { value: mixin, enumerable: false, configurable: true })
    meta.notes = notes
  }

  if (!download) return meta
  if (!ff?.available) {
    const error = new Error('ffmpeg is required to mux Bilibili DASH streams but is unavailable')
    error.code = 'E_FFMPEG_MISSING'
    throw error
  }
  if (Number(meta.durationSec) > Number(maxVideoMinutes) * 60) {
    const error = new Error(
      `video duration ${Math.round(Number(meta.durationSec) / 60)} min exceeds maxVideoMinutes=${maxVideoMinutes}; ` +
        'pass a shorter range from a local trimmed file, or raise the plugin option maxVideoMinutes',
    )
    error.code = 'E_TOO_LONG'
    throw error
  }

  const cache = options.cacheDir
  await mkdir(cache, { recursive: true })
  const finalFile = join(cache, 'source.mp4')
  const partFile = uniquePath(cache, 'source', 'part.mp4')
  const tempFiles = [partFile]

  // The cookie is only needed for playurl; reuse it from the metadata pass when
  // possible so a download never performs a second credential read.
  if (!cookieHeader) cookieHeader = (await loadCookie(cookieFile)).header
  if (!mixin) mixin = await wbiKeys(cookieHeader, { signal })

  const playQuery = wbiQuery(
    { bvid: meta.bvid, aid: meta.aid, cid: meta.cid, qn: quality, fnval: 4048, fnver: 0, fourk: 1 },
    mixin,
  )
  const [play, subtitles] = await Promise.all([
    apiJson(`/x/player/wbi/playurl?${playQuery}`, { cookie: cookieHeader, signal }),
    // Only fetch subtitles when the metadata pass did not already resolve real
    // cue content; a stale "no subtitles" note must not suppress a retry.
    existing || meta.subtitles?.cues?.length
      ? Promise.resolve(meta.subtitles)
      : fetchSubtitles({ bvid: meta.bvid, cid: meta.cid, cookie: cookieHeader, keys: mixin, signal }),
  ])
  if (!existing) meta.subtitles = subtitles

  const dash = play.data?.dash
  const dashCandidates = dash ? pickVideoStream(dash, Number(quality) || 64) : null
  const durl = Array.isArray(play.data?.durl) ? play.data.durl : []
  try {
    if (dashCandidates?.length) {
      const videoFile = uniquePath(cache, 'video', 'm4s')
      tempFiles.push(videoFile)
      await tryUrls(urlsOf(dashCandidates[0]), videoFile, { signal, log, maxMediaBytes })
      const audios = Array.isArray(dash.audio) ? dash.audio : []
      let audioFile = null
      if (audios.length) {
        const ranked = [...audios].sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))
        for (const stream of ranked) {
          const file = uniquePath(cache, 'audio', 'm4s')
          tempFiles.push(file)
          try {
            await tryUrls(urlsOf(stream), file, { signal, log, maxMediaBytes })
            audioFile = file
            break
          } catch {}
        }
      }
      if (audioFile) {
        await muxDash(ff, videoFile, audioFile, partFile, { signal })
      } else {
        await run(
          ff.ffmpeg,
          ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', videoFile, '-c', 'copy', partFile],
          { signal, timeoutMs: 240_000 },
        )
        notes.push('video has no separate audio stream; saved video-only')
      }
    } else if (durl.length) {
      if (durl.length > 1) {
        // Concatenating N FLV segments needs a second mux pass; downloading just
        // one segment would silently truncate the video while the metadata still
        // reports the full duration, so refuse instead.
        const error = new Error(
          `this video is served as ${durl.length} FLV segments; segmented downloads are not supported yet. ` +
            'Try again later (a DASH stream is usually offered), or download it with another tool and pass the local file.',
        )
        error.code = 'E_SEGMENTED'
        throw error
      }
      const target = uniquePath(cache, 'source', 'flv')
      tempFiles.push(target)
      await tryUrls(
        durl.flatMap((item) => [item.url, ...(Array.isArray(item.backup_url) ? item.backup_url : [])]),
        target,
        { signal, log, maxMediaBytes },
      )
      await run(ff.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', target, '-c', 'copy', partFile], {
        signal,
        timeoutMs: 240_000,
      })
    } else {
      const error = new Error(
        'playurl returned neither DASH nor durl streams (video may require VIP or purchase); ' +
          'try a lower bilibiliQuality, or pass a local file',
      )
      error.code = 'E_VIP_CONTENT'
      throw error
    }
    await rename(partFile, finalFile)
  } finally {
    for (const file of tempFiles) await unlink(file).catch(() => {})
  }

  meta.filePath = finalFile
  meta.cacheDir = cache
  meta.quality = `qn=${quality}`
  notes.push('downloaded Bilibili DASH streams and muxed with ffmpeg (no DRM involved)')
  meta.notes = notes
  return meta
}

/** Persist a small JSON record next to the cached media. */
export async function writeCacheMeta(cacheDir, name, value) {
  await mkdir(cacheDir, { recursive: true })
  await writeFileSafe(join(cacheDir, name), value)
}

async function writeFileSafe(file, value) {
  const { rename: renameFile, writeFile } = await import('node:fs/promises')
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await renameFile(tmp, file)
}
