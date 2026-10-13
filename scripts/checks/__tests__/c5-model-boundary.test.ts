import { afterEach, expect, it } from 'vitest'

import { cleanupTrees, REPO_ROOT, runCheck } from './_harness.js'

afterEach(cleanupTrees)

const structured = {
  'src/mastra/agents/structured.ts':
    'export const structured = (agent: any, input: any, schema: any) => agent.generate(input, { structuredOutput: { schema } })',
}

it('rejects an agent built outside src/mastra/agents/', () => {
  const { code, output } = runCheck('c5-model-boundary.mjs', {
    ...structured,
    'src/mastra/workflows/curate-all.ts': "const ranker = new Agent({ id: 'ranker' })",
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/workflows/curate-all.ts:1')
})

it('rejects a direct .generate( inside agents/ — the boundary is structured(), not the folder', () => {
  const { code, output } = runCheck('c5-model-boundary.mjs', {
    ...structured,
    'src/mastra/agents/job-scout.ts': 'export const f = (agent: any) =>\n  agent.generate(prompt, opts)',
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/agents/job-scout.ts:2')
})

it('rejects a .stream( and a Legacy variant anywhere in src/', () => {
  const { code, output } = runCheck('c5-model-boundary.mjs', {
    ...structured,
    'src/mastra/commands/summarize.ts': 'await agent.stream(message)',
    'src/services/x.ts': 'await agent.generateLegacy(message)',
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/commands/summarize.ts:1')
  expect(output).toContain('src/services/x.ts:1')
})

it('allows the call in structured.ts, agents in agents/, and the words in comments, strings and tests', () => {
  const { code } = runCheck('c5-model-boundary.mjs', {
    ...structured,
    'src/mastra/agents/curator.ts': "const ranker = new Agent({ id: 'ranker' })",
    'src/mastra/agents/summarizer.ts': "// calling `generate()` by hand\nconst s = 'agent.generate(x)'",
    'src/mastra/agents/__tests__/structured.test.ts': 'const agent = { generate: async () => ({}) }; agent.generate(1)',
    'src/services/job-scout.ts': "import { proposeCompanies } from '../mastra/agents/job-scout.js'",
  })
  expect(code).toBe(0)
})

it('passes on this repo', () => {
  expect(runCheck('c5-model-boundary.mjs', {}, REPO_ROOT).code).toBe(0)
})
