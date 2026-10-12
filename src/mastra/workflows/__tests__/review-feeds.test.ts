import { describe, expect, it } from 'vitest'

import { feedReview } from '../../../config/feed-review.js'
import { pipeline } from '../../../config/pipeline.js'
import type { FeedPerformance } from '../../../db/articles.js'
import type { Beat, RetriableFeed } from '../../../db/beats.js'
import { verdictForBeat } from '../review-feeds.js'

// `verdictForBeat` is the one function in this repo that can take a source away from a beat, and
// its failure mode is silent: the digests just get thinner. Every guard in
// `src/config/feed-review.ts` gets a case here. What a run *today* would do to the live beats is
// `pnpm review:check`.

const beat = (over: Partial<Beat> = {}): Beat => ({
  slug: 'test',
  title: 'Test',
  emoji: '🧪',
  rubric: '',
  subtopics: [],
  digestThreshold: pipeline.defaultDigestThreshold,
  maxItemsPerDigest: 5,
  archivedAt: null,
  ...over,
})

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
  meanScore: 20,
  bestScore: 30,
  ...over,
})

// A beat with enough live feeds and a healthy delivery record, so the beat-level guards are
// satisfied and the per-feed ones are what is being tested.
const liveFive = ['a', 'b', 'c', 'd', 'e'].map(url => feed(url))
const deliveringBeat = (...over: FeedPerformance[]) => [stats('a', { delivered: 5, bestScore: 90 }), ...over]

describe('the beat-level guards', () => {
  it('a beat at the feed floor is never pruned', () => {
    expect(verdictForBeat(beat(), liveFive.slice(0, feedReview.minFeedsPerBeat), deliveringBeat(stats('b'))).skip).not.toBeNull()
  })
  it('a beat that delivered nothing loses no feeds, however bad they look', () => {
    expect(
      verdictForBeat(beat(), liveFive, [stats('a'), stats('b'), stats('c'), stats('d'), stats('e')]).skip,
    ).not.toBeNull()
  })
  it('a beat that delivers is judged', () => {
    expect(verdictForBeat(beat(), liveFive, deliveringBeat(stats('b'))).skip).toBeNull()
  })
})

describe('the per-feed guards', () => {
  it('a dead feed with a full sample is archived', () => {
    expect(verdictForBeat(beat(), liveFive, deliveringBeat(stats('b'))).archive.map(a => a.feed.feedUrl)).toEqual(['b'])
  })
  it('too few collected — no verdict', () => {
    expect(verdictForBeat(beat(), liveFive, deliveringBeat(stats('b', { collected: 5, ranked: 5 }))).archive).toHaveLength(0)
  })
  it('collected but not yet ranked — no verdict', () => {
    expect(verdictForBeat(beat(), liveFive, deliveringBeat(stats('b', { collected: 100, ranked: 2 }))).archive).toHaveLength(0)
  })
  it('a feed that delivered even once is kept', () => {
    expect(verdictForBeat(beat(), liveFive, deliveringBeat(stats('b', { delivered: 1 }))).archive).toHaveLength(0)
  })
  it('a feed that cleared the threshold but lost arbitration is kept', () => {
    expect(
      verdictForBeat(beat(), liveFive, deliveringBeat(stats('b', { delivered: 0, bestScore: pipeline.defaultDigestThreshold })))
        .archive,
    ).toHaveLength(0)
  })
  it('a feed with no rows at all is untouched, not archived', () => {
    expect(verdictForBeat(beat(), liveFive, deliveringBeat()).archive).toHaveLength(0)
  })
})

describe('the caps', () => {
  it('at most maxArchivedPerRun in one run', () => {
    expect(
      verdictForBeat(beat(), liveFive, [
        stats('a', { delivered: 5, bestScore: 90 }),
        stats('b'),
        stats('c'),
        stats('d'),
        stats('e'),
      ]).archive,
    ).toHaveLength(feedReview.maxArchivedPerRun)
  })
  it('pruning stops at the floor even when more qualify', () => {
    expect(
      verdictForBeat(beat(), liveFive.slice(0, 4), [
        stats('a', { delivered: 5, bestScore: 90 }),
        stats('b'),
        stats('c'),
        stats('d'),
      ]).archive,
    ).toHaveLength(1)
  })
  it('the worst feed goes first', () => {
    expect(
      verdictForBeat(beat(), liveFive, [
        stats('a', { delivered: 5, bestScore: 90 }),
        stats('b', { bestScore: 55 }),
        stats('c', { bestScore: 10 }),
      ]).archive.map(a => a.feed.feedUrl),
    ).toEqual(['c', 'b'])
  })
  it('a beat with a high threshold does not lose feeds that scored well', () => {
    expect(
      verdictForBeat(beat({ digestThreshold: 40 }), liveFive, deliveringBeat(stats('b', { bestScore: 45 }))).archive,
    ).toHaveLength(0)
  })
})
