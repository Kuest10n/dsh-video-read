/**
 * Local retrieval over a video's text evidence (subtitles + danmaku).
 * No model call: rank timeline lines against the question terms so a text-only
 * model can answer from retrieved evidence (path C2/C3 groundwork).
 */
import { formatClock } from './frames.js'

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'what', 'when', 'where', 'who', 'why',
  'how', 'does', 'do', 'did', 'this', 'that', 'these', 'those', 'in', 'on', 'at', 'of', 'to', 'and',
  'or', 'for', 'with', 'about', 'from', 'video', 'clip', 'happens', 'happened', 'there', 'it', 'its',
  '吗', '呢', '的', '了', '是', '在', '有', '和', '与', '就', '都', '也', '这', '那', '个', '什么',
  '怎么', '为什么', '哪里', '谁', '请问', '一下', '视频', '画面', '镜头',
])

/** Tokenize a question into Unicode words and script-specific bigrams. */
export function questionTokens(question) {
  const lower = String(question ?? '').toLowerCase()
  const tokens = new Set()
  // Unicode letters/numbers keep accented Latin, kana, Hangul, Cyrillic and
  // single characters searchable; the old [a-z0-9]{2,} dropped all of them.
  for (const word of lower.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!STOPWORDS.has(word)) tokens.add(word)
  }
  // Compact scripts rarely delimit words. Add overlapping bigrams so a pure
  // Japanese/Korean/Cyrillic or Chinese question still yields searchable terms.
  const compact = lower.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}]/gu, '')
  for (let i = 0; i + 1 < compact.length; i += 1) {
    const bigram = compact.slice(i, i + 2)
    if (!STOPWORDS.has(bigram)) tokens.add(bigram)
  }
  // Public contract: an array of strings. Existing in-module callers also use
  // the old Set-style `.size` / `.has`; keep those as non-enumerable shims so
  // neither shape breaks, without polluting serialization or deep equality.
  const result = [...tokens]
  Object.defineProperties(result, {
    size: { get: () => result.length },
    has: { value: (token) => result.includes(token) },
  })
  return result
}

function scoreTerms(query, text) {
  if (!query.size) return { score: 0, matched: [] }
  const lower = String(text ?? '').toLowerCase()
  const matched = []
  for (const token of query) {
    if (lower.includes(token)) matched.push(token)
  }
  return { score: matched.length, matched }
}

/**
 * Rank subtitle cues and danmaku lines by term overlap with the question.
 * @returns {{items:{kind:string,time:number,timeLabel:string,text:string,score:number,matched:string[]}[], query:string[], note:string|null}}
 */
export function rankEvidence({ question, cues = [], danmaku = [], limit = 12, cueWeight = 1, danmakuWeight = 0.7 } = {}) {
  const query = questionTokens(question)
  if (!query.size) {
    return { items: [], query: [], note: 'the question produced no searchable terms after stop-word removal' }
  }
  const items = []
  for (const cue of cues) {
    const text = String(cue.text ?? '')
    if (!text) continue
    const { score, matched } = scoreTerms(query, text)
    if (!score) continue
    items.push({ kind: 'subtitle', time: Number(cue.from), timeLabel: formatClock(Number(cue.from)), text, score: Number((score * cueWeight).toFixed(2)), matched })
  }
  for (const line of danmaku) {
    const text = String(line.text ?? '')
    if (!text) continue
    const { score, matched } = scoreTerms(query, text)
    if (!score) continue
    items.push({ kind: 'danmaku', time: Number(line.time), timeLabel: formatClock(Number(line.time)), text, score: Number((score * danmakuWeight).toFixed(2)), matched })
  }
  items.sort((left, right) => right.score - left.score || left.time - right.time)
  const picked = items.slice(0, Math.max(1, Math.min(50, Number(limit) || 12)))
  return {
    items: picked,
    query: [...query],
    note: picked.length ? null : 'no subtitle or danmaku line matched the question terms; try different wording',
  }
}
