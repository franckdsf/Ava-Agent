import { describe, expect, it } from 'vitest'

import { feedReview } from '../../../config/feed-review.js'
import type { FeedPerformance } from '../../../db/articles.js'
import type { RetriableFeed } from '../../../db/beats.js'
import { verdictForBeat } from '../review-feeds.js'

// `verdictForBeat` is the one function in this repo that can take a source away from a beat, and
// its failure mode is silent: the digests just get thinner. Every guard in
// `src/config/feed-review.ts` gets a case here. What a run *today* would do to the live beats is
// `pnpm review:check`. The beat's threshold is applied upstream, in `feedPerformance`'s `cleared`
// count — `src/db/__tests__/reads.test.ts` covers that half.

const feed = (url: string, trials = 0): RetriableFeed => ({
  beatSlug: 'test',
  feedUrl: url,
  source: url,
  trials,
})

const stats = (url: string, over: Partial<FeedPerformance> = {}): FeedPerformance => ({
  feedUrl: url,
  collected: 100,
  ranked: 100,
  delivered: 0,
  cleared: 0,
  meanScore: 20,
  bestScore: 30,
  ...over,
})

/** A feed doing its job: half of what it brings clears the bar. */
const healthy = stats('a', { delivered: 5, cleared: 50, bestScore: 90 })

// A beat with enough live feeds and a healthy delivery record, so the beat-level guards are
// satisfied and the per-feed ones are what is being tested.
const liveFive = ['a', 'b', 'c', 'd', 'e'].map(url => feed(url))
const deliveringBeat = (...over: FeedPerformance[]) => [healthy, ...over]

/** `cleared` hits in a hundred scored — the hit rate as a percentage. */
const hits = (cleared: number, over: Partial<FeedPerformance> = {}) => stats('b', { cleared, ...over })
/** `minHitRate` as hits in a hundred — the smallest count that keeps a feed. */
const atRate = Math.round(feedReview.minHitRate * 100)

describe('the beat-level guards', () => {
  it('a beat at the feed floor is never pruned', () => {
    expect(verdictForBeat(liveFive.slice(0, feedReview.minFeedsPerBeat), deliveringBeat(stats('b'))).skip).not.toBeNull()
  })
  it('a beat that delivered nothing loses no feeds, however bad they look', () => {
    expect(verdictForBeat(liveFive, [stats('a'), stats('b'), stats('c'), stats('d'), stats('e')]).skip).not.toBeNull()
  })
  it('a beat that delivers is judged', () => {
    expect(verdictForBeat(liveFive, deliveringBeat(stats('b'))).skip).toBeNull()
  })
})

describe('the per-feed guards', () => {
  it('a dead feed with a full sample is archived', () => {
    expect(verdictForBeat(liveFive, deliveringBeat(stats('b'))).archive.map(a => a.feed.feedUrl)).toEqual(['b'])
  })
  it('too few collected — no verdict', () => {
    expect(verdictForBeat(liveFive, deliveringBeat(stats('b', { collected: 5, ranked: 5 }))).archive).toHaveLength(0)
  })
  it('collected but not yet ranked — no verdict', () => {
    expect(verdictForBeat(liveFive, deliveringBeat(stats('b', { collected: 100, ranked: 2 }))).archive).toHaveLength(0)
  })
  it('a feed with no rows at all is untouched, not archived', () => {
    expect(verdictForBeat(liveFive, deliveringBeat()).archive).toHaveLength(0)
  })
})

// Until 2026-10-13 one sent story, or one that cleared the bar, kept a feed for good — so a
// site-wide feed with one real story a month in hundreds of off-topic ones was never dropped.
describe('the hit rate', () => {
  it(`a feed whose hits reach minHitRate (${atRate}%) is kept`, () => {
    expect(verdictForBeat(liveFive, deliveringBeat(hits(atRate, { delivered: 1 }))).archive).toHaveLength(0)
  })
  it('just below it, the feed is archived', () => {
    expect(
      verdictForBeat(liveFive, deliveringBeat(hits(atRate - 1, { delivered: 1 }))).archive.map(a => a.feed.feedUrl),
    ).toEqual(['b'])
  })
  it('one hit in a hundred is archived even though it was sent — the site-wide feed', () => {
    expect(
      verdictForBeat(liveFive, deliveringBeat(hits(1, { delivered: 1, bestScore: 90 }))).archive.map(a => a.feed.feedUrl),
    ).toEqual(['b'])
  })
  it('hits that lost arbitration count — a good feed is not punished for losing slots', () => {
    expect(verdictForBeat(liveFive, deliveringBeat(hits(atRate, { delivered: 0 }))).archive).toHaveLength(0)
  })
  it('the rate is over what was scored, not what was collected', () => {
    // 2 hits in 20 scored is 10%, though it is 2% of the 100 collected.
    expect(verdictForBeat(liveFive, deliveringBeat(hits(2, { collected: 100, ranked: 20 }))).archive).toHaveLength(0)
  })
})

describe('the caps', () => {
  it('at most maxArchivedPerRun in one run', () => {
    expect(verdictForBeat(liveFive, [healthy, stats('b'), stats('c'), stats('d'), stats('e')]).archive).toHaveLength(
      feedReview.maxArchivedPerRun,
    )
  })
  it('pruning stops at the floor even when more qualify', () => {
    expect(verdictForBeat(liveFive.slice(0, 4), [healthy, stats('b'), stats('c'), stats('d')]).archive).toHaveLength(1)
  })
  it('the worst feed goes first — lowest hit rate, then lowest best score', () => {
    expect(
      verdictForBeat(liveFive, [
        healthy,
        stats('b', { bestScore: 55 }),
        stats('c', { bestScore: 10 }),
        stats('d', { cleared: 3, bestScore: 80 }),
      ]).archive.map(a => a.feed.feedUrl),
    ).toEqual(['c', 'b'])
  })
})
