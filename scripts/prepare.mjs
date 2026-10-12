// `pnpm prepare` — runs on every `pnpm install`, including the Docker build's.
//
// Two jobs, each skipped where it has nothing to act on, because the image has
// neither: `node:22-slim` ships without git, and `.dockerignore` drops `.git`,
// `.agents` and `.claude`. A failing prepare fails the install, so a step that
// needs git cannot simply call it.
//
// 1. Point git at the repo's hooks (`.githooks/`), so `pnpm verify` gates commits.
// 2. Copy every skill in `.agents/skills/` into `.claude/skills/`. `.agents/` is
//    the one tracked copy; Claude Code reads project skills from `.claude/skills/`
//    only, and that copy is gitignored. A copy, not a symlink: git on Windows
//    stores a symlink as a plain file, which is how the skill was once committed
//    twice. A symlink already pointing at the source is left alone.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

if (existsSync(join(ROOT, '.git'))) {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT, stdio: 'inherit' })
}

const source = join(ROOT, '.agents', 'skills')
const target = join(ROOT, '.claude', 'skills')

if (existsSync(source)) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (existsSync(to) && realpathSync(to) === realpathSync(from)) continue
    rmSync(to, { recursive: true, force: true })
    cpSync(from, to, { recursive: true })
  }
}
