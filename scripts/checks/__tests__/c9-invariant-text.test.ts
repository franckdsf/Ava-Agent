import { afterEach, expect, it } from 'vitest'

import { cleanupTrees, REPO_ROOT, runCheck } from './_harness.js'

afterEach(cleanupTrees)

const polling = {
  'src/mastra/agents/chat-agent.ts': "createTelegramAdapter({ botToken: t, mode: 'polling' })",
}

const compose = (ports: string, extra = '') =>
  `services:\n  ava:\n    image: ava\n${extra}    ports:\n      # loopback only\n${ports}\nvolumes:\n  ava-data:\n`

it("rejects mode: 'auto' — it falls back to a webhook", () => {
  const { code, output } = runCheck('c9-invariant-text.mjs', {
    'src/mastra/agents/chat-agent.ts': "createTelegramAdapter({ botToken: t, mode: 'auto' })",
  })
  expect(code).toBe(1)
  expect(output).toContain("`mode: 'auto'`")
  expect(output).toContain('does not say `mode: \'polling\'`')
})

it('rejects a mode on an outbound adapter', () => {
  const { code, output } = runCheck('c9-invariant-text.mjs', {
    ...polling,
    'src/services/telegram.ts': "const a = createTelegramAdapter({\n  botToken: t,\n  mode: 'polling',\n})",
  })
  expect(code).toBe(1)
  expect(output).toContain('src/services/telegram.ts:1')
})

it('rejects a port not bound to loopback, and a replica count', () => {
  const { code, output } = runCheck('c9-invariant-text.mjs', {
    ...polling,
    'docker-compose.yml': compose("      - '4111:4111'", '    deploy:\n      replicas: 2\n'),
  })
  expect(code).toBe(1)
  expect(output).toContain('`4111:4111`')
  expect(output).toContain('`replicas:`')
})

it('rejects a tool or command reaching curateAll, by name or by id', () => {
  const { code, output } = runCheck('c9-invariant-text.mjs', {
    ...polling,
    'src/mastra/tools/news.ts': 'await curateAll.createRun()',
    'src/mastra/commands/beats.ts': "mastra.getWorkflow('curate-all')",
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/tools/news.ts:1')
  expect(output).toContain('src/mastra/commands/beats.ts:1')
})

it('rejects the jobs workflow importing the leads tables, and a mastra_ table in the schema', () => {
  const { code, output } = runCheck('c9-invariant-text.mjs', {
    ...polling,
    'src/mastra/workflows/find-jobs.ts': "import { insertSignals } from '../../db/leads.js'",
    'src/db/schema.ts': "export const t = sqliteTable('mastra_threads', {})",
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/workflows/find-jobs.ts:1')
  expect(output).toContain('src/db/schema.ts:1')
})

it('allows the rules explained in comments, an outbound adapter with no mode, and loopback ports', () => {
  const { code } = runCheck('c9-invariant-text.mjs', {
    ...polling,
    'src/services/telegram.ts': "// never mode: 'auto'\nconst a = createTelegramAdapter({ botToken: t })",
    'src/mastra/commands/beats.ts': '/** Nothing here starts `curateAll`. */\nexport const x = 1',
    'docker-compose.yml': compose("      - '127.0.0.1:${AVA_HOST_PORT:-4111}:4111'"),
  })
  expect(code).toBe(0)
})

it('passes on this repo', () => {
  expect(runCheck('c9-invariant-text.mjs', {}, REPO_ROOT).code).toBe(0)
})
