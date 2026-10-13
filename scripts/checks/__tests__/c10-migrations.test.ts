import { execFileSync } from 'node:child_process'
import { readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { cleanupTrees, makeTree, REPO_ROOT, runCheck } from './_harness.js'

afterEach(cleanupTrees)

const schema = (extra = '') =>
  [
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    "export const beats = sqliteTable('beats', {",
    "  slug: text('slug').primaryKey(),",
    extra,
    '})',
  ].join('\n')

/**
 * A tree holding a schema and the migration drizzle-kit generated for it — the state after an honest
 * `pnpm db:generate`. Its `node_modules` links to this repo's, so the schema's import resolves.
 */
function generatedTree(): string {
  const root = makeTree({ 'src/db/schema.ts': schema(), 'drizzle/.keep': '' })
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction')
  const bin = path.join(path.dirname(createRequire(import.meta.url).resolve('drizzle-kit')), 'bin.cjs')
  execFileSync(process.execPath, [bin, 'generate', '--dialect', 'turso', '--schema', 'src/db/schema.ts', '--out', 'drizzle'], {
    cwd: root,
    stdio: 'ignore',
  })
  return root
}

it('passes when the last migration matches the schema, and touches nothing in drizzle/', () => {
  const root = generatedTree()
  const before = readdirSync(path.join(root, 'drizzle'))
  expect(runCheck('c10-migrations.mjs', {}, root).code).toBe(0)
  expect(readdirSync(path.join(root, 'drizzle'))).toEqual(before)
})

it('fails when a column was added without pnpm db:generate', () => {
  const root = generatedTree()
  writeFileSync(path.join(root, 'src/db/schema.ts'), schema("  emoji: text('emoji'),"))
  const { code, output } = runCheck('c10-migrations.mjs', {}, root)
  expect(code).toBe(1)
  expect(output).toContain('src/db/schema.ts')
  expect(output).toContain('pnpm db:generate')
})

it('passes on this repo', () => {
  expect(runCheck('c10-migrations.mjs', {}, REPO_ROOT).code).toBe(0)
})
