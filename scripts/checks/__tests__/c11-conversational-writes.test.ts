import { afterEach, expect, it } from 'vitest'

import { cleanupTrees, REPO_ROOT, runCheck } from './_harness.js'

afterEach(cleanupTrees)

it('rejects a tool reaching a db function nobody wrote down — a write a run produced, here', () => {
  const { code, output } = runCheck('c11-conversational-writes.mjs', {
    'src/mastra/tools/news.ts': "import { getArticle, saveRankings } from '../../db/articles.js'",
  })
  expect(code).toBe(1)
  expect(output).toContain('`saveRankings`')
  expect(output).not.toContain('`getArticle`')
})

it('reads each import on its own, after imports from elsewhere', () => {
  const { code, output } = runCheck('c11-conversational-writes.mjs', {
    'src/mastra/commands/beats.ts': [
      "import { createTool } from '@mastra/core/tools'",
      "import { pipeline } from '../../config/pipeline.js'",
      "import { claimForDelivery } from '../../db/articles.js'",
    ].join('\n'),
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/commands/beats.ts:3')
  expect(output).toContain('`claimForDelivery`')
})

it('reads a default or namespace import as a name, not only the braced ones', () => {
  const { code, output } = runCheck('c11-conversational-writes.mjs', {
    'src/mastra/tools/news.ts': "import * as articles from '../../db/articles.js'",
  })
  expect(code).toBe(1)
  expect(output).toContain('from db/articles')
})

it('covers the run /follow starts and the chat agents, not the scheduled runs', () => {
  const { code, output } = runCheck('c11-conversational-writes.mjs', {
    'src/mastra/workflows/discover-feeds.ts': "import { saveClusters } from '../../db/articles.js'",
    'src/mastra/agents/newy.ts': "import { recordVote } from '../../db/feedback.js'",
    'src/mastra/workflows/curate-all.ts': "import { saveRankings } from '../../db/articles.js'",
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/workflows/discover-feeds.ts:1')
  expect(output).toContain('src/mastra/agents/newy.ts:1')
  expect(output).not.toContain('curate-all.ts')
})

it('allows the listed reads and writes, row types, and tests', () => {
  const { code } = runCheck('c11-conversational-writes.mjs', {
    'src/mastra/commands/beats.ts': [
      "import { linkToBeats } from '../../db/articles.js'",
      "import { addBeatFeed as add } from '../../db/beats.js'",
    ].join('\n'),
    'src/mastra/tools/targets.ts': "import type { JobSearch } from '../../db/schema.js'\nimport { getSearch } from '../../db/job-searches.js'",
    'src/mastra/tools/__tests__/news.test.ts': "import { saveRankings } from '../../../db/articles.js'",
  })
  expect(code).toBe(0)
})

it('passes on this repo', () => {
  expect(runCheck('c11-conversational-writes.mjs', {}, REPO_ROOT).code).toBe(0)
})
