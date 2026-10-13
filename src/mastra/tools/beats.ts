import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { buildRubric, discovery } from '../../config/discovery.js'
import { retune } from '../../config/retune.js'
import { feedPerformance, topVerdictsForBeat } from '../../db/articles.js'
import {
  beatRevisionHistory,
  feedsForBeats,
  getBeat,
  retuneBeat,
} from '../../db/beats.js'
import { getFeedState } from '../../db/feeds.js'
import { slugFromTitle } from '../agents/scout.js'

/**
 * The two tools that let Newy explain a beat and, when asked, change it.
 *
 * **This is the first write Newy has ever had over the pipeline's own
 * configuration**, and it sits inside [invariant 8](../../../AGENTS.md#invariants)
 * rather than beside it: `beats` is on that invariant's may-write list, because
 * a rubric is input to some *future* run and never something a run produced.
 * Nothing here touches `articles`, `article_beats`, a score or a `deliveredAt`,
 * and nothing here starts a run.
 *
 * They are a pair, and the reading half is the important one. The feature exists
 * because the reader asked why a beat was sending nothing and could only be told
 * "I can't change a beat" — while the true answer was that its three feeds had
 * never once been fetched, which no rubric would have fixed. A tool that only
 * wrote would have let Newy confidently rewrite a rubric that was never the
 * problem. So `inspect-beat` returns the things that distinguish the causes from
 * each other, and `retune-beat` is deliberately the narrower of the two.
 *
 * **A retune supplies the rubric's slots, never its prose.** `discovery.ts` fixes
 * the shape of every rubric in the system on the grounds that a model writing one
 * freehand "can produce something that reads well and scores badly, and there is
 * no way to tell the difference without a measurement the reader will never run".
 * That argument does not weaken because the author is Newy rather than the namer,
 * so this calls the same `buildRubric()` the namer does and the reader keeps the
 * shape the ranker was tuned against.
 *
 * Neither tool throws. A bad slug, an empty change or a rejected bullet comes
 * back as a `problem` string, the way `checkFeed()` reports a bad URL — a model
 * can act on a sentence and cannot act on an exception.
 */

/* ─────────────────────────────── inspect-beat ─────────────────────────────── */

const since = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000

const feedShape = z.object({
  source: z.string(),
  url: z.string(),
  /**
   * No `feed_state` row at all — the pipeline has never fetched this URL.
   *
   * The single most valuable field in this tool, and the one that names the
   * failure nothing else could. It is what a brand-new beat looks like before
   * its first run, and it is also what a beat looks like when it is genuinely
   * stuck; either way the answer is "wait for or fix the run", never "rewrite
   * the rubric".
   */
  neverFetched: z.boolean(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  lastFetchedAt: z.string().nullable(),
  /** Articles it brought to this beat in the window. Zero is not the same as never fetched. */
  collected: z.number(),
  ranked: z.number(),
  delivered: z.number(),
  meanScore: z.number().nullable(),
  bestScore: z.number().nullable(),
})

export const inspectBeat = createTool({
  id: 'inspect-beat',
  description:
    'Everything about how one beat is configured and how it is actually performing: its rubric, ' +
    'its subtopics, its thresholds, every feed with what that feed has delivered and whether it ' +
    'has ever been fetched at all, the best-scoring articles with the ranker\'s reasons, and any ' +
    'past rubrics. Use it whenever the reader asks why a beat is quiet, why something was or was ' +
    'not sent, or what a beat is looking for — and always before "retune-beat", so a change is ' +
    'made against what the beat actually says rather than a guess.',
  inputSchema: z.object({
    beat: z.string().describe('The beat slug, as listed in your instructions.'),
  }),
  outputSchema: z.object({
    beat: z
      .object({
        slug: z.string(),
        title: z.string(),
        emoji: z.string(),
        /** Paused beats do not ingest, rank or deliver. A common reason for silence. */
        paused: z.boolean(),
        digestThreshold: z.number(),
        maxItemsPerDigest: z.number(),
        subtopics: z.array(z.string()),
        rubric: z.string(),
        windowDays: z.number(),
        linked: z.number(),
        ranked: z.number(),
        delivered: z.number(),
        feeds: z.array(feedShape),
        /** Best-scored articles in the window, highest first. Empty means nothing was ranked. */
        topScores: z.array(
          z.object({
            title: z.string(),
            source: z.string(),
            score: z.number(),
            reason: z.string().nullable(),
            subtopic: z.string().nullable(),
            delivered: z.boolean(),
          }),
        ),
        /** Past rubrics, newest first. Empty when this beat has never been retuned. */
        history: z.array(
          z.object({
            replacedAt: z.string(),
            reason: z.string().nullable(),
            subtopics: z.array(z.string()),
            rubric: z.string(),
          }),
        ),
      })
      .nullable()
      .describe('Null when no beat has that slug.'),
  }),
  execute: async ({ beat: slug }) => {
    const beat = await getBeat(slug)
    if (!beat) return { beat: null }

    const cutoff = since(retune.statsDays)
    const [feeds, performance, topScores, history] = await Promise.all([
      feedsForBeats([slug]),
      feedPerformance(beat, cutoff),
      topVerdictsForBeat(slug, cutoff, retune.verdictsShown),
      beatRevisionHistory(slug, retune.historyShown),
    ])

    const byUrl = new Map(performance.map(row => [row.feedUrl, row]))
    // One `feed_state` read per feed. There are at most `maxFeedsPerBeat` of
    // them and each is a primary-key lookup, so the loop is cheaper than the
    // join it replaces — and a feed with no row at all is the answer we are
    // looking for, which an inner join would have hidden.
    const shaped = await Promise.all(
      feeds.slice(0, retune.feedsShown).map(async feed => {
        const state = await getFeedState(feed.feedUrl)
        const stats = byUrl.get(feed.feedUrl)
        return {
          source: feed.source,
          url: feed.feedUrl,
          neverFetched: state === null,
          lastStatus: state?.lastStatus ?? null,
          lastError: state?.lastError ?? null,
          lastFetchedAt: state?.lastFetchedAt
            ? new Date(state.lastFetchedAt).toISOString()
            : null,
          collected: stats?.collected ?? 0,
          ranked: stats?.ranked ?? 0,
          delivered: stats?.delivered ?? 0,
          meanScore: stats?.meanScore ?? null,
          bestScore: stats?.bestScore ?? null,
        }
      }),
    )

    return {
      beat: {
        slug: beat.slug,
        title: beat.title,
        emoji: beat.emoji,
        paused: beat.archivedAt !== null,
        digestThreshold: beat.digestThreshold,
        maxItemsPerDigest: beat.maxItemsPerDigest,
        subtopics: beat.subtopics,
        rubric: beat.rubric,
        windowDays: retune.statsDays,
        linked: shaped.reduce((total, feed) => total + feed.collected, 0),
        ranked: shaped.reduce((total, feed) => total + feed.ranked, 0),
        delivered: shaped.reduce((total, feed) => total + feed.delivered, 0),
        feeds: shaped,
        topScores,
        history: history.map(revision => ({
          replacedAt: new Date(revision.replacedAt).toISOString(),
          reason: revision.reason,
          subtopics: revision.subtopics,
          rubric: revision.rubric,
        })),
      },
    }
  },
})

/* ─────────────────────────────── retune-beat ──────────────────────────────── */

/**
 * Trims a bullet list and says what is wrong with it, if anything.
 *
 * Empty strings are dropped rather than rejected — a model padding a list to a
 * round number is not an error worth a round trip — but the count is checked
 * *after* dropping them, so padding cannot buy its way past the floor.
 */
function cleanBullets(raw: readonly string[], field: string): string[] | string {
  const bullets = raw.map(line => line.trim()).filter(Boolean)
  if (bullets.length < retune.bulletCount.min) {
    return `${field} needs at least ${retune.bulletCount.min} bullets; it had ${bullets.length}.`
  }
  if (bullets.length > retune.bulletCount.max) {
    return `${field} may have at most ${retune.bulletCount.max} bullets; it had ${bullets.length}.`
  }
  const long = bullets.find(line => line.length > retune.bulletMaxChars)
  if (long) {
    return `A ${field} bullet is ${long.length} characters; the limit is ${retune.bulletMaxChars}. Shorten it.`
  }
  return bullets
}

export const retuneBeatTool = createTool({
  id: 'retune-beat',
  description:
    'Rewrite what one beat looks for — its rubric and/or its subtopics. Call this ONLY when the ' +
    'reader has asked you in this conversation to change what a beat covers; never because you ' +
    'inferred it from something they said about a topic. Call "inspect-beat" first and supply the ' +
    'complete new rubric, not a diff: the bullets you leave out are removed. It changes what the ' +
    'NEXT scheduled run does — articles already scored keep their scores, and nothing is re-sent. ' +
    'The rubric it replaces is kept, so a change can always be described or undone.',
  inputSchema: z.object({
    beat: z.string().describe('The beat slug to change.'),
    rubric: z
      .object({
        readerLine: z
          .string()
          .describe(
            'One sentence naming who this beat is curated for and what they care about, ' +
            'starting "You are curating for". The first line the ranking model reads.',
          ),
        scoreHigh: z
          .array(z.string())
          .describe(
            'Bullets describing articles worth sending. Concrete and checkable — a thing that ' +
            'happened, a result, a release. The complete list, including the ones being kept.',
          ),
        scoreLow: z
          .array(z.string())
          .describe(
            'Bullets describing articles to reject, aimed at the specific noise this subject ' +
            'produces. The complete list, including the ones being kept.',
          ),
      })
      .optional()
      .describe(
        'Omit to leave the rubric exactly as it is. When present, all three parts are required — ' +
        'the rubric is rebuilt from them, so a missing part would erase that section.',
      ),
    subtopics: z
      .array(z.string())
      .optional()
      .describe(
        'The complete new label set, lowercase and hyphenated. These are the only labels the ' +
        'ranker may assign, so they must together cover everything the beat publishes. Omit to ' +
        'leave them alone.',
      ),
    reason: z
      .string()
      .optional()
      .describe(
        "What the reader asked for, in their own words. Stored with the rubric being replaced, " +
        'so the history says why it changed.',
      ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    /** Why nothing was written. Null on success. */
    problem: z.string().nullable(),
    /** Which fields actually differed. Empty means the beat already said this. */
    changed: z.array(z.string()),
    before: z
      .object({ rubric: z.string(), subtopics: z.array(z.string()) })
      .nullable(),
    after: z
      .object({ rubric: z.string(), subtopics: z.array(z.string()) })
      .nullable(),
  }),
  execute: async ({ beat: slug, rubric, subtopics, reason }) => {
    const fail = (problem: string) => ({
      ok: false,
      problem,
      changed: [],
      before: null,
      after: null,
    })

    if (!rubric && !subtopics) {
      return fail('Nothing to change — supply a rubric, subtopics, or both.')
    }
    if (reason && reason.length > retune.reasonMaxChars) {
      return fail(`The reason is longer than ${retune.reasonMaxChars} characters.`)
    }

    let builtRubric: string | undefined
    if (rubric) {
      const readerLine = rubric.readerLine.trim()
      if (!readerLine) return fail('The rubric needs a "You are curating for…" line.')
      if (readerLine.length > retune.readerLineMaxChars) {
        return fail(
          `The "curating for" line is ${readerLine.length} characters; the limit is ` +
          `${retune.readerLineMaxChars}. It is one sentence.`,
        )
      }
      const high = cleanBullets(rubric.scoreHigh, 'scoreHigh')
      if (typeof high === 'string') return fail(high)
      const low = cleanBullets(rubric.scoreLow, 'scoreLow')
      if (typeof low === 'string') return fail(low)
      // The same template the namer's output goes through, so a retuned rubric
      // is indistinguishable in shape from one `/follow` produced.
      builtRubric = buildRubric({ readerLine, scoreHigh: high, scoreLow: low })
    }

    let cleanSubtopics: string[] | undefined
    if (subtopics) {
      // Normalized through the namer's own slugger rather than a second copy of
      // the rule — a private reimplementation here would drift from what
      // `/follow` writes, and the two label sets have to be the same shape.
      cleanSubtopics = [...new Set(subtopics.map(topic => slugFromTitle(topic)).filter(Boolean))]
      if (cleanSubtopics.length === 0) {
        return fail('None of those subtopics reduce to usable labels.')
      }
      if (cleanSubtopics.length > discovery.subtopicCount.max) {
        return fail(
          `A beat may have at most ${discovery.subtopicCount.max} subtopics; that was ` +
          `${cleanSubtopics.length}. The ranker picks exactly one per article, so too many ` +
          'makes the label meaningless.',
        )
      }
    }

    const result = await retuneBeat(slug, {
      ...(builtRubric ? { rubric: builtRubric } : {}),
      ...(cleanSubtopics ? { subtopics: cleanSubtopics } : {}),
      reason: reason?.trim() || null,
    })
    if (!result) return fail(`There is no beat called "${slug}".`)

    return {
      ok: true,
      problem: null,
      changed: result.changed,
      before: result.before,
      after: result.after,
    }
  },
})

export const beatTools = { inspectBeat, retuneBeat: retuneBeatTool }
