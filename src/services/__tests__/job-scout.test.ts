import type { Mastra } from '@mastra/core'
import { describe, expect, it } from 'vitest'

import type { JobSearch, JobSource } from '../../db/schema.js'
import { fetchSonarSource } from '../job-scout.js'

const source = { id: 'sonar', kind: 'sonar' } as JobSource
const search = {
  slug: 'founding-engineer-worldwide',
  label: 'Founding engineer',
  request: 'founding engineer, remote, worldwide',
  domain: null,
  locations: [],
  remote: 'remote',
  seniority: [],
  contractTypes: [],
  mustHave: [],
  dealbreakers: [],
  minCompensation: null,
  currency: null,
  notes: null,
} as unknown as JobSearch

/** A Mastra whose job scout answers with `generate` — the only part the sonar source asks for. */
function mastraAnswering(generate: () => Promise<unknown>) {
  return { getAgent: () => ({ generate }), getLogger: () => undefined } as unknown as Mastra
}

/**
 * What the sonar row shows for one search whose scout call failed. The row is the
 * only place "sonar failed" and "sonar found no one" can be told apart — a
 * failed call must land as a problem on it, never as a quiet day (AGENTS.md: a
 * model call that fails must leave its batch untouched, not settle it).
 */
describe('a failed scout call on the sonar row', () => {
  it('lands as a problem when the call throws', async () => {
    const result = await fetchSonarSource(
      source,
      mastraAnswering(async () => {
        throw new Error('402 insufficient credits')
      }),
      [search],
    )
    expect(result.status).toBe('partial')
    expect(result.error).toMatch(/founding-engineer-worldwide: .*402 insufficient credits/)
  })

  // An answer that does not parse is `object: undefined`, which `proposeCompanies` used to
  // turn into "no companies" — a 200 with nothing on the row. Pinned as `it.fails` before
  // the fix; slice 6 step 4 sent the call through structured() with orThrow.
  it('lands as a problem when the answer does not parse', async () => {
    const result = await fetchSonarSource(
      source,
      mastraAnswering(async () => ({ object: undefined })),
      [search],
    )
    expect(result.status).toBe('partial')
    expect(result.error).toMatch(/founding-engineer-worldwide: /)
  })
})
