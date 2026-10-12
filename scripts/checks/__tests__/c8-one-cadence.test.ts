import { afterEach, expect, it } from 'vitest'

import { cleanupTrees, REPO_ROOT, runCheck } from './_harness.js'

afterEach(cleanupTrees)

const workflow = (schedule: string) =>
  `export const w = createWorkflow({\n  id: 'w',\n${schedule}\n})`

it('rejects claimCycle outside the kit — the hand-written claim F1 and F4 came from', () => {
  const { code, output } = runCheck('c8-one-cadence.mjs', {
    'src/mastra/workflows/x.ts': "import { claimCycle } from '../../db/cycles.js'\nawait claimCycle('x', 1)",
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/workflows/x.ts:1')
  expect(output).toContain('src/mastra/workflows/x.ts:2')
})

it('allows claimCycle where it is defined, in the kit, and in tests', () => {
  const { code } = runCheck('c8-one-cadence.mjs', {
    'src/db/cycles.ts': 'export async function claimCycle() {}',
    'src/mastra/pipeline-kit.ts': "import { claimCycle } from '../db/cycles.js'",
    'src/db/__tests__/cycles.test.ts': "import { claimCycle } from '../cycles.js'",
  })
  expect(code).toBe(0)
})

it("accepts a pipeline's rendered schedule", () => {
  const { code } = runCheck('c8-one-cadence.mjs', {
    'src/mastra/workflows/x.ts': workflow('  schedule: NEWS.schedule,'),
  })
  expect(code).toBe(0)
})

it('rejects a schedule written by hand', () => {
  const { code, output } = runCheck('c8-one-cadence.mjs', {
    'src/mastra/workflows/x.ts': workflow("  schedule: { cron: '0 9 * * *', inputData: {} },"),
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/workflows/x.ts:3')
})

it('accepts a hand-written schedule under the maintenance comment, and only directly under it', () => {
  const marked = runCheck('c8-one-cadence.mjs', {
    'src/mastra/workflows/x.ts': workflow("  // C8: maintenance — retention, no gate\n  schedule: { cron: '0 4 * * *' },"),
  })
  expect(marked.code).toBe(0)

  const detached = runCheck('c8-one-cadence.mjs', {
    'src/mastra/workflows/x.ts': workflow(
      "  // C8: maintenance — retention, no gate\n  // another comment\n  schedule: { cron: '0 4 * * *' },",
    ),
  })
  expect(detached.code).toBe(1)

  const noReason = runCheck('c8-one-cadence.mjs', {
    'src/mastra/workflows/x.ts': workflow("  // C8: maintenance —\n  schedule: { cron: '0 4 * * *' },"),
  })
  expect(noReason.code).toBe(1)
})

it('ignores the rule written in a comment, and a schedule outside a workflow file', () => {
  const { code } = runCheck('c8-one-cadence.mjs', {
    'src/mastra/x.ts': '/** never call claimCycle by hand */\nexport const job = { schedule: { cron: "x" } }',
  })
  expect(code).toBe(0)
})

it('passes on this repo', () => {
  expect(runCheck('c8-one-cadence.mjs', {}, REPO_ROOT).code).toBe(0)
})
