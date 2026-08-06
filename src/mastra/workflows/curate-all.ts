import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { memoryConfig } from '../../config/memory.js'
import { pipeline } from '../../config/pipeline.js'
import { runNotices } from '../../config/run-notices.js'
import {
  insertDiscovered,
  isSharedFeedImage,
  linkToBeats,
  listRankedUndelivered,
  listUnranked,
  markDelivered,
  saveClusters,
  saveImageUrl,
  saveRankings,
} from '../../db/articles.js'
import { activeBeats, feedsForBeats, getBeat, type Beat } from '../../db/beats.js'
import { recentFeedback, type FeedbackSignal } from '../../db/feedback.js'
import { memoriesForCuration, type Memory } from '../../db/memories.js'
import type { Article, ArticleRanking, BeatLink, DiscoveredArticle, PendingArticle } from '../../db/types.js'
import { articleBody, fetchOgImage, looksLikeSiteChrome } from '../../services/article.js'
import { clusterItems, dedupeByCluster } from '../../services/cluster.js'
import { dedupeFeeds, fetchFeeds } from '../../services/rss.js'
import { escapeMarkdown } from '../../services/telegram.js'
import { newyTelegram } from '../../services/newy-telegram.js'
import { articleWriterId, rankerId } from '../agents/curator.js'

/**
 * One workflow for every beat, on one schedule per digest hour.
 *
 * ingest → rank (per beat) → **arbitrate** → deliver (per beat). Each stage is
 * deterministic except the two LLM calls, which is deliberate: a scheduled job
 * that lets a model choose its own control flow is how you get surprise bills and
 * duplicate messages ([invariant 2](../../../AGENTS.md#invariants)).
 *
 * Two things about this shape are not obvious and are load-bearing.
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
})

/**
 * Run-level counters, carried in workflow state rather than through every
 * schema. The fan-outs replace the data flowing between steps with an array per
 * beat, so ingest's numbers would otherwise be lost by the time anything reports
 * them. Only `ingest` writes here — a `setState` from inside a concurrent
 * `foreach` would race itself.
 */
const runState = z.object({
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
    const beats = await activeBeats(inputData.beats)
    if (beats.length === 0) {
      await setState({ feedsFetched: 0, discovered: 0, linked: 0, feedErrors: [] })
      return []
    }

    const subscriptions = await feedsForBeats(beats.map(beat => beat.slug))
    const distinct = dedupeFeeds(
      subscriptions.map(subscription => ({
        url: subscription.feedUrl,
        source: subscription.source,
      })),
    )

    // Announced here rather than at the top of the step, so the notice can name
    // what the run is about to do instead of promising a run that turns out to
    // have no beats and no feeds. The fetch below is the long part — feeds are
    // parallel but `feedTimeoutMs` bounds a run at 20s — and everything after it
    // is model calls, so this is the last cheap moment before the reader would
    // otherwise be looking at nothing.
    //
    // `distinct.length > 0` is the same bar the closing notice applies, and the
    // two have to agree: a run with beats but no live feeds between them fetches
    // nothing and reports nothing, and announcing only the start of it would
    // leave a run that looks like it never came back.
    mastra.getLogger()?.info('News run started', { beats: beats.length, feeds: distinct.length })
    if (runNotices.news.start && distinct.length > 0) {
      await newyTelegram
        .sendToTelegram(renderNewsStart(beats.length, distinct.length), 'chat')
        .catch(() => {})
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

function renderInterestProfile(signals: FeedbackSignal[]): string {
  if (signals.length === 0) return 'No feedback recorded yet. Judge on the rubric alone.'
  const line = (signal: FeedbackSignal) => `- ${signal.title} (${signal.source})`
  const liked = signals.filter(s => s.vote === 'up').map(line)
  const disliked = signals.filter(s => s.vote === 'down').map(line)
  return [
    liked.length ? `Recently marked USEFUL:\n${liked.join('\n')}` : '',
    disliked.length ? `Recently marked NOT USEFUL:\n${disliked.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * What Newy has written down about the reader, rendered for the ranker.
 *
 * The 👍/👎 profile above says what they thought of articles; this says who they
 * are — and the two answer different halves of "would they want this?". A vote
 * can only teach the ranker about a pattern it has already sent, so a beat with
 * no votes yet has nothing but the rubric. The notes are the signal that exists
 * from the first run
 * ([ADR-0016](../../../docs/decisions/0016-reader-notes-in-the-ranker.md)).
 *
 * **Not scoped to the beat, and that is deliberate.** "No Android articles" is a
 * statement about the reader, not about one tab, so it reaches every ranker —
 * including a beat created after the note was written. A note that stops being
 * true is superseded by a later one rather than edited, which is the mechanism
 * `memories` already has.
 *
 * **Never throws.** A failed read here would take down a whole curation run over
 * the part of it that is an enhancement; ranking without the notes is exactly how
 * the pipeline behaved before they existed.
 *
 * Dates and oldest-first ordering are carried through rather than stripped: "left
 * Acme (2025-11)" then "joined Globex (2026-03)" only reads as a job change in
 * that order, and a ranker that reads it as two current employers weights the
 * wrong company.
 */
async function renderReaderProfile(): Promise<string> {
  let notes: { long: Memory[]; short: Memory[] }
  try {
    notes = await memoriesForCuration()
  } catch {
    return 'Unavailable this run. Judge on the rubric and the votes alone.'
  }

  const line = (note: Memory) => `- ${note.happenedOn} — ${note.fact}`
  if (notes.long.length === 0 && notes.short.length === 0) {
    return 'Nothing recorded yet. Judge on the rubric and the votes alone.'
  }

  return [
    notes.long.length ? `Lasting:\n${notes.long.map(line).join('\n')}` : '',
    notes.short.length
      ? `Recent (last ${memoryConfig.shortTermDays} days):\n${notes.short.map(line).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function renderArticlesForRanking(articles: PendingArticle[]): string {
  return articles
    .map(article =>
      [
        `id: ${article.id}`,
        `source: ${article.source}`,
        `title: ${article.title}`,
        article.excerpt ? `excerpt: ${article.excerpt}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n---\n\n')
}

const rankingSchema = z.object({
  rankings: z.array(
    z.object({
      id: z.string(),
      score: z.number().min(0).max(100),
      subtopic: z.string(),
      reason: z.string(),
    }),
  ),
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

    const agent = mastra.getAgent(rankerId)
    // Both reads are independent of each other and of the batch; one round trip
    // rather than two before a call that is already the slow part of the run.
    const [profile, reader] = await Promise.all([
      recentFeedback(beat.slug, pipeline.feedbackWindow).then(renderInterestProfile),
      renderReaderProfile(),
    ])

    const response = await agent.generate(
      [
        `## Beat: ${beat.title}`,
        '',
        '## Rubric',
        beat.rubric,
        '',
        `## Subtopic labels (choose exactly one per article)`,
        beat.subtopics.join(', '),
        '',
        '## Reader interest profile',
        profile,
        '',
        '## What is known about the reader',
        reader,
        '',
        `## Articles to score (${representatives.length})`,
        renderArticlesForRanking(representatives),
      ].join('\n'),
      { structuredOutput: { schema: rankingSchema } },
    )

    const returned = response.object?.rankings ?? []
    // Guard against a model echoing an id that wasn't in the batch.
    const verdicts: ArticleRanking[] = returned.filter(ranking => representativeIds.has(ranking.id))

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

const summarySchema = z.object({
  lede: z.string(),
  points: z.array(z.string()),
})

function renderArticleForWriter(beat: Beat, article: Article, reason: string | null, body: string): string {
  return [
    `beat: ${beat.title}`,
    `title: ${article.title}`,
    `source: ${article.source}`,
    reason ? `why it ranked: ${reason}` : null,
    '',
    body ? `article:\n${body}` : 'article: (no body available — only the title above)',
  ]
    .filter(value => value !== null)
    .join('\n')
}

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
  summary: z.infer<typeof summarySchema>,
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

    const agent = mastra.getAgent(articleWriterId)
    const messages = await Promise.all(
      winners.map(async winner => {
        const body = await articleBody(winner.article)
        const response = await agent.generate(
          renderArticleForWriter(beat, winner.article, winner.reason, body.text ?? winner.article.excerpt ?? ''),
          { structuredOutput: { schema: summarySchema } },
        )
        const summary = response.object ?? { lede: response.text.trim(), points: [] }
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
      try {
        // Into this beat's own tab. `beat` is the whole row, which is what the
        // transport needs to create the tab the first time this beat wins
        // anything ([ADR-0021](../../../docs/decisions/0021-a-tab-per-beat.md)).
        await newyTelegram.sendArticle(message.text, message.imageUrl, beat)
        await markDelivered([message.articleId], beat.slug, 'digest')
        sent += 1
      } catch (err) {
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

    // A run that fetched nothing is a run `ingest` returned early from — no
    // active beats, so no start notice either. A closing line on its own would
    // be the only word about a run that never happened, which reads as a
    // failure rather than as an empty schedule.
    if (runNotices.news.finish && summary.feedsFetched > 0) {
      await newyTelegram.sendToTelegram(renderNewsFinish(summary), 'chat').catch(() => {})
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
  id: 'curate-all',
  inputSchema: runInput,
  outputSchema: runReport,
  stateSchema: runState,
  // One schedule per digest hour, for every beat at once. This used to be one
  // schedule per category per hour, derived from a config array — which cannot
  // work when a beat is created at runtime, since the schedule set is read off
  // the workflow at boot. Fanning out inside the run means adding a beat needs
  // no schedule to be created, reconciled, or deleted.
  schedule: pipeline.digestHours.map(hour => ({
    id: `digest-${String(hour).padStart(2, '0')}00`,
    cron: `0 ${hour} * * *`,
    timezone: env.AGENT_TIMEZONE,
    inputData: {},
  })),
})
  .then(ingest)
  .foreach(rankBeat, { concurrency: pipeline.beatConcurrency })
  .then(assignBest)
  .foreach(deliverBeat, { concurrency: pipeline.beatConcurrency })
  .then(report)
  .commit()
