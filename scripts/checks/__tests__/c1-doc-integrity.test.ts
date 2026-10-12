import { afterEach, describe, expect, it } from 'vitest'

import { cleanupTrees, REPO_ROOT, runCheck } from './_harness.js'

const PACKAGE_JSON = JSON.stringify({ scripts: { typecheck: '…', verify: '…' } })

const runC1 = (files: Record<string, string>) =>
  runCheck('c1-doc-integrity.mjs', { 'package.json': PACKAGE_JSON, ...files })

afterEach(cleanupTrees)

describe('1 — links resolve', () => {
  it('rejects a link to a file that does not exist', () => {
    const { code, output } = runC1({ 'docs/guide.md': 'See [the ADR](./decisions/0001-gone.md).' })
    expect(code).toBe(1)
    expect(output).toContain('Link target does not exist: ./decisions/0001-gone.md')
  })

  it('rejects an anchor that no heading produces', () => {
    const { code, output } = runC1({
      'docs/guide.md': 'See [rules](../AGENTS.md#invariants).',
      'AGENTS.md': '# AGENTS.md\n\n## Never\n',
    })
    expect(code).toBe(1)
    expect(output).toContain('Link anchor does not exist: ../AGENTS.md#invariants')
  })

  it('accepts an explicit <a id> left behind by a renamed heading', () => {
    const { code } = runC1({
      'docs/guide.md': 'See [rules](../AGENTS.md#invariants).',
      'AGENTS.md': '# AGENTS.md\n\n<a id="invariants"></a>\n\n## Never\n',
    })
    expect(code).toBe(0)
  })

  it('ignores link-shaped text inside inline code', () => {
    const { code } = runC1({ 'docs/guide.md': 'Render it as `[title](item.link)`.' })
    expect(code).toBe(0)
  })
})

describe('2 — pnpm scripts exist', () => {
  it('rejects a command in backticks that is not a script', () => {
    const { code, output } = runC1({ 'docs/guide.md': 'Run `pnpm feeds:check` first.' })
    expect(code).toBe(1)
    expect(output).toContain('"pnpm feeds:check"')
  })

  it('ignores "pnpm" in a sentence', () => {
    const { code } = runC1({ 'docs/guide.md': 'This repo is pnpm only, never npm.' })
    expect(code).toBe(0)
  })
})

describe('3 — backticked paths exist', () => {
  it('rejects a path that does not exist', () => {
    const { code, output } = runC1({ 'docs/guide.md': 'Edit `src/config/gone.ts`.' })
    expect(code).toBe(1)
    expect(output).toContain('`src/config/gone.ts`')
  })

  it("does not check an ADR's body, which is frozen history", () => {
    const { code } = runC1({
      'docs/decisions/0001-x.md': '---\nid: 0001\napplies_to: []\nstatus: accepted\n---\nWas `src/old.ts`.',
    })
    expect(code).toBe(0)
  })
})

it('does not check the paths of a frozen audit document, but still checks its links', () => {
  const frozen = '---\naudited_at: c0d9464\n---\nThe ranker lived in `src/old/ranker.ts`.'
  expect(runC1({ 'docs/audit/01-EXTRACTION.md': frozen }).code).toBe(0)
  expect(runC1({ 'docs/audit/01-EXTRACTION.md': `${frozen}\nSee [gone](./gone.md).` }).code).toBe(1)
})

describe("4 — an ADR's applies_to exists", () => {
  it('rejects an entry whose path is gone', () => {
    const { code, output } = runC1({
      'docs/decisions/0001-x.md': '---\nid: 0001\napplies_to: ["src/gone/**"]\nstatus: accepted\n---\n',
    })
    expect(code).toBe(1)
    expect(output).toContain('applies_to names "src/gone/**"')
  })

  it('accepts a glob whose literal prefix exists, and skips a superseded ADR', () => {
    const { code } = runC1({
      'src/mastra/workflows/a.ts': '',
      'docs/decisions/0001-x.md': '---\nid: 0001\napplies_to: ["src/mastra/workflows/**"]\nstatus: accepted\n---\n',
      'docs/decisions/0002-y.md': '---\nid: 0002\napplies_to: ["convex/**"]\nstatus: superseded\n---\n',
    })
    expect(code).toBe(0)
  })
})

it('passes on this repo', () => {
  expect(runCheck('c1-doc-integrity.mjs', {}, REPO_ROOT).code).toBe(0)
})
