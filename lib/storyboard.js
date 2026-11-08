/**
 * Storyboard view over one captured scene sample: turns the raw frame list into
 * readable "shots" with a time range, the nearest subtitle and an optional
 * model caption. Pure functions only, so the plugin and the self-tests can
 * exercise them without ffmpeg or the network.
 */
import { formatClock } from './frames.js'

/**
 * @param {object} value - one capture() value (frames + sampling range).
 * @returns {{sceneCount:number, range:object, scenes:object[], text:string}}
 */
export function buildStoryboard(value) {
  const frames = Array.isArray(value?.frames) ? value.frames : []
  const range = value?.sampling?.range ?? { start: 0, end: 0 }
  const fallbackEnd = Number(range?.end)
  const scenes = frames.map((frame, index) => {
    const start = Number(frame?.time) || 0
    const next = frames[index + 1]
    const end = next ? Number(next.time) || 0 : Number.isFinite(fallbackEnd) ? fallbackEnd : start
    return {
      index: index + 1,
      start,
      end,
      startLabel: formatClock(start),
      endLabel: formatClock(end),
      durationSec: Math.max(0, Math.round((end - start) * 1000) / 1000),
      subtitle: frame?.subtitle ?? null,
      caption: frame?.caption ?? null,
      path: frame?.path ?? null,
      bytes: frame?.bytes ?? null,
    }
  })
  return { sceneCount: scenes.length, range, scenes, text: renderStoryboardText({ scenes, range }) }
}

/**
 * Render a storyboard as compact text for the tool result.
 * @param {{scenes?:object[], range?:object}} storyboard
 * @returns {string}
 */
export function renderStoryboardText(storyboard) {
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : []
  if (!scenes.length) return 'Storyboard: no scene cut fell inside the requested range.'
  const range = storyboard?.range ?? { start: 0, end: 0 }
  const lines = [
    `Storyboard: ${scenes.length} scene(s), range ${formatClock(Number(range.start) || 0)}–${formatClock(Number(range.end) || 0)}`,
  ]
  for (const scene of scenes) {
    const parts = [`第${scene.index}镜 [${scene.startLabel}–${scene.endLabel}]`]
    if (scene.subtitle) parts.push(`字幕: ${scene.subtitle}`)
    if (scene.caption) parts.push(`画面: ${scene.caption}`)
    lines.push(parts.join(' | '))
  }
  return lines.join('\n')
}
