/**
 * Shows the weekly feed review's report, and what a run *today* would do to the
 * live beats, read-only.
 *
 *     pnpm review:check
 *
 * `verdictForBeat` is the one function in this repo that can take a source away
 * from a beat, and its failure mode is silent: the digests just get thinner. It
 * runs weekly on a schedule nobody watches, so without this it would be
 * exercised for the first time in production, on real data, unobserved.
 *
 * Every guard in `src/config/feed-review.ts` has its case in
 * `src/mastra/workflows/__tests__/review-feeds.test.ts`, which `pnpm verify`
 * runs. When you add or change a guard, add the case there — a threshold with
 * no test is a threshold that silently stops applying.
 *
 * Reads the live database. Writes nothing.
 */
delete process.env.NEWY_TELEGRAM_BOT_TOKEN

import { feedReview } from '../src/config/feed-review.js'
import { feedPerformance } from '../src/db/articles.js'
import { activeBeats, liveFeedsWithTrials } from '../src/db/beats.js'
import { renderFeedReview, verdictForBeat } from '../src/mastra/workflows/review-feeds.js'

console.log('\n== the report, as the reader sees it ==')
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
console.log()
