import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { discovery } from '../../config/discovery.js'
import { pipeline } from '../../config/pipeline.js'
import { articleIdsFromFeed, linkToBeats } from '../../db/articles.js'
import {
  addBeatFeed,
  feedsForBeats,
  getBeat,
  setBeatArchived,
  subscribedFeedUrls,
} from '../../db/beats.js'
import { scopeArxivFeed } from '../../services/arxiv.js'
import { checkFeed, sourceLabel } from '../../services/feed-check.js'
import { discoverFeeds, type SiteDiscovery } from '../../services/feed-discovery.js'
import { escapeMarkdown } from '../../services/telegram.js'
import { proposeSites } from '../agents/scout.js'
import { transportFor } from '../../bots/index.js'
import { NEWY_BOT } from '../../bots/newy.js'

const newyTelegram = transportFor(NEWY_BOT)

/**
 * Finding the feeds for a beat the reader just asked for.
 *
 * `/follow <subject>` writes the beat **paused** and starts this. It takes
 * minutes — one search call, then up to eight homepage fetches and several feed
 * checks each — which is why it is a background run and not part of the command.
 * The reader gets an acknowledgement immediately and a report when this lands.
 *
 * **This is the first workflow a conversation may start**, and the amended
 * [invariant 8](../../../AGENTS.md#invariants) is what permits it: it writes
 * `beats` and `beat_feeds` — configuration the *next* run reads — plus link rows
 * with a null `rankedAt`, which say "consider this article" and carry no verdict.
 * It writes no score, marks nothing delivered, and never starts `curateAll`.
 *
 * It is also the first run outside invariant 2's scheduled-classifier rule, and
 * legitimately so: a person typed a command and is waiting for the answer. The
 * distinction invariant 2 draws is who decides to spend — a cron fire nobody
 * watches, or a reader.
 *
 * **No schedule.** Every other workflow here has one; this one only ever runs
 * because someone asked. Studio can drive it with
 * `{ "slug": "formula-1", "subject": "Formula 1 racing" }` against a beat that
 * already exists, which is the only way to exercise it by hand — a workflow
 * cannot be started from a script (see the evented-engine gotcha in AGENTS.md).
 */

const runInput = z.object({
  /** The beat to attach feeds to. Already written, and paused, by `/follow`. */
  slug: z.string(),
  /**
   * What to search for — **English, and a phrase**, not the beat's title and not
   * what the reader typed.
   *
   * The namer produces this (`NamedBeat.searchQuery`) and it is not stored,
   * which is why it is an input rather than something read off the beat. Both
   * halves are measured: a bare title finds fewer sites than a phrase, and
   * searching in the reader's own language is far worse again —
   * `"actualité de la formule 1"` returned 3 sites with 1 usable feed where the
   * English phrasing returned 8 with 7.
   */
  subject: z.string(),
  /**
   * Whether to un-pause the beat once feeds are attached.
   *
   * True from `/follow`, where a paused beat is a staging state the reader never
   * asked for. False when this is re-run to find *more* feeds for a beat the
   * reader has deliberately paused — resuming it then would override them.
   */
  activate: z.boolean().default(true),
})

const found = runInput.extend({
  sites: z.array(z.object({ name: z.string(), homepage: z.string() })),
})

const checked = found.extend({
  results: z.array(
    z.object({
      homepage: z.string(),
      feedUrl: z.string().nullable(),
      source: z.string().nullable(),
      entries: z.number(),
      hasBodies: z.boolean(),
      newestAt: z.number().nullable(),
      via: z.string().nullable(),
      problem: z.string().nullable(),
    }),
  ),
})

const attached = checked.extend({
  /**
   * The feeds this run actually subscribed the beat to — **not** every result
   * that resolved to a feed.
   *
   * The two come apart whenever the beat was already near
   * `discovery.maxFeedsPerBeat`, which is exactly when the weekly review tops it
   * up: five feeds resolve, room for two, and a caller counting `results` reports
   * three sources it never attached. Emitted here rather than re-derived by each
   * caller for the same reason `describeSite` is exported — a second copy of the
   * cap arithmetic drifts from this one silently.
   */
  attachedFeeds: z.array(z.object({ feedUrl: z.string(), source: z.string() })),
  added: z.number(),
  linked: z.number(),
  activated: z.boolean(),
})

/* ─────────────────────────────────── steps ─────────────────────────────────── */

/**
 * Ask the scout for sites.
 *
 * The beat's existing feeds are handed over as hostnames so the scout does not
 * spend its slots re-proposing them. That is a hint; `discoverFeeds` excludes
 * them for real in the next step.
 *
 * **Every subscription it has ever had, not just the live ones** — see
 * `subscribedFeedUrls`. A feed this beat archived is not a site to rediscover.
 */
const search = createStep({
  id: 'search',
  inputSchema: runInput,
  outputSchema: found,
  execute: async ({ inputData, mastra }) => {
    const avoid = (await subscribedFeedUrls(inputData.slug))
      .map(feedUrl => {
        try {
          return new URL(feedUrl).hostname.replace(/^www\./, '')
        } catch {
          return null
        }
      })
      .filter((host): host is string => host !== null)

    return { ...inputData, sites: await proposeSites(mastra, inputData.subject, [...new Set(avoid)]) }
  },
})

/**
 * Turn sites into verified feeds. No model runs in this step.
 *
 * The whole trustworthiness of the feature lives here: whatever the scout
 * returned, only a URL that a real fetch parsed as a feed with entries in it
 * survives to the next step.
 */
const verify = createStep({
  id: 'verify',
  inputSchema: found,
  outputSchema: checked,
  execute: async ({ inputData }) => {
    const discovered = await discoverFeeds(
      inputData.sites.map(site => site.homepage),
      // Archived subscriptions included. This is the guard the prompt hint in
      // `search` is not, and it is the one that has to know about a feed the
      // beat already tried and dropped.
      await subscribedFeedUrls(inputData.slug),
    )
    return { ...inputData, results: discovered.map(describeSite) }
  },
})

/**
 * One site's outcome, flattened for the step's output schema.
 *
 * Exported so `pnpm discovery:check` renders the report from the *same* mapping
 * the workflow does. It had its own copy for one commit, and the copy silently
 * skipped `sourceLabel` — so the dry-run showed a 47-character source name that
 * the real run would never have produced.
 */
export function describeSite(result: SiteDiscovery) {
  return {
    homepage: result.homepage,
    feedUrl: result.feed?.url ?? null,
    // Cleaned here rather than at write time so the report and the stored
    // attribution can never disagree about what a source is called.
    source: result.feed ? sourceLabel(result.feed.title, result.feed.url) : null,
    entries: result.feed?.entries ?? 0,
    hasBodies: result.feed?.hasBodies ?? false,
    newestAt: result.feed?.newestAt ?? null,
    via: result.via,
    problem: result.problem,
  }
}

/**
 * Subscribe the beat, backfill what is already stored, and un-pause it.
 *
 * The backfill is not optional. A feed another beat already polls answers 304 on
 * the next run, so a brand-new beat subscribing to it would be linked to nothing
 * until that feed's content actually changes — minutes on a busy source, days on
 * a quiet one, and the beat looks broken for all of it. The articles are already
 * in `articles`; linking them lets the ranker work on the next run.
 *
 * **`maxItemAgeDays`, not `retentionDays`.** Retention keeps 30 days and ingest
 * only ever accepts 7, so backfilling the full retention window would hand a new
 * beat three-week-old stories to deliver as news. `/addfeed` gets this right and
 * so must this ([AGENTS.md](../../../AGENTS.md#gotchas)).
 *
 * The beat is only un-paused if something was actually attached. A live beat
 * with no feeds contributes nothing to every digest forever, which is
 * indistinguishable from a bug.
 */
const attach = createStep({
  id: 'attach',
  inputSchema: checked,
  outputSchema: attached,
  execute: async ({ inputData }) => {
    // Counted against what the beat already holds, not against this run's
    // results. Slicing the run alone would let a beat climb past the cap one
    // top-up at a time, which is exactly what a re-run is for.
    const alreadyHeld = (await feedsForBeats([inputData.slug])).length
    const room = Math.max(0, discovery.maxFeedsPerBeat - alreadyHeld)
    const working = inputData.results
      .filter(result => result.feedUrl !== null)
      .slice(0, room)

    const cutoff = Date.now() - pipeline.maxItemAgeDays * 24 * 60 * 60 * 1000
    const attachedFeeds: { feedUrl: string; source: string }[] = []
    let linked = 0

    // The beat's own subjects, for narrowing an arXiv category listing the same
    // way `/addfeed` does. Read once: it is the same beat for every result.
    const beat = await getBeat(inputData.slug)

    for (const result of working) {
      let url = result.feedUrl as string
      let source = result.source ?? hostLabel(url)

      // A category listing is every paper announced that day, which on a beat
      // with a narrow subject is a firehose of near-misses. Verified before it
      // is preferred — a query matching nothing is a feed that looks healthy and
      // returns nothing forever, so the plain category survives that case.
      const scoped = beat ? scopeArxivFeed(url, beat) : null
      if (scoped) {
        const scopedCheck = await checkFeed(scoped.url)
        if (scopedCheck.ok) {
          url = scoped.url
          source = sourceLabel(scopedCheck.title, scoped.url)
        }
      }

      await addBeatFeed(inputData.slug, url, source)
      attachedFeeds.push({ feedUrl: url, source })

      const ids = await articleIdsFromFeed(url, cutoff)
      linked += await linkToBeats(
        ids.map(id => ({ articleId: id, beatSlug: inputData.slug, subtopic: null })),
      )
    }

    const activated = inputData.activate && working.length > 0
    if (activated) await setBeatArchived(inputData.slug, false)

    return { ...inputData, attachedFeeds, added: attachedFeeds.length, linked, activated }
  },
})

/** What the reader gets in Chat when it finishes. */
const report = createStep({
  id: 'report',
  inputSchema: attached,
  outputSchema: attached.extend({ reported: z.boolean() }),
  execute: async ({ inputData, mastra }) => {
    try {
      await newyTelegram.sendToTelegram(await renderReport(inputData), 'chat')
      return { ...inputData, reported: true }
    } catch (error) {
      // The feeds are attached either way. A failed send must not fail the run
      // and make this look like nothing happened.
      mastra.getLogger()?.error('Could not report discovery to Telegram', error)
      return { ...inputData, reported: false }
    }
  },
})

/* ────────────────────────────────── message ────────────────────────────────── */

type Report = z.infer<typeof attached>

/**
 * Exported unsent, for the reason `renderSummary` and `welcome` are: it is the
 * only seam where the block structure can be checked offline with
 * `formatConverter.toAst()`. A single newline inside any entry is a soft wrap
 * that collapses two blocks into one run-on line.
 */
export async function renderReport(input: Report): Promise<string> {
  const beat = await getBeat(input.slug)
  const label = beat ? `${beat.emoji} **${escapeMarkdown(beat.title)}**` : `\`${input.slug}\``
  // What was attached, not what resolved. On a top-up the beat is already near
  // the cap, so several results can be perfectly good feeds this run had no room
  // for — naming them here would claim subscriptions that do not exist.
  const kept = new Set(input.attachedFeeds.map(feed => feed.feedUrl))
  const working = input.results.filter(result => result.feedUrl !== null && kept.has(result.feedUrl))
  const spare = input.results.filter(result => result.feedUrl !== null && !kept.has(result.feedUrl))
  const missed = input.results.filter(result => result.feedUrl === null)

  if (working.length === 0) {
    return [
      `${label} — I couldn't find a feed for that.`,
      `I looked at ${input.results.length} site${input.results.length === 1 ? '' : 's'} and none ` +
        `of them publish an RSS or Atom feed I could reach.`,
      `The beat is set up and **paused**. Add a feed yourself with ` +
        `\`/addfeed ${input.slug} <url>\` and I'll start it, or \`/pause\` it out of the way.`,
    ].join('\n\n')
  }

  const lines = working.map(result => {
    const detail = [
      `${result.entries} entries`,
      result.hasBodies ? 'full bodies' : 'headlines only',
      result.newestAt ? `latest ${describeAge(result.newestAt)}` : 'no dates',
    ].join(' · ')
    return `- **${escapeMarkdown(result.source ?? hostLabel(result.feedUrl as string))}**\n  ${detail}`
  })

  return [
    `${label} — following ${working.length} feed${working.length === 1 ? '' : 's'}.`,
    lines.join('\n'),
    missed.length > 0
      ? `${missed.length} site${missed.length === 1 ? '' : 's'} had no feed I could use: ` +
        `${missed.map(result => escapeMarkdown(hostLabel(result.homepage))).join(', ')}.`
      : 'Every site I looked at had a feed.',
    // Only ever non-empty on a top-up, where the beat was already close to the
    // cap. Said outright, because "I found seven and took two" is information —
    // silently dropping five working feeds looks like the search went badly.
    spare.length > 0
      ? `${spare.length} more had a working feed, but this beat is at its limit of ` +
        `${discovery.maxFeedsPerBeat}. \`/removefeed\` makes room.`
      : null,
    input.linked > 0
      ? `${input.linked} article${input.linked === 1 ? '' : 's'} from those feeds were already ` +
        `stored, so this beat has something to say at the next digest.`
      : 'Nothing stored from them yet — the next scheduled run picks them up.',
    // The beat's own state, not this run's `activate` flag. A top-up passes
    // `activate: false` because it must not un-pause anything — which says
    // nothing about whether the beat is running, and it always is on that path.
    // Reading the flag told a live beat's owner it was paused.
    (beat ? beat.archivedAt === null : input.activated)
      ? `It's running now. \`/beat ${input.slug}\` shows what it looks for, and \`/why\` on any ` +
        `article tells you how it scored.`
      : `It's **paused** — \`/resume ${input.slug}\` when you want it.`,
  ]
    .filter((block): block is string => block !== null)
    .join('\n\n')
}

/** "3 days ago". Rough on purpose, same as `/addfeed`'s. */
function describeAge(at: number): string {
  const days = Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? 'a month ago' : `${months} months ago`
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export const discoverFeedsWorkflow = createWorkflow({
  id: 'discover-feeds',
  inputSchema: runInput,
  outputSchema: attached.extend({ reported: z.boolean() }),
})
  .then(search)
  .then(verify)
  .then(attach)
  .then(report)
  .commit()
