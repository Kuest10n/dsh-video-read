/**
 * C1 visual bridge: caption frames with an image-capable model through the Host
 * LLM service, so text-only readers still get a short visual description for
 * every sampled frame. Captions are the only place this plugin spends tokens on
 * another model, so they are opt-in and capped.
 */
import { basename } from 'node:path'

const MAX_CAPTION_FRAMES_DEFAULT = 8
const CAPTION_MAX_TOKENS_DEFAULT = 400
const PER_FRAME_TIMEOUT_MS = 60_000

function captionPrompt(frame) {
  const parts = [
    `This is one frame from a video at ${frame.timeLabel}.`,
  ]
  if (frame.subtitle) parts.push(`Its nearest subtitle line says: "${frame.subtitle}".`)
  parts.push('Describe what is visually happening in this frame in one or two short sentences. Mention people, objects, text on screen, and scene changes if visible. Do not invent anything you cannot see.')
  return parts.join(' ')
}

/**
 * Caption up to `maxFrames` frames that already carry an image attachment.
 * @returns {Promise<{captions:{index:number,time:number,text:string}[], note:string|null}>}
 */
export async function captionFrames({ ctx, cfg = {}, frames = [], route = null, signal, maxFrames } = {}) {
  const provider = String(cfg.captionProvider || route?.provider || '').trim()
  const model = String(cfg.captionModel || route?.model || '').trim()
  if (!provider || !model) {
    return { captions: [], note: 'no caption model is configured (set captionProvider/captionModel or use an image-capable route)' }
  }
  let llm = null
  try {
    llm = ctx.get('llm')
  } catch {}
  if (!llm?.stream) return { captions: [], note: 'the llm service is unavailable, so visual captions were skipped' }

  const budget = Math.max(1, Math.min(32, Number(maxFrames) || Number(cfg.maxCaptionFrames) || MAX_CAPTION_FRAMES_DEFAULT))
  const candidates = frames.filter((frame) => frame?.attachment).slice(0, budget)
  if (!candidates.length) return { captions: [], note: 'no image attachment was available for captioning' }

  const maxTokens = Math.max(32, Math.min(1024, Number(cfg.captionMaxTokens) || CAPTION_MAX_TOKENS_DEFAULT))
  const system =
    'You describe single video frames for a blind reader. Reply in the language of the subtitle when one is given, otherwise English. Be concrete and brief (max 30 words). Never invent events beyond the visible frame.'
  const captions = []
  const problems = []
  const concurrency = Math.max(1, Math.min(8, Number(cfg.captionConcurrency) || 3))
  let cursor = 0
  const captionOne = async (frame) => {
    const signals = [signal, AbortSignal.timeout(PER_FRAME_TIMEOUT_MS)].filter(Boolean)
    const frameSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    const messages = [
      {
        id: `video-caption-${Date.now()}-${frame.index}-${basename(frame.path ?? 'frame')}`,
        role: 'user',
        content: [
          { type: 'text', text: captionPrompt(frame) },
          { type: 'image', attachment: frame.attachment },
        ],
        source: { kind: 'plugin', plugin: 'dsh-video-read' },
      },
    ]
    let output = ''
    const chunkTypes = new Set()
    let finishReason = null
    try {
      for await (const chunk of llm.stream({
        provider,
        model,
        messages,
        system,
        maxTokens,
        purpose: 'compaction',
        signal: frameSignal,
      })) {
        chunkTypes.add(chunk?.type)
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
        if (chunk?.type === 'finish') finishReason = chunk.reason ?? 'unknown'
      }
      const text = output.replace(/\s+/g, ' ').trim()
      if (text) captions.push({ index: frame.index, time: frame.time, text })
      else {
        const seen = [...chunkTypes].filter(Boolean)
        problems.push(
          `frame ${frame.index}: the caption model returned no text (chunks: ${seen.length ? seen.join(',') : 'none'}; finish: ${finishReason ?? 'unknown'})`,
        )
      }
    } catch (error) {
      problems.push(`frame ${frame.index}: ${error.message}`)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, candidates.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= candidates.length) return
      await captionOne(candidates[index])
    }
  })
  await Promise.all(workers)
  captions.sort((a, b) => a.index - b.index)
  const note = problems.length
    ? `${problems.length} caption(s) failed (${problems.slice(0, 2).join('; ')}${problems.length > 2 ? '; …' : ''})`
    : null
  return { captions, note }
}
