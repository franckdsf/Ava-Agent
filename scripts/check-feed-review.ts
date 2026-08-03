/**
 * Exercises the weekly feed review's decision against fixtures, and against the
 * live beats read-only.
 *
 *     pnpm review:check
 *
 * `verdictForBeat` is the one function in this repo that can take a source away
 * from a beat, and its failure mode is silent: the digests just get thinner. It
 * runs weekly on a schedule nobody watches, so without this it would be
 * exercised for the first time in production, on real data, unobserved.
 *
 * Every guard in `src/config/feed-review.ts` gets a case here. When you add or
 * change one, add the case that proves it — a threshold with no test is a
 * threshold that silently stops applying.
 *
 * Reads the live database to report what a run *today* would do. Writes nothing.
 */
delete process.env.NEWY_TELEGRAM_BOT_TOKEN

import { feedReview } from '../src/config/feed-review.js'
import { pipeline } from '../src/config/pipeline.js'
import { feedPerformance, type FeedPerformance } from '../src/db/articles.js'
import { activeBeats, liveFeedsWithTrials, type Beat, type RetriableFeed } from '../src/db/beats.js'
import { renderFeedReview, verdictForBeat } from '../src/mastra/workflows/review-feeds.js'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

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

// A beat with enough live feeds and a healthy delivery record, so the beat-level
// guards are satisfied and the per-feed ones are what is being tested.
const healthy = ['a', 'b', 'c', 'd', 'e']
const liveFive = healthy.map(url => feed(url))
const deliveringBeat = (...over: FeedPerformance[]) => [
  stats('a', { delivered: 5, bestScore: 90 }),
  ...over,
]

console.log('\n== the beat-level guards ==')
check(
  'a beat at the feed floor is never pruned',
  verdictForBeat(beat(), liveFive.slice(0, feedReview.minFeedsPerBeat), deliveringBeat(stats('b')))
    .skip !== null,
  true,
)
check(
  'a beat that delivered nothing loses no feeds, however bad they look',
  verdictForBeat(beat(), liveFive, [stats('a'), stats('b'), stats('c'), stats('d'), stats('e')])
    .skip !== null,
  true,
)
check(
  'a beat that delivers is judged',
  verdictForBeat(beat(), liveFive, deliveringBeat(stats('b'))).skip,
  null,
)

console.log('\n== the per-feed guards ==')
check(
  'a dead feed with a full sample is archived',
  verdictForBeat(beat(), liveFive, deliveringBeat(stats('b'))).archive.map(a => a.feed.feedUrl),
  ['b'],
)
check(
  'too few collected — no verdict',
  verdictForBeat(beat(), liveFive, deliveringBeat(stats('b', { collected: 5, ranked: 5 })))
    .archive.length,
  0,
)
check(
  'collected but not yet ranked — no verdict',
  verdictForBeat(beat(), liveFive, deliveringBeat(stats('b', { collected: 100, ranked: 2 })))
    .archive.length,
  0,
)
check(
  'a feed that delivered even once is kept',
  verdictForBeat(beat(), liveFive, deliveringBeat(stats('b', { delivered: 1 }))).archive.length,
  0,
)
check(
  'a feed that cleared the threshold but lost arbitration is kept',
  verdictForBeat(
    beat(),
    liveFive,
    deliveringBeat(stats('b', { delivered: 0, bestScore: pipeline.defaultDigestThreshold })),
  ).archive.length,
  0,
)
check(
  'a feed with no rows at all is untouched, not archived',
  verdictForBeat(beat(), liveFive, deliveringBeat()).archive.length,
  0,
)

console.log('\n== the caps ==')
check(
  'at most maxArchivedPerRun in one run',
  verdictForBeat(beat(), liveFive, [
    stats('a', { delivered: 5, bestScore: 90 }),
    stats('b'),
    stats('c'),
    stats('d'),
    stats('e'),
  ]).archive.length,
  feedReview.maxArchivedPerRun,
)
check(
  'pruning stops at the floor even when more qualify',
  verdictForBeat(beat(), liveFive.slice(0, 4), [
    stats('a', { delivered: 5, bestScore: 90 }),
    stats('b'),
    stats('c'),
    stats('d'),
  ]).archive.length,
  1,
)
check(
  'the worst feed goes first',
  verdictForBeat(beat(), liveFive, [
    stats('a', { delivered: 5, bestScore: 90 }),
    stats('b', { bestScore: 55 }),
    stats('c', { bestScore: 10 }),
  ]).archive.map(a => a.feed.feedUrl),
  ['c', 'b'],
)
check(
  'a beat with a high threshold does not lose feeds that scored well',
  verdictForBeat(beat({ digestThreshold: 40 }), liveFive, deliveringBeat(stats('b', { bestScore: 45 })))
    .archive.length,
  0,
)

console.log('\n== the report ==')
const message = renderFeedReview({
  restored: [{ beatSlug: 'design', source: 'WebKit', trials: 1 }],
  archived: [
    { beatSlug: 'computer-science', source: 'arXiv cs.AI', feedUrl: 'x', collected: 340, bestScore: 31, trials: 1 },
  ],
  skipped: [{ beatSlug: 'formula-1', reason: 'only 4 feeds, floor is 3' }],
  added: [{ beatSlug: 'design', source: 'Smashing' }],
})
console.log(message.split('\n').map(line => `   > ${line}`).join('\n'))

console.log('\n== what a run TODAY would do, against the live database ==')
const since = Date.now() - feedReview.windowDays * 24 * 60 * 60 * 1000
for (const live of await activeBeats()) {
  const verdict = verdictForBeat(live, await liveFeedsWithTrials(live.slug), await feedPerformance(live.slug, since))
  console.log(
    `   ${live.slug}: ` +
    (verdict.skip ? `skipped — ${verdict.skip}` : `would archive ${verdict.archive.map(a => a.feed.source).join(', ') || 'nothing'}`),
  )
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
