import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveFromRoot } from './project-root.js'

/**
 * Anchors relative `file:` database URLs to the project root instead of the
 * working directory.
 *
 * Mastra's dev server and bundler don't guarantee cwd, so a plain
 * `file:./.data/ava.db` gets created wherever the process happens to be
 * standing — we found stray databases under `src/mastra/public/`.
 *
 * Absolute URLs (`file:/data/ava.db`) and remote ones (`libsql://…`) pass
 * through untouched, which is what production uses.
 */

/** Returns the URL to hand libsql, creating the parent directory if it's local. */
export function resolveDbUrl(url: string): string {
  if (!url.startsWith('file:')) return url

  const rawPath = url.slice('file:'.length)
  if (!rawPath || rawPath.startsWith(':')) return url // e.g. file::memory:

  const absolute = resolveFromRoot(rawPath)
  mkdirSync(dirname(absolute), { recursive: true })
  return `file:${absolute}`
}
