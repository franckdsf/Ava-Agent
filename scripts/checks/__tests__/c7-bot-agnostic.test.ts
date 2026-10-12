import { afterEach, expect, it } from 'vitest'

import { cleanupTrees, REPO_ROOT, runCheck } from './_harness.js'

afterEach(cleanupTrees)

/** The two bots this repo runs, as files — which is how the check learns their names. */
const bots = {
  'src/bots/index.ts': 'export const BOTS = []',
  'src/bots/newy.ts': "export const NEWY_BOT = { id: 'newy' }",
  'src/bots/joob.ts': "export const JOOB_BOT = { id: 'joob' }",
}

it("rejects a shared layer importing a bot's data — the first step back to a copy per bot", () => {
  const { code, output } = runCheck('c7-bot-agnostic.mjs', {
    ...bots,
    'src/services/telegram.ts': "import { JOOB_TOPICS } from '../bots/joob.js'",
  })
  expect(code).toBe(1)
  expect(output).toContain('src/services/telegram.ts:1')
  expect(output).toContain('JOOB_TOPICS')
})

it('rejects a special case on a bot id in the registrar, string or not', () => {
  const { code, output } = runCheck('c7-bot-agnostic.mjs', {
    ...bots,
    'src/mastra/registrar.ts': "export const x = (id: string) => id === 'Newy'",
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/registrar.ts:1')
})

it('allows a bot name in a comment, in a test, and in everything a bot owns', () => {
  const { code } = runCheck('c7-bot-agnostic.mjs', {
    ...bots,
    'src/config/memory.ts': '/** What Newy remembers about the reader. */\nexport const memoryConfig = {}',
    'src/services/__tests__/telegram.test.ts': "import { JOOB_BOT } from '../../bots/joob.js'",
    'src/mastra/workflows/find-jobs.ts': "const joobTelegram = transportFor(JOOB_BOT)",
    'src/mastra/commands/newy.ts': 'export const NEWY_SURFACE = {}',
  })
  expect(code).toBe(0)
})

it('learns a new bot from its file in src/bots/, with nothing to add to the check', () => {
  const { code, output } = runCheck('c7-bot-agnostic.mjs', {
    ...bots,
    'src/bots/scribe.ts': "export const SCRIBE_BOT = { id: 'scribe' }",
    'src/db/client.ts': 'export const scribeOnly = true',
  })
  expect(code).toBe(1)
  expect(output).toContain('src/db/client.ts:1')
})

it('does not match a word that merely contains a bot name', () => {
  const { code } = runCheck('c7-bot-agnostic.mjs', {
    ...bots,
    'src/lib/x.ts': 'export const renewy = 1',
  })
  expect(code).toBe(0)
})

it('passes on this repo', () => {
  expect(runCheck('c7-bot-agnostic.mjs', {}, REPO_ROOT).code).toBe(0)
})
