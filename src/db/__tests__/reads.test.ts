import { beforeAll, describe, expect, it } from 'vitest'

import { feedPerformance } from '../articles.js'
import { db, migrate } from '../client.js'
import { recentPostings } from '../jobs.js'
import { getSignal } from '../leads.js'
import { articleBeats, articles, jobs, leadSignals } from '../schema.js'

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

describe('feedPerformance', () => {
  // The weekly review's hit rate is `cleared / ranked`. The threshold is the beat's own, applied in
  // the query — so a beat with a low bar counts as hits what a default beat would not.
  it("counts as cleared what scored at or above the beat's own threshold, sent or not", async () => {
    const feedUrl = 'https://example.com/site-wide.xml'
    const scores = [45, 40, 39, 10, null]
    await db()
      .insert(articles)
      .values(scores.map((_, i) => ({ id: `p${i}`, feedUrl, source: 'S', title: `t${i}`, link: `https://example.com/${i}`, discoveredAt: now })))
    await db()
      .insert(articleBeats)
      .values(
        scores.map((score, i) => ({ articleId: `p${i}`, beatSlug: 'low-bar', score, rankedAt: score === null ? null : now })),
      )

    const [row] = await feedPerformance({ slug: 'low-bar', digestThreshold: 40 }, now - DAY)
    expect(row).toMatchObject({ feedUrl, collected: 5, ranked: 4, cleared: 2, delivered: 0, bestScore: 45 })
  })
})
