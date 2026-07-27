import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/**
 * Anchors relative paths to the project root instead of the working directory.
 *
 * Mastra's dev server runs the bundle from `.mastra/.build`, and `mastra build`
 * emits a server that runs from `.mastra/output` — neither guarantees the cwd a
 * relative path was written against. Anything resolved against cwd therefore
 * points somewhere different in dev, in the container, and under `pnpm start`.
 *
 * Walking up to the nearest package.json is what makes it deterministic. The
 * built bundle ships its own package.json, so the walk stops there and relative
 * paths stay correct against the deployed layout too.
 */
export function projectRoot(): string {
  let dir = process.cwd()
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return process.cwd()
    dir = parent
  }
}

/** Absolute paths pass through untouched — production sets them explicitly. */
export function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : join(projectRoot(), path)
}
