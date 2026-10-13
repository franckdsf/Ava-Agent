import { afterEach, expect, it } from 'vitest'

import { cleanupTrees, REPO_ROOT, runCheck } from './_harness.js'

afterEach(cleanupTrees)

it('rejects the query builder, the client and a table imported outside src/db/', () => {
  const { code, output } = runCheck('c6-data-access.mjs', {
    'src/mastra/tools/news.ts': [
      "import { and, eq } from 'drizzle-orm'",
      "import { db, migrate } from '../../db/client.js'",
      "import {",
      "  articles,",
      "  type Article,",
      "} from '../../db/schema.js'",
    ].join('\n'),
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/tools/news.ts:1')
  expect(output).toContain('src/mastra/tools/news.ts:2')
  expect(output).toContain('src/mastra/tools/news.ts:3')
  expect(output).toContain('`articles`')
})

it('rejects a dynamic import of the client — the shape find-leads used', () => {
  const { code, output } = runCheck('c6-data-access.mjs', {
    'src/mastra/workflows/find-leads.ts': "async function f() {\n  const { db } = await import('../../db/client.js')\n}",
  })
  expect(code).toBe(1)
  expect(output).toContain('src/mastra/workflows/find-leads.ts:2')
})

// A guard: an import pattern that spans statements would read this `db` import as part of the type
// import above it, and skip it. C11's first draft did exactly that.
it('rejects the client imported right after a type import', () => {
  const { code, output } = runCheck('c6-data-access.mjs', {
    'src/services/x.ts': "import type { Job } from '../db/schema.js'\nimport { db } from '../db/client.js'",
  })
  expect(code).toBe(1)
  expect(output).toContain('src/services/x.ts:2')
})

it('rejects batchAll — it writes — and rawClient anywhere but Mastra’s store', () => {
  const { code, output } = runCheck('c6-data-access.mjs', {
    'src/services/x.ts': "import { batchAll } from '../db/client.js'",
    'src/mastra/tools/y.ts': "import { rawClient } from '../../db/client.js'",
  })
  expect(code).toBe(1)
  expect(output).toContain('`batchAll`')
  expect(output).toContain('src/mastra/tools/y.ts:1')
})

it('allows row types, rawClient for Mastra, src/db/ itself, tests, and the words in comments', () => {
  const { code } = runCheck('c6-data-access.mjs', {
    'src/services/x.ts': "import type { Job } from '../db/schema.js'\nimport { type Lead } from '../db/schema.js'",
    'src/mastra/storage.ts': "import { rawClient } from '../db/client.js'",
    'src/db/articles.ts': "import { and } from 'drizzle-orm'\nimport { db, migrate } from './client.js'",
    'src/mastra/tools/__tests__/news.test.ts': "import { db } from '../../../db/client.js'",
    'src/lib/y.ts': "// import { db } from '../db/client.js' — explained, not done\nimport type { SQL } from 'drizzle-orm'",
  })
  expect(code).toBe(0)
})

it('passes on this repo', () => {
  expect(runCheck('c6-data-access.mjs', {}, REPO_ROOT).code).toBe(0)
})
