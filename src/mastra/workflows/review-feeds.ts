import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { discovery } from '../../config/discovery.js'
import { env } from '../../config/env.js'
import { feedReview } from '../../config/feed-review.js'
import { pipeline } from '../../config/pipeline.js'
import {
  articleIdsFromFeed,
  feedPerformance,
  linkToBeats,
  type FeedPerformance,
} from '../../db/articles.js'
import {
  activeBeats,
  archiveFeedForReview,
  feedsDueForRetrial,
  feedsForBeats,
  liveFeedsWithTrials,
  restoreFeed,
  type Beat,
  type RetriableFeed,
} from '../../db/beats.js'
import { escapeMarkdown } from '../../services/telegram.js'
import { newyTelegram } from '../../services/newy-telegram.js'

/**
 * The weekly feed review — drop what earns nothing, re-test it a month later,
 * top the beat back up.
 *
 * Feeds only ever accumulated before this. `/follow` attaches up to eight,
 * `/addfeed` adds more, and nothing took any away — while every feed is fetched
 * on every digest and every article it brings is ranked. A source that has never
 * produced anything worth sending is not free; it is a standing bill and a
 * diluted ranking batch.
 *
 * **Three things happen, in this order, and the order matters.**
 *
 * 1. **Restore** first. Feeds archived a month ago come back *before* anything
 *    is measured, so they spend the coming week collecting a fresh sample rather
 *    than being judged on the empty one they have now. Restoring after pruning
 *    would let a feed be brought back and archived again in the same run.
 * 2. **Prune** what the evidence condemns, under every guard in
 *    `src/config/feed-review.ts`.
 * 3. **Top up** beats left under the cap, through the same discovery path
 *    `/follow` uses — so the job is a net improvement rather than a slow drain.
 *
 * **The default posture is to do nothing.** Every threshold in the config exists
 * to prevent one specific way this job could do harm, because its failure mode
 * is silent and expensive: a beat that quietly loses good sources and simply
 * gets quieter. The guard that matters most is `minBeatDelivered` — if a beat
 * has sent nothing at all, the fault is the beat, and *every* feed on it will
 * look worthless. Read that field's note before touching any of this.
 *
 * **No model runs here**, which keeps it inside invariant 2 without needing the
 * classifier carve-out: the decision is arithmetic over rows the ranker already
 * scored. The top-up step does call the scout, and that is the one model call —
 * it proposes sites, never feed URLs, exactly as in
 * [ADR-0020](../../../docs/decisions/0020-feed-discovery-from-a-subject.md).
 */

const empty = z.object({})

const restored = z.object({
  restored: z.array(z.object({ beatSlug: z.string(), source: z.string(), trials: z.number() })),
})

const pruned = restored.extend({
  archived: z.array(
    z.object({
      beatSlug: z.string(),
      source: z.string(),
      feedUrl: z.string(),
      collected: z.number(),
      bestScore: z.number().nullable(),
      trials: z.number(),
    }),
  ),
  /** Beats the review declined to judge, and why — this is most of the output early on. */
  skipped: z.array(z.object({ beatSlug: z.string(), reason: z.string() })),
})

const toppedUp = pruned.extend({
  added: z.array(z.object({ beatSlug: z.string(), source: z.string() })),
})

const days = (n: number) => n * 24 * 60 * 60 * 1000

/* ─────────────────────────────────── restore ───────────────────────────────── */

/**
 * Brings back feeds archived long enough ago to deserve another month.
 *
 * Their recent articles are linked on the way back in, for the reason
 * `/addfeed` does it: the feed is very likely already polled by another beat, so
 * it answers 304 and the restored subscription would be attached to nothing
 * until its content next changes. `maxItemAgeDays`, never `retentionDays` —
 * retention keeps 30 days and ingest accepts 7, and a full-retention backfill
 * hands a beat three-week-old stories to deliver as news.
 */
const restore = createStep({
  id: 'restore',
  inputSchema: empty,
  outputSchema: restored,
  execute: async () => {
    const due = await feedsDueForRetrial(
      Date.now() - days(feedReview.retryAfterDays),
      feedReview.maxTrials,
    )

    const cutoff = Date.now() - days(pipeline.maxItemAgeDays)
    const back: z.infer<typeof restored>['restored'] = []
    for (const feed of due) {
      await restoreFeed(feed.beatSlug, feed.feedUrl)
      const ids = await articleIdsFromFeed(feed.feedUrl, cutoff)
      await linkToBeats(
        ids.map(id => ({ articleId: id, beatSlug: feed.beatSlug, subtopic: null })),
      )
      back.push({ beatSlug: feed.beatSlug, source: feed.source, trials: feed.trials })
    }
    return { restored: back }
  },
})

/* ──────────────────────────────────── prune ────────────────────────────────── */

/** Why a beat was left alone. Returned rather than logged — early on this is the whole report. */
function reasonToSkip(liveCount: number, beatDelivered: number): string | null {
  if (liveCount <= feedReview.minFeedsPerBeat) {
    return `only ${liveCount} feeds, floor is ${feedReview.minFeedsPerBeat}`
  }
  if (beatDelivered < feedReview.minBeatDelivered) {
    return `the beat itself delivered ${beatDelivered} in ${feedReview.windowDays} days — ` +
      `too few to blame any one feed`
  }
  return null
}

/** What the review decided about one beat, before anything is written. */
export interface BeatVerdict {
  /** Feeds to archive, worst first. Empty whenever `skip` is set. */
  archive: { feed: RetriableFeed; stats: FeedPerformance }[]
  /** Why nothing was touched, or null when the beat was judged. */
  skip: string | null
}

/**
 * Decides which of a beat's feeds have earned their removal. Pure — writes
 * nothing, reads nothing.
 *
 * Exported and separated from the step for one reason: **this is the function
 * that can do harm**, and a decision that can only be exercised by running a
 * workflow on a schedule is a decision that never gets tested. Every guard in
 * `src/config/feed-review.ts` is applied here, so a fixture can prove each one
 * holds.
 *
 * The order of the checks is the order of the reasoning, and each rejects a
 * different way of being wrong:
 *
 * - too few feeds → never leave a beat one outage from silence
 * - the beat delivered nothing → the fault is the beat, not its sources
 * - too few collected / ranked → no sample, no verdict
 * - delivered something → obviously earning its place
 * - ever cleared the beat's threshold → it produced deliverable work and lost
 *   arbitration, which is not the same as being bad
 */
export function verdictForBeat(
  beat: Beat,
  live: readonly RetriableFeed[],
  performance: readonly FeedPerformance[],
): BeatVerdict {
  const beatDelivered = performance.reduce((total, row) => total + row.delivered, 0)
  const skip = reasonToSkip(live.length, beatDelivered)
  if (skip) return { archive: [], skip }

  const byUrl = new Map(performance.map(row => [row.feedUrl, row]))
  const room = Math.min(feedReview.maxArchivedPerRun, live.length - feedReview.minFeedsPerBeat)

  const archive = live
    .flatMap(feed => {
      const stats = byUrl.get(feed.feedUrl)
      return stats ? [{ feed, stats }] : []
    })
    .filter(({ stats }) => {
      if (stats.collected < feedReview.minCollected) return false
      if (stats.ranked < feedReview.minRanked) return false
      if (stats.delivered > 0) return false
      // The guard that stops a good feed being punished for losing arbitration:
      // a story it produced *did* clear the beat's bar, and another beat or a
      // better story simply took the slot.
      if (stats.bestScore !== null && stats.bestScore >= beat.digestThreshold) return false
      return true
    })
    // Worst first, so a capped run drops the least defensible ones.
    .sort((a, b) => (a.stats.bestScore ?? 0) - (b.stats.bestScore ?? 0))
    .slice(0, Math.max(0, room))

  return { archive, skip: null }
}

const prune = createStep({
  id: 'prune',
  inputSchema: restored,
  outputSchema: pruned,
  execute: async ({ inputData }) => {
    const since = Date.now() - days(feedReview.windowDays)
    const archived: z.infer<typeof pruned>['archived'] = []
    const skipped: z.infer<typeof pruned>['skipped'] = []

    for (const beat of await activeBeats()) {
      const verdict = verdictForBeat(
        beat,
        await liveFeedsWithTrials(beat.slug),
        await feedPerformance(beat.slug, since),
      )

      if (verdict.skip) {
        skipped.push({ beatSlug: beat.slug, reason: verdict.skip })
        continue
      }

      for (const { feed, stats } of verdict.archive) {
        const trials = feed.trials + 1
        await archiveFeedForReview(beat.slug, feed.feedUrl, 'underperforming', trials)
        archived.push({
          beatSlug: beat.slug,
          source: feed.source,
          feedUrl: feed.feedUrl,
          collected: stats.collected,
          bestScore: stats.bestScore,
          trials,
        })
      }
    }

    return { ...inputData, archived, skipped }
  },
})

/* ─────────────────────────────────── top up ────────────────────────────────── */

/**
 * Refills beats left under the cap, through the discovery workflow.
 *
 * Started rather than inlined so the search, the verification and the attach are
 * the *same* steps `/follow` runs — a second copy of that logic would drift, and
 * the one that matters is "never write a feed URL a model supplied".
 *
 * `activate: false`: a top-up must never un-pause a beat the reader paused.
 * Awaited here, unlike the fire-and-forget start in `/follow`, because nothing
 * is waiting on a phone and the report should say what was actually added.
 */
const topUp = createStep({
  id: 'top-up',
  inputSchema: pruned,
  outputSchema: toppedUp,
  execute: async ({ inputData, mastra }) => {
    if (!feedReview.topUp) return { ...inputData, added: [] }

    const added: z.infer<typeof toppedUp>['added'] = []
    for (const beat of await activeBeats()) {
      const live = await feedsForBeats([beat.slug])
      if (live.length >= discovery.maxFeedsPerBeat) continue

      try {
        const run = await mastra.getWorkflow('discoverFeeds').createRun()
        const result = await run.start({
          inputData: {
            slug: beat.slug,
            // The beat's own title is the best query available here — the
            // reader's original phrasing was never stored. English already.
            subject: `${beat.title} news and analysis`,
            activate: false,
          },
        })
        // `attachedFeeds`, never `results`. A top-up runs precisely when the beat
        // is a feed or two under the cap, so discovery routinely resolves more
        // than there is room for — counting the results would have this report
        // name sources the run never subscribed.
        const attached = result.status === 'success' ? result.result : undefined
        for (const row of attached?.attachedFeeds ?? []) {
          added.push({ beatSlug: beat.slug, source: row.source })
        }
      } catch (error) {
        // One beat failing to top up must not cost the pruning that already
        // happened, nor the other beats' turns.
        mastra.getLogger()?.error('Top-up failed for a beat', { beat: beat.slug, error })
      }
    }
    return { ...inputData, added }
  },
})

/* ─────────────────────────────────── report ────────────────────────────────── */

const report = createStep({
  id: 'report',
  inputSchema: toppedUp,
  outputSchema: toppedUp.extend({ reported: z.boolean() }),
  execute: async ({ inputData, mastra }) => {
    // Nothing happened and nothing was worth saying. A weekly message reading
    // "no changes" every week for two months trains the reader to ignore it.
    const quiet =
      inputData.archived.length === 0 &&
      inputData.restored.length === 0 &&
      inputData.added.length === 0
    if (quiet) return { ...inputData, reported: false }

    try {
      await newyTelegram.sendToTelegram(renderFeedReview(inputData), 'chat')
      return { ...inputData, reported: true }
    } catch (error) {
      mastra.getLogger()?.error('Could not report the feed review', error)
      return { ...inputData, reported: false }
    }
  },
})

/** Exported unsent, so the block structure is checkable offline. */
export function renderFeedReview(input: z.infer<typeof toppedUp>): string {
  const blocks: string[] = ['## Feed review']

  if (input.archived.length > 0) {
    blocks.push(
      `**Dropped ${input.archived.length}** — nothing they brought in ${feedReview.windowDays} ` +
        `days ever cleared the beat's bar.`,
      input.archived
        .map(
          row =>
            `- **${escapeMarkdown(row.source)}** \`${row.beatSlug}\`\n` +
            `  ${row.collected} articles, best score ${row.bestScore ?? '—'}` +
            (row.trials >= feedReview.maxTrials
              ? ' · final — it won\'t be tried again'
              : ` · back in ${feedReview.retryAfterDays} days for another go`),
        )
        .join('\n'),
    )
  }

  if (input.restored.length > 0) {
    blocks.push(
      `**Back for another month:** ` +
        input.restored.map(row => `${escapeMarkdown(row.source)} (\`${row.beatSlug}\`)`).join(', ') +
        '.',
    )
  }

  if (input.added.length > 0) {
    blocks.push(
      `**Added ${input.added.length}:** ` +
        input.added.map(row => `${escapeMarkdown(row.source)} (\`${row.beatSlug}\`)`).join(', ') +
        '.',
    )
  }

  if (input.skipped.length > 0) {
    blocks.push(
      `Left alone: ` +
        input.skipped.map(row => `\`${row.beatSlug}\` (${row.reason})`).join(', ') +
        '.',
    )
  }

  blocks.push('`/beat <slug>` shows what each feed is contributing.')
  return blocks.join('\n\n')
}

export const reviewFeedsWorkflow = createWorkflow({
  id: 'review-feeds',
  inputSchema: empty,
  outputSchema: toppedUp.extend({ reported: z.boolean() }),
  schedule: {
    cron: `0 ${feedReview.reviewHour} * * ${feedReview.reviewWeekday}`,
    timezone: env.AGENT_TIMEZONE,
    inputData: {},
  },
})
  .then(restore)
  .then(prune)
  .then(topUp)
  .then(report)
  .commit()
