import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { pipeline } from '../../config/pipeline.js'
import { runNotices } from '../../config/run-notices.js'
import {
  claimForDelivery,
  insertDiscovered,
  isSharedFeedImage,
  linkToBeats,
  listRankedUndelivered,
  listUnranked,
  releaseDelivery,
  saveClusters,
  saveImageUrl,
  saveRankings,
} from '../../db/articles.js'
import { activeBeats, feedsForBeats, getBeat, type Beat } from '../../db/beats.js'
import { recentFeedback } from '../../db/feedback.js'
import { finishRun } from '../../db/runs.js'
import type { Article, ArticleRanking, BeatLink, DiscoveredArticle } from '../../db/types.js'
import { articleBody, fetchOgImage, looksLikeSiteChrome } from '../../services/article.js'
import { clusterItems, dedupeByCluster } from '../../services/cluster.js'
import { dedupeFeeds, fetchFeeds } from '../../services/rss.js'
import { escapeMarkdown } from '../../services/telegram.js'
import {
  rankBatch,
  renderArticleForWriter,
  renderInterestProfile,
  renderRankingPrompt,
  renderReaderProfile,
  writeArticleSummary,
  type ArticleSummary,
} from '../agents/curator.js'
import { NEWS } from '../pipelines.js'
import { transportFor } from '../../bots/index.js'
import { NEWY_BOT } from '../../bots/newy.js'

const newyTelegram = transportFor(NEWY_BOT)

/**
 * One workflow for every beat, on one schedule carrying every digest hour.
 *
 * ingest → rank (per beat) → **arbitrate** → deliver (per beat). Each stage is
 * deterministic except the two LLM calls, which is deliberate: a scheduled job
 * that lets a model choose its own control flow is how you get surprise bills and
 * duplicate messages ([invariant 2](../../../AGENTS.md#invariants)).
 *
 * Three things about this shape are not obvious and are load-bearing.
 *
 * **Ingest is above the fan-out, not inside it.** `feed_state` is keyed by URL
 * globally, so a feed two beats both subscribe to must be fetched exactly once
 * per run — fetching per beat gives the second one a 304 and no articles at all.
 * Ingest therefore collects every subscription, collapses it to distinct URLs,
 * fetches those, and fans the entries back out as `article_beats` rows. The bug
 * this prevents was invisible while beats were hand-written, because no two of
 * them ever shared a feed.
 *
 * **Arbitration sits between ranking and delivery**, and that is why they are
 * two fan-outs rather than one. A story can be scored by several beats and is
 * sent by exactly one — the highest scorer among those clearing their own
 * threshold — and no single beat's run can know it lost. Ranking every beat
 * first, then deciding, is the only ordering that produces a stable answer.
 *
 * **Delivery claims a story before it sends it**, because none of the above
 * survives two of these runs overlapping — and they do overlap, whenever a boot
 * replays more than one missed digest fire. Arbitration decides which beat wins
 * a story *within* a run; `claimForDelivery` is what decides which run wins it
 * ([ADR-0033](../../../docs/decisions/0033-a-delivery-is-claimed-before-it-is-sent.md)).
 *
 * `beats` on the input narrows the run to a named set. That is what makes this
 * testable: a workflow cannot be driven from a script (see the evented-engine
 * gotcha in AGENTS.md), so running one beat from Studio with
 * `{ "beats": ["design"] }` is the only way to exercise it by hand.
 */

const runInput = z.object({
  beats: z
    .array(z.string())
    .optional()
    .describe('Restrict the run to these beat slugs. Omit for every active beat.'),
  /** Skips the overlap guard. For Studio and for a deliberately fired run. */
  force: z.boolean().optional(),
})

/**
 * Run-level counters, carried in workflow state rather than through every
 * schema. The fan-outs replace the data flowing between steps with an array per
 * beat, so ingest's numbers would otherwise be lost by the time anything reports
 * them. Only `ingest` writes here — a `setState` from inside a concurrent
 * `foreach` would race itself.
 */
const runState = z.object({
  /** This run's `pipeline_runs` row; empty when the run never opened. */
  runId: z.string().default(''),
  feedsFetched: z.number(),
  discovered: z.number(),
  linked: z.number(),
  feedErrors: z.array(z.string()),
})

const beatRef = z.object({ beatSlug: z.string() })

const rankedBeat = beatRef.extend({
  pending: z.number(),
  stories: z.number(),
  scored: z.number(),
})

const assignedBeat = rankedBeat.extend({
  /** The articles this beat won, best first and already capped. */
  articleIds: z.array(z.string()),
})

const deliveredBeat = assignedBeat.extend({
  sent: z.number(),
  sendErrors: z.array(z.string()),
})

const runReport = z.object({
  feedsFetched: z.number(),
  discovered: z.number(),
  linked: z.number(),
  feedErrors: z.array(z.string()),
  scored: z.number(),
  sent: z.number(),
  sendErrors: z.array(z.string()),
  beats: z.array(deliveredBeat),
})

/**
 * Fetches every feed the selected beats subscribe to — once each — and attaches
 * what comes back to every beat that asked for it.
 *
 * Returns the beat list rather than counters, because `.foreach()` reads its
 * items from the previous step's output. The counters go to state.
 *
 * **A new subscription is backfilled elsewhere, not here.** A feed already in
 * `feed_state` answers 304, so a beat that starts following a URL another beat
 * already polls would be linked to nothing until that feed next changes — days,
 * on a quiet source. There is nothing to fix at ingest, which cannot tell a new
 * subscription from an old one. `/addfeed` handles it by linking the articles
 * already stored from that URL (`articleIdsFromFeed`), which is strictly better
 * than clearing `feed_state` to force a 200: a re-fetch recovers only what the
 * feed *currently serves*, while the database already holds everything it served
 * this week.
 */
const ingest = createStep({
  id: 'ingest',
  inputSchema: runInput,
  outputSchema: z.array(beatRef),
  stateSchema: runState,
  execute: async ({ inputData, setState, mastra }) => {
    const idle = { runId: '', feedsFetched: 0, discovered: 0, linked: 0, feedErrors: [] as string[] }

    // The claim is one guarded write, so two fires arriving together cannot
    // both pass the gate — a boot used to replay one missed fire per digest row,
    // milliseconds apart ([ADR-0034](../../../docs/decisions/0034-a-pipeline-claims-its-cycle.md)).
    // It is the claim in `deliverBeat` that stops the reader seeing a story
    // twice; this only stops the second run paying for one
    // ([ADR-0033](../../../docs/decisions/0033-a-delivery-is-claimed-before-it-is-sent.md)).
    //
    // Nothing inside the window fetches a feed or calls a model, so a run that
    // stops there — no beats, a run narrowed to a slug that does not exist, no
    // feeds between them, or a read losing the write lock — hands the cycle
    // back. Everything after it has spent it.
    const opened = await NEWS.open({ force: inputData.force }, async ({ abandon }) => {
      const beats = await activeBeats(inputData.beats)
      if (beats.length === 0) return abandon('No active beats to read for.')
      const subscriptions = await feedsForBeats(beats.map(beat => beat.slug))
      const distinct = dedupeFeeds(
        subscriptions.map(subscription => ({
          url: subscription.feedUrl,
          source: subscription.source,
        })),
      )
      if (distinct.length === 0) return abandon('No live feeds between the active beats.')
      return { beats, subscriptions, distinct }
    })
    if (!opened.ok) {
      mastra.getLogger()?.info(`News run skipped: ${opened.note}`)
      await setState(idle)
      return []
    }
    const {
      value: { beats, subscriptions, distinct },
      runId,
    } = opened

    // Announced here rather than at the top of the step, so the notice can name
    // what the run is about to do instead of promising a run that turns out to
    // have no beats and no feeds. The fetch below is the long part — feeds are
    // parallel but `feedTimeoutMs` bounds a run at 20s — and everything after it
    // is model calls, so this is the last cheap moment before the reader would
    // otherwise be looking at nothing.
    //
    // A run with no live feeds abandoned in the window above, so every run
    // here fetches something — which is the bar the closing notice applies too,
    // and the two have to agree: announcing only the start of a run would leave
    // one that looks like it never came back.
    mastra.getLogger()?.info('News run started', { runId, beats: beats.length, feeds: distinct.length })
    if (runNotices.news.start) {
      await newyTelegram
        .notify(renderNewsStart(beats.length, distinct.length), 'chat')
    }

    const results = await fetchFeeds(distinct)

    // One story can arrive from two feeds in the same run. Collapsing here keeps
    // the insert a single statement per article; the primary key would reject
    // the duplicate anyway, but `onConflictDoNothing` counts it as not-inserted
    // and the discovered figure would understate the run.
    const byId = new Map<string, DiscoveredArticle>()
    for (const result of results) {
      for (const article of result.articles) {
        if (!byId.has(article.id)) byId.set(article.id, article)
      }
    }
    const discovered = await insertDiscovered([...byId.values()])

    // The fan-out. Every beat subscribing to a URL gets a link to every article
    // that URL carried — including articles already stored from a previous run,
    // which is how a story reaches a beat that started following its feed later.
    const subscribersByUrl = new Map<string, typeof subscriptions>()
    for (const subscription of subscriptions) {
      const existing = subscribersByUrl.get(subscription.feedUrl)
      if (existing) existing.push(subscription)
      else subscribersByUrl.set(subscription.feedUrl, [subscription])
    }

    const links: BeatLink[] = []
    for (const result of results) {
      for (const subscriber of subscribersByUrl.get(result.feedUrl) ?? []) {
        for (const article of result.articles) {
          links.push({
            articleId: article.id,
            beatSlug: subscriber.beatSlug,
            subtopic: subscriber.subtopic,
          })
        }
      }
    }
    const linked = await linkToBeats(links)

    await setState({
      runId,
      feedsFetched: distinct.length,
      discovered,
      linked,
      feedErrors: [
        ...results
          .filter(result => result.error)
          .map(result => `${result.feedUrl}: ${result.error}`),
        // A feed hitting the per-run cap is not an error — it is a firehose
        // being throttled deliberately — but it must not be silent either: the
        // etag is already saved, so those entries are gone for good. Reported on
        // the same channel because that channel is the one anybody reads.
        ...results
          .filter(result => (result.dropped ?? 0) > 0)
          .map(
            result =>
              `${result.feedUrl}: capped — ${result.dropped} newer-than-${pipeline.maxItemAgeDays}d ` +
              `entries discarded above ${pipeline.maxItemsPerFeedRun}`,
          ),
      ],
    })

    return beats.map(beat => ({ beatSlug: beat.slug }))
  },
})

/**
 * Clusters and scores one beat's pending articles.
 *
 * Cluster and rank are one step rather than two because they are one decision —
 * "what does this beat make of what arrived" — and because a `foreach` over a
 * nested workflow is machinery that could only be tested from Studio. The beat
 * boundary is the granularity worth seeing in a run graph now.
 *
 * The rubric and the subtopic labels are passed here, in the prompt, rather than
 * living in the agent's instructions. That is what lets one ranker agent serve
 * every beat including beats that did not exist at boot.
 */
const rankBeat = createStep({
  id: 'rank-beat',
  inputSchema: beatRef,
  outputSchema: rankedBeat,
  execute: async ({ inputData, mastra }) => {
    const beat = await getBeat(inputData.beatSlug)
    if (!beat) return { ...inputData, pending: 0, stories: 0, scored: 0 }

    const pending = await listUnranked(beat.slug, pipeline.maxItemsPerRankingRun)
    if (pending.length === 0) return { ...inputData, pending: 0, stories: 0, scored: 0 }

    const assignments = clusterItems(pending.map(article => ({ id: article.id, title: article.title })))
    await saveClusters(beat.slug, assignments)
    const stories = new Set(assignments.map(assignment => assignment.clusterId)).size

    // Only one article per story reaches the model; the rest are resolved below
    // so they don't accumulate as permanently unranked.
    const representatives = dedupeByCluster(pending, assignments)
    const representativeIds = new Set(representatives.map(article => article.id))

    // Both reads are independent of each other and of the batch; one round trip
    // rather than two before a call that is already the slow part of the run.
    const [profile, reader] = await Promise.all([
      recentFeedback(beat.slug, pipeline.feedbackWindow).then(renderInterestProfile),
      renderReaderProfile(),
    ])

    // Retried inside `rankBatch`, which also drops any id that wasn't in the batch.
    const verdicts = await rankBatch(
      mastra,
      renderRankingPrompt({ beat, profile, reader, articles: representatives }),
      representativeIds,
      beat.slug,
    )

    // Nothing usable came back, so nothing is written. Falling through to the
    // zeroing below would settle the whole batch at zero and burn it — "the
    // ranker failed" and "none of these are any good" must never be the same
    // value. Left unranked, the next run picks the batch up whole.
    if (verdicts.length === 0) {
      mastra.getLogger()?.warn(`Beat ranker returned nothing for ${beat.slug}; batch left unranked`, {
        pending: pending.length,
      })
      return { ...inputData, pending: pending.length, stories, scored: 0 }
    }

    // Everything the model didn't score — cluster duplicates, plus any article it
    // silently dropped — is settled at zero so it never delivers and never
    // re-enters the batch. The representative carries the story.
    const scoredIds = new Set(verdicts.map(verdict => verdict.id))
    const duplicates: ArticleRanking[] = pending
      .filter(article => !scoredIds.has(article.id))
      .map(article => ({
        id: article.id,
        score: 0,
        subtopic: article.subtopic ?? beat.subtopics[0] ?? 'general',
        reason: representativeIds.has(article.id)
          ? 'Not scored by ranker; skipped this run.'
          : 'Duplicate coverage of a story already in this batch.',
      }))

    await saveRankings(beat.slug, [...verdicts, ...duplicates])
    return { ...inputData, pending: pending.length, stories, scored: verdicts.length }
  },
})

/**
 * Decides which beat sends each story.
 *
 * The one global step in the run, and the reason ranking and delivery are two
 * separate fan-outs. A story scored on three beats is delivered by the one that
 * scored it highest *among those clearing their own threshold* — so a 90 on a
 * beat that wants 62 beats a 70 on a beat that wants 65, and a story that clears
 * nobody's bar is simply not sent.
 *
 * The two orderings here are both load-bearing and both come from the query.
 * `listRankedUndelivered` returns candidates score-descending, so the first
 * verdict seen for an article is its best one, and the per-beat lists inherit
 * that order — which makes "take the first `maxItemsPerDigest`" mean "take the
 * best ones" rather than an arbitrary slice.
 *
 * Only beats in this run compete. Narrowing a run to one beat therefore lets it
 * win stories it would otherwise lose, which is the right behaviour for testing
 * a single beat by hand and worth knowing before reading a Studio run as if it
 * were a scheduled one.
 */
const assignBest = createStep({
  id: 'assign-best',
  inputSchema: z.array(rankedBeat),
  outputSchema: z.array(assignedBeat),
  execute: async ({ inputData }) => {
    if (inputData.length === 0) return []

    const slugs = inputData.map(result => result.beatSlug)
    const beats = await activeBeats(slugs)
    if (beats.length === 0) return inputData.map(result => ({ ...result, articleIds: [] }))

    const thresholds = new Map(beats.map(beat => [beat.slug, beat.digestThreshold]))
    const caps = new Map(beats.map(beat => [beat.slug, beat.maxItemsPerDigest]))

    // The floor bounds the query; each beat's own threshold is applied below,
    // since only the resolved beats know what theirs is.
    const floor = Math.min(...beats.map(beat => beat.digestThreshold))
    const candidates = await listRankedUndelivered(slugs, floor)

    const wonBy = new Map<string, string>()
    for (const candidate of candidates) {
      const threshold = thresholds.get(candidate.beatSlug)
      if (threshold === undefined || candidate.score < threshold) continue
      // First verdict wins because candidates arrive score-descending.
      if (!wonBy.has(candidate.article.id)) wonBy.set(candidate.article.id, candidate.beatSlug)
    }

    const byBeat = new Map<string, string[]>()
    for (const [articleId, beatSlug] of wonBy) {
      const existing = byBeat.get(beatSlug)
      if (existing) existing.push(articleId)
      else byBeat.set(beatSlug, [articleId])
    }

    return inputData.map(result => ({
      ...result,
      articleIds: (byBeat.get(result.beatSlug) ?? []).slice(
        0,
        caps.get(result.beatSlug) ?? pipeline.defaultMaxItemsPerDigest,
      ),
    }))
  },
})

/**
 * Telegram parses `rich_message.markdown` server-side, so this markdown becomes
 * real blocks: a heading, a paragraph, a bullet list. Structure comes from the
 * template and prose from the model — a summarizer asked to emit its own
 * markdown eventually emits a broken link, and the URL is the one part of the
 * message that must be exactly right.
 *
 * The image is deliberately *not* included here; `deliverBeat` prepends it so a
 * URL Telegram refuses can be dropped without rebuilding the message.
 */
function renderMessage(
  beat: Beat,
  article: Article,
  subtopic: string | null,
  summary: ArticleSummary,
): string {
  const footer = [article.source, subtopic]
    .filter((value): value is string => Boolean(value))
    .map(escapeMarkdown)
    .join(' · ')

  // A model that returns an empty point still shouldn't produce an empty bullet.
  const points = summary.points.map(point => point.trim()).filter(Boolean)

  // Blank lines, not newlines: a single newline is a soft wrap in markdown and
  // collapses into the previous line when Telegram renders it.
  return [
    `## ${beat.emoji} [${escapeMarkdown(article.title)}](${article.link})`,
    '',
    summary.lede.trim(),
    ...(points.length > 0 ? ['', ...points.map(point => `- ${escapeMarkdown(point)}`)] : []),
    '',
    `_${footer}_`,
  ].join('\n')
}

/**
 * The feed's own image wins. og:image is only consulted when the feed had none,
 * and survives two checks: it must not look like site chrome, and no sibling
 * article from the same feed may already carry it. Either signal means a
 * site-wide banner, which is worse than showing no image at all.
 */
async function resolveImage(article: Article): Promise<string | null> {
  if (article.imageUrl) return article.imageUrl

  const candidate = await fetchOgImage(article.link)
  if (!candidate) return null
  if (looksLikeSiteChrome(candidate)) return null
  if (await isSharedFeedImage(article.feedUrl, candidate, article.id)) return null

  // Recorded so the next article from this feed can recognise a repeat.
  await saveImageUrl(article.id, candidate)
  return candidate
}

/**
 * Writes and sends the articles one beat won.
 *
 * Composes in parallel and sends sequentially: Telegram preserves the order
 * messages arrive in, and marking each article as it lands means a failure
 * halfway through doesn't re-send the ones that already got there.
 *
 * Counters are returned rather than written to state — this runs inside a
 * concurrent `foreach`, where two `setState` calls would race.
 */
const deliverBeat = createStep({
  id: 'deliver-beat',
  inputSchema: assignedBeat,
  outputSchema: deliveredBeat,
  execute: async ({ inputData, mastra }) => {
    if (inputData.articleIds.length === 0) return { ...inputData, sent: 0, sendErrors: [] }

    const beat = await getBeat(inputData.beatSlug)
    if (!beat) return { ...inputData, sent: 0, sendErrors: ['beat disappeared mid-run'] }

    // Re-read rather than carrying rows through the schema: the arbiter passed
    // ids on purpose, so what is composed is what the database says now.
    const candidates = await listRankedUndelivered([beat.slug], beat.digestThreshold)
    const wanted = new Set(inputData.articleIds)
    const winners = candidates.filter(candidate => wanted.has(candidate.article.id))

    const messages = await Promise.all(
      winners.map(async winner => {
        const body = await articleBody(winner.article)
        // Retried, then degraded to the article's own excerpt. The alternative
        // is a throw inside `Promise.all`, which loses every other message this
        // beat won because one summary came back malformed.
        const summary = (await writeArticleSummary(
          mastra,
          renderArticleForWriter(beat, winner.article, winner.reason, body.text ?? winner.article.excerpt ?? ''),
        )) ?? { lede: winner.article.excerpt?.trim() || winner.article.title, points: [] }
        return {
          articleId: winner.article.id,
          text: renderMessage(beat, winner.article, winner.subtopic, summary),
          imageUrl: await resolveImage(winner.article),
        }
      }),
    )

    let sent = 0
    const sendErrors: string[] = []
    for (const message of messages) {
      // Claim first, send second, and never the other way round. The claim is a
      // single guarded UPDATE, which SQLite serialises, so of two runs holding
      // this story exactly one gets a row back — and the one that gets none must
      // not send. Marking after the send instead is what delivered a digest
      // twice on 2026-08-16: the guard protected the row, and the message was
      // already gone.
      const claimed = await claimForDelivery([message.articleId], beat.slug, 'digest')
      if (claimed.length === 0) {
        // Not an error, and still worth a line: the only way here is another run
        // holding the same story, which is the condition the claim exists for
        // and is otherwise invisible.
        mastra.getLogger()?.info(`${beat.slug}: ${message.articleId} claimed by another run, skipping`)
        continue
      }

      try {
        // Into this beat's own tab. `beat` is the whole row, which is what the
        // transport needs to create the tab the first time this beat wins
        // anything ([ADR-0021](../../../docs/decisions/0021-a-tab-per-beat.md)).
        await newyTelegram.sendArticle(message.text, message.imageUrl, beat)
        sent += 1
      } catch (err) {
        // Hand the claim back, or a bad minute on Telegram's side costs the
        // story permanently — a lock nobody releases is a leak, and this one
        // leaks silently because a claimed row simply stops being a candidate.
        await releaseDelivery(claimed)
        sendErrors.push(`${message.articleId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return { ...inputData, sent, sendErrors }
  },
})

/** Folds the per-beat results back together with the ingest counters from state. */
const report = createStep({
  id: 'report',
  inputSchema: z.array(deliveredBeat),
  outputSchema: runReport,
  stateSchema: runState,
  execute: async ({ inputData, state, mastra }) => {
    const summary = {
      feedsFetched: state.feedsFetched,
      discovered: state.discovered,
      linked: state.linked,
      feedErrors: state.feedErrors,
      scored: inputData.reduce((total, beat) => total + beat.scored, 0),
      sent: inputData.reduce((total, beat) => total + beat.sent, 0),
      sendErrors: inputData.flatMap(beat => beat.sendErrors),
      beats: inputData,
    }

    mastra.getLogger()?.info('News run finished', {
      feeds: summary.feedsFetched,
      discovered: summary.discovered,
      scored: summary.scored,
      sent: summary.sent,
      feedErrors: summary.feedErrors.length,
      sendErrors: summary.sendErrors.length,
    })

    if (state.runId) {
      await finishRun(state.runId, {
        fetched: summary.feedsFetched,
        stored: summary.discovered,
        scored: summary.scored,
        delivered: summary.sent,
        detail: { linked: summary.linked },
      })
    }

    // A run that fetched nothing is a run `ingest` returned early from — no
    // active beats or feeds, or the gate turning a second run away — so there
    // was no start notice either. A closing line on its own would be the only
    // word about a run that never happened, which reads as a failure rather than
    // as an empty schedule or a duplicate correctly refused.
    if (runNotices.news.finish && summary.feedsFetched > 0) {
      await newyTelegram.notify(renderNewsFinish(summary), 'chat')
    }

    return summary
  },
})

/* ────────────────────────────────── notices ────────────────────────────────── */

/**
 * "I'm reading the feeds now."
 *
 * Exported unsent, like every other message rendered in this repo: it is pure,
 * and the failure worth catching offline is a block structure that collapses —
 * `adapter.formatConverter.toAst(text)` answers that without sending anything.
 *
 * Neither notice escapes anything, and that is safe rather than an oversight:
 * every value in both is a number this run counted. The one place reader data
 * reaches these messages is the error list below, which does escape.
 */
export function renderNewsStart(beats: number, feeds: number): string {
  return (
    `📰 **Reading the news now** — ${feeds} feed${feeds === 1 ? '' : 's'} ` +
    `across ${beats} beat${beats === 1 ? '' : 's'}.`
  )
}

/**
 * What the run came to.
 *
 * The counters are the four numbers that distinguish the failure modes from each
 * other: no feeds read is a transport problem, feeds read but nothing new is a
 * quiet day, articles scored but none sent is a threshold set too high.
 *
 * **The error lines are the reason this is worth more than a heartbeat.** Feed
 * errors and send errors have been collected per run since the pipeline was
 * written and reported nowhere — a feed that has 404'd for a month looks exactly
 * like a feed with nothing to say. `maxItemsPerFeedRun` caps arrive on the same
 * channel by design; they are not errors, but the entries they discard are gone
 * for good, which is worth the same visibility.
 */
export function renderNewsFinish(report: z.infer<typeof runReport>): string {
  const blocks: string[] = [
    `📰 **News run done** — read ${report.feedsFetched} feed${report.feedsFetched === 1 ? '' : 's'}, ` +
      `${report.discovered} new article${report.discovered === 1 ? '' : 's'}, ` +
      `scored ${report.scored}, sent ${report.sent}.`,
  ]

  const problems = [...report.feedErrors, ...report.sendErrors]
  if (problems.length > 0) {
    const shown = problems.slice(0, runNotices.maxErrorsShown)
    const rest = problems.length - shown.length
    // Two blocks, not one: a heading and its list separated by a single newline
    // is a soft wrap, and Telegram renders it as one run-on line. The bullets
    // themselves are single-newline separated, which is what makes them a list.
    blocks.push(
      `**${problems.length} problem${problems.length === 1 ? '' : 's'}:**`,
      [
        ...shown.map(problem => `- ${escapeMarkdown(problem)}`),
        ...(rest > 0 ? [`- …and ${rest} more.`] : []),
      ].join('\n'),
    )
  }

  return blocks.join('\n\n')
}

export const curateAll = createWorkflow({
  id: NEWS.workflowId,
  inputSchema: runInput,
  outputSchema: runReport,
  stateSchema: runState,
  // One schedule for every beat at once, rendered by the kit from `NEWS`: one
  // row whose cron carries every digest hour. This used to be one schedule per
  // category per hour, derived from a config array — which cannot work when a
  // beat is created at runtime, since the schedule set is read off the workflow
  // at boot. Fanning out inside the run means adding a beat needs no schedule
  // to be created, reconciled, or deleted.
  schedule: NEWS.schedule,
})
  .then(ingest)
  .foreach(rankBeat, { concurrency: pipeline.beatConcurrency })
  .then(assignBest)
  .foreach(deliverBeat, { concurrency: pipeline.beatConcurrency })
  .then(report)
  .commit()
