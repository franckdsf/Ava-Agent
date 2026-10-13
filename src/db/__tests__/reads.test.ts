import { beforeAll, describe, expect, it } from 'vitest'

import { db, migrate } from '../client.js'
import { recentPostings } from '../jobs.js'
import { getSignal } from '../leads.js'
import { jobs, leadSignals } from '../schema.js'

/**
 * The reads slice 7 moved into `src/db/` from the leads pipeline — `hiringSignalsFromJobs`'s window
 * and `find-leads`' signal lookup, which reached the database through three dynamic imports.
 */

const DAY = 86_400_000
const now = Date.now()

beforeAll(async () => {
  await migrate()
  const posting = (id: string, discoveredAt: number) => ({
    id,
    identity: id,
    sourceId: 'remotive',
    company: `Company ${id}`,
    title: 'Engineer',
    remote: 'remote' as const,
    url: `https://example.com/${id}`,
    tags: [],
    derivedTags: [],
    discoveredAt,
  })
  await db()
    .insert(jobs)
    .values([posting('j-old', now - 40 * DAY), posting('j-mid', now - 2 * DAY), posting('j-new', now - DAY)])
  await db().insert(leadSignals).values({
    id: 's1',
    leadId: 'l1',
    kind: 'hiring',
    sourceUrl: 'https://example.com/j-new',
    origin: 'jobs',
    occurredAt: now - DAY,
    summary: 'Hiring an engineer',
    discoveredAt: now - DAY,
  })
})

describe('recentPostings', () => {
  it('returns postings discovered since the cutoff, newest first, up to the limit', async () => {
    const rows = await recentPostings(now - 30 * DAY, 10)
    expect(rows.map(row => row.url)).toEqual(['https://example.com/j-new', 'https://example.com/j-mid'])
    expect(await recentPostings(now - 30 * DAY, 1)).toHaveLength(1)
  })
})

describe('getSignal', () => {
  it('returns the signal by id, and null for one that does not exist', async () => {
    expect(await getSignal('s1')).toMatchObject({ id: 's1', summary: 'Hiring an engineer' })
    expect(await getSignal('nope')).toBeNull()
  })
})
