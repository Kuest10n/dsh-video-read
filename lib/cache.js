/**
 * Workspace artifact cache accounting for dsh-video-read.
 *
 * Every read writes under <workspace>/.video-read/<source-id>/ with frames,
 * shots, sprites and the cached media file. This module measures that tree and
 * prunes whole source directories past a TTL. It never touches anything outside
 * the .video-read root.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

async function dirSize(dir) {
  let total = 0
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(path)
    } else if (entry.isFile()) {
      try {
        total += (await stat(path)).size
      } catch {}
    }
  }
  return total
}

/**
 * Measure the cache without modifying it.
 * @param {string} rootDir - the workspace .video-read directory.
 * @param {{ttlDays?:number, now?:number}} [options]
 */
export async function cacheStatus(rootDir, { ttlDays = 14, now = Date.now() } = {}) {
  const root = resolve(String(rootDir))
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return { rootDir: root, exists: false, dirCount: 0, totalBytes: 0, staleBytes: 0, ttlDays, dirs: [] }
  }
  const ttlMs = Math.max(0, Number(ttlDays) || 0) * 24 * 3600 * 1000
  const dirs = []
  let totalBytes = 0
  let staleBytes = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    let bytes = 0
    let mtime = 0
    try {
      mtime = (await stat(path)).mtimeMs
      bytes = await dirSize(path)
    } catch {}
    totalBytes += bytes
    const stale = ttlMs > 0 ? now - mtime > ttlMs : false
    if (stale) staleBytes += bytes
    dirs.push({ name: entry.name, bytes, updatedAt: new Date(mtime || now).toISOString(), stale })
  }
  dirs.sort((a, b) => b.bytes - a.bytes)
  return { rootDir: root, exists: true, dirCount: dirs.length, totalBytes, staleBytes, ttlDays, dirs }
}

/**
 * Delete source directories older than the TTL (or preview with dryRun).
 * @param {string} rootDir - must be a directory named .video-read.
 * @param {{ttlDays?:number, dryRun?:boolean, now?:number}} [options]
 */
export async function pruneCache(rootDir, { ttlDays = 14, dryRun = false, now = Date.now() } = {}) {
  const root = resolve(String(rootDir))
  if (basename(root) !== '.video-read') {
    throw new Error(`refusing to prune ${root}: expected a directory named .video-read`)
  }
  // ttl_days = 0 must not silently disable pruning: an explicit zero either
  // means "delete everything" or it is a typo, so require an unambiguous value.
  if (!(Number(ttlDays) > 0)) {
    throw new Error('ttl_days must be a positive number of days (use a large value to keep entries longer)')
  }
  const status = await cacheStatus(root, { ttlDays, now })
  const removed = []
  for (const dir of status.dirs) {
    if (!dir.stale) continue
    removed.push({ name: dir.name, bytes: dir.bytes })
    if (!dryRun) await rm(join(root, dir.name), { recursive: true, force: true })
  }
  return {
    rootDir: root,
    dryRun,
    removedCount: removed.length,
    removedBytes: removed.reduce((sum, entry) => sum + entry.bytes, 0),
    removed,
  }
}
