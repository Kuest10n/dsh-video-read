/**
 * Contact-sheet ("grid") evidence: tile N sampled frames into a single JPEG so
 * one image carries the whole sampled range. This is the token-cheap answer to
 * the original "截屏 2/5/12/15/24/30/60 帧每秒" requirement: the model can raise
 * the sampling rate without paying one image per frame.
 *
 * Each cell is stamped with its timestamp before tiling when a font is
 * available, because a contact sheet is useless for story order if the cells
 * cannot be mapped back to a moment in time.
 */
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { drawTextFilter, pickDrawTextFont, run } from './ffmpeg.js'

/** Choose a near-square grid for a frame count (max `maxCols` columns). */
export function planGridCells(count, { maxCols = 4 } = {}) {
  const cells = Math.max(1, Math.min(64, Math.round(Number(count) || 1)))
  const cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(cells))))
  const rows = Math.ceil(cells / cols)
  return { cells, cols, rows }
}

async function renderPanel(ff, source, dest, { label, fontFile, cellWidth, cellHeight, signal, timeoutMs }) {
  const scalePad =
    `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,` +
    `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black`
  const filter = label && fontFile
    ? `${scalePad},${drawTextFilter(fontFile, label, { fontSize: Math.max(11, Math.round(cellWidth / 18)) })}`
    : scalePad
  await run(ff.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source, '-vf', filter, '-frames:v', '1', '-q:v', '3', dest], {
    signal,
    timeoutMs,
  })
}

/**
 * Tile captured frames into <outDir>/grid.jpg.
 * @param {{ffmpeg:string}} ff - resolveFfmpeg() result.
 * @param {{path:string, timeLabel?:string}[]} frames - captured frames in time order.
 * @param {{outDir:string, signal?:AbortSignal, cellWidth?:number, cellHeight?:number,
 *   maxCols?:number, labels?:string[], timeoutMs?:number, concurrency?:number}} options
 */
export async function buildGrid(
  ff,
  frames,
  { outDir, signal, cellWidth = 320, cellHeight = 240, maxCols = 4, labels = [], timeoutMs = 120_000, concurrency = 4 } = {},
) {
  const usable = (Array.isArray(frames) ? frames : []).filter((frame) => frame?.path)
  if (!usable.length) throw new Error('no frame file is available for a contact sheet')
  const { cols, rows } = planGridCells(usable.length, { maxCols })
  const fontFile = pickDrawTextFont()
  const tmp = join(outDir, 'grid-src')
  await mkdir(tmp, { recursive: true })
  try {
    const panelNames = usable.map((_, index) => `panel-${String(index + 1).padStart(3, '0')}.jpg`)
    const labelFor = (index) => {
      const explicit = labels[index]
      if (typeof explicit === 'string' && explicit) return explicit
      return usable[index]?.timeLabel ?? ''
    }
    let labeled = 0
    const worker = async (offset) => {
      for (let index = offset; index < usable.length; index += concurrency) {
        const dest = join(tmp, panelNames[index])
        const label = labelFor(index)
        if (fontFile) {
          try {
            await renderPanel(ff, usable[index].path, dest, {
              label,
              fontFile,
              cellWidth,
              cellHeight,
              signal,
              timeoutMs,
            })
            labeled += 1
            continue
          } catch {}
        }
        // Normalize the panel even when the timestamp stamp fails: every tile
        // must share one pixel size or ffmpeg's tile filter rejects the set.
        await renderPanel(ff, usable[index].path, dest, { label: '', fontFile: null, cellWidth, cellHeight, signal, timeoutMs })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, usable.length) }, (_, offset) => worker(offset)))
    const outPath = join(outDir, 'grid.jpg')
    // Every panel is normalized to cellWidth x cellHeight above (labeled or
    // not), so tiling never has to rescale a mixed-size set.
    const filter = `tile=${cols}x${rows}:padding=4:margin=4`
    await run(ff.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', '1', '-i', join(tmp, 'panel-%03d.jpg'), '-vf', filter, '-frames:v', '1', '-q:v', '3', outPath], {
      signal,
      timeoutMs,
    })
    const info = await stat(outPath)
    return {
      path: outPath,
      bytes: info.size,
      cols,
      rows,
      cells: usable.length,
      cellWidth,
      cellHeight,
      labelsBurned: labeled === usable.length && labeled > 0,
      labels: labeled,
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
