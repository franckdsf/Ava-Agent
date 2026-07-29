import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { SEED_BEATS } from '../config/seed-beats.js'
import { pipeline } from '../config/pipeline.js'
import { batchAll, db, migrate } from './client.js'
import { beatFeeds, beats } from './schema.js'
import type { BeatFeedRow } from './schema.js'

/**
 * Beats — the subjects the reader follows.
 *
 * Every read here returns a `Beat` with its thresholds already resolved against
 * `pipeline`'s defaults, so no caller ever sees a null and no caller repeats the
 * fallback. The nullable columns are a storage detail; "this beat has no opinion
 * about its threshold" is not something the ranker or the arbiter should have to
 * think about.
 */

/** A beat with its nullable columns resolved. This is what the pipeline works with. */
export interface Beat {
  slug: string
  title: string
  emoji: string
  rubric: string
  subtopics: string[]
  /** At or above this, an article may win this beat. Never null — see the note above. */
  digestThreshold: number
  maxItemsPerDigest: number
  archivedAt: number | null
}

/** One feed a beat pulls from. */
export interface BeatFeed {
  beatSlug: string
  feedUrl: string
  source: string
  subtopic: string | null
}

type BeatRow = typeof beats.$inferSelect

function toBeat(row: BeatRow): Beat {
  return {
    slug: row.slug,
    title: row.title,
    emoji: row.emoji,
    rubric: row.rubric,
    // A JSON column round-trips as `unknown` if the row predates the $type, and
    // a malformed one must not take down a whole run over one bad beat.
    subtopics: Array.isArray(row.subtopics) ? row.subtopics : [],
    digestThreshold: row.digestThreshold ?? pipeline.defaultDigestThreshold,
    maxItemsPerDigest: row.maxItemsPerDigest ?? pipeline.defaultMaxItemsPerDigest,
    archivedAt: row.archivedAt,
  }
}

/**
 * Live beats, oldest first, optionally narrowed to a named set.
 *
 * The filter is what lets one beat be curated from Studio without touching the
 * others — the only way to exercise this pipeline by hand, since a workflow
 * cannot be driven from a script (see the evented-engine gotcha in AGENTS.md).
 * An unknown slug in the filter is silently absent rather than an error: the
 * caller asked for a set, and a beat archived between one step and the next is
 * an ordinary race, not a failure.
 */
export async function activeBeats(filter?: readonly string[]): Promise<Beat[]> {
  await migrate()
  const rows = await db()
    .select()
    .from(beats)
    .where(
      and(
        isNull(beats.archivedAt),
        ...(filter && filter.length > 0 ? [inArray(beats.slug, [...filter])] : []),
      ),
    )
    .orderBy(asc(beats.createdAt))
  return rows.map(toBeat)
}

/** Every beat including archived ones, for the conversational surface to list. */
export async function allBeats(): Promise<Beat[]> {
  await migrate()
  const rows = await db().select().from(beats).orderBy(asc(beats.createdAt))
  return rows.map(toBeat)
}

export async function getBeat(slug: string): Promise<Beat | null> {
  await migrate()
  const rows = await db().select().from(beats).where(eq(beats.slug, slug)).limit(1)
  return rows[0] ? toBeat(rows[0]) : null
}

/**
 * Live feeds for the given beats.
 *
 * Returns one row per (beat, feed), so a URL two beats both subscribe to appears
 * twice — that is the shape ingest wants, since it groups by URL to fetch once
 * and then fans the entries back out to every subscriber.
 */
export async function feedsForBeats(slugs: readonly string[]): Promise<BeatFeed[]> {
  if (slugs.length === 0) return []
  await migrate()
  const rows: BeatFeedRow[] = await db()
    .select()
    .from(beatFeeds)
    .where(and(inArray(beatFeeds.beatSlug, [...slugs]), isNull(beatFeeds.archivedAt)))
  return rows.map(row => ({
    beatSlug: row.beatSlug,
    feedUrl: row.feedUrl,
    source: row.source,
    subtopic: row.subtopic,
  }))
}

/**
 * Creates a beat, **paused**, and reports whether the slug was free.
 *
 * Paused is the whole point. `/follow` writes the row before discovery has found
 * anything, so between the command and the report there is a beat with no feeds
 * — and a beat with no feeds that is *live* would join the next digest and
 * contribute nothing, which reads exactly like a broken beat. `archivedAt`
 * already means "exists, does not run", so no draft table is needed: the row is
 * the draft, `/beat <slug>` inspects it, and discovery clears `archivedAt` once
 * it has attached something worth running.
 *
 * Returns false rather than throwing on a slug collision, and writes nothing in
 * that case — the caller turns it into a sentence. `onConflictDoNothing` rather
 * than an upsert is deliberate: re-running `/follow` on a subject the reader
 * already has must never overwrite a rubric they have since edited.
 */
export async function createBeat(input: {
  slug: string
  title: string
  emoji: string
  rubric: string
  subtopics: readonly string[]
}): Promise<boolean> {
  await migrate()
  const created = await db()
    .insert(beats)
    .values({
      slug: input.slug,
      title: input.title,
      emoji: input.emoji,
      rubric: input.rubric,
      subtopics: [...input.subtopics],
      digestThreshold: null,
      maxItemsPerDigest: null,
      createdAt: Date.now(),
      archivedAt: Date.now(),
    })
    .onConflictDoNothing()
    .returning({ slug: beats.slug })
  return created.length > 0
}

/**
 * Switches a beat off, or back on. Returns false when there is no such beat.
 *
 * Soft, always. Archiving stops ingest, ranking and delivery and leaves
 * everything else standing — the articles it collected, the scores it gave them,
 * the votes cast on them, and (once there is one) its Telegram tab, closed
 * rather than deleted. So "pause" and "delete" are the same operation, and the
 * reader never has to decide which one they meant at the moment they are
 * annoyed at a beat.
 *
 * Idempotent in both directions: archiving an archived beat rewrites the same
 * column, which keeps the command replies honest without a read first.
 */
export async function setBeatArchived(slug: string, archived: boolean): Promise<boolean> {
  await migrate()
  const updated = await db()
    .update(beats)
    .set({ archivedAt: archived ? Date.now() : null })
    .where(eq(beats.slug, slug))
    .returning({ slug: beats.slug })
  return updated.length > 0
}

/**
 * Subscribes a beat to a feed, or un-archives the subscription if it had one.
 *
 * The conflict path is why this is an upsert rather than an insert. Removing a
 * feed archives the row instead of deleting it, so re-adding one the reader
 * removed last month must clear `archivedAt` — otherwise the command reports
 * success and the feed stays silent, which is the worst of both.
 *
 * `source` is the label shown under an article. It is *not* refreshed on
 * conflict: a reader who renamed a source meant it, and a re-add should not
 * quietly revert it to the feed's own title.
 */
export async function addBeatFeed(
  beatSlug: string,
  feedUrl: string,
  source: string,
  subtopic: string | null = null,
): Promise<void> {
  await migrate()
  await db()
    .insert(beatFeeds)
    .values({
      beatSlug,
      feedUrl,
      source,
      subtopic,
      addedAt: Date.now(),
      archivedAt: null,
      archivedReason: null,
      trials: 0,
    })
    .onConflictDoUpdate({
      target: [beatFeeds.beatSlug, beatFeeds.feedUrl],
      // `trials` is deliberately NOT reset here. A reader re-adding a feed the
      // review archived twice is making a deliberate choice, and it should stick
      // — but if it then underperforms again, resetting the counter would start
      // the whole archive-restore cycle over. The reason is cleared because the
      // feed is live again; the history of why it wasn't is not interesting.
      set: { archivedAt: null, archivedReason: null },
    })
}

/** One archived subscription the review may reconsider. */
export interface RetriableFeed {
  beatSlug: string
  feedUrl: string
  source: string
  trials: number
}

/**
 * Archives a feed the review judged, recording why and counting the attempt.
 *
 * Separate from `removeBeatFeed` because the two mean different things to the
 * *next* review: this one is reversible after `retryAfterDays`, and the reader's
 * removal never is.
 */
export async function archiveFeedForReview(
  beatSlug: string,
  feedUrl: string,
  reason: 'underperforming' | 'unreachable',
  trials: number,
): Promise<void> {
  await migrate()
  await db()
    .update(beatFeeds)
    .set({ archivedAt: Date.now(), archivedReason: reason, trials })
    .where(and(eq(beatFeeds.beatSlug, beatSlug), eq(beatFeeds.feedUrl, feedUrl)))
}

/**
 * Feeds the review archived long enough ago to deserve another month.
 *
 * Three conditions, and each excludes a different mistake: archived **by the
 * review** (never a feed the reader removed), archived **before the cutoff**
 * (rested long enough that the second sample is genuinely new), and **under the
 * trial cap** (a feed that has failed twice is a poor fit, not unlucky).
 *
 * A null `trials` is read as 0 — rows written before the column existed have
 * never been auto-archived, which is exactly what 0 means.
 */
export async function feedsDueForRetrial(
  before: number,
  maxTrials: number,
): Promise<RetriableFeed[]> {
  await migrate()
  const rows = await db()
    .select()
    .from(beatFeeds)
    .where(
      and(
        isNotNull(beatFeeds.archivedAt),
        eq(beatFeeds.archivedReason, 'underperforming'),
        lt(beatFeeds.archivedAt, before),
        lt(sql`coalesce(${beatFeeds.trials}, 0)`, maxTrials),
      ),
    )
  return rows.map(row => ({
    beatSlug: row.beatSlug,
    feedUrl: row.feedUrl,
    source: row.source,
    trials: row.trials ?? 0,
  }))
}

/**
 * Brings an archived feed back for another trial, keeping its trial count.
 *
 * Keeping `trials` is the whole point — clearing it here would make the backoff
 * a no-op and let a feed cycle forever.
 */
export async function restoreFeed(beatSlug: string, feedUrl: string): Promise<void> {
  await migrate()
  await db()
    .update(beatFeeds)
    .set({ archivedAt: null, archivedReason: null })
    .where(and(eq(beatFeeds.beatSlug, beatSlug), eq(beatFeeds.feedUrl, feedUrl)))
}

/** Live feed rows with their trial counts, for the review to judge. */
export async function liveFeedsWithTrials(beatSlug: string): Promise<RetriableFeed[]> {
  await migrate()
  const rows = await db()
    .select()
    .from(beatFeeds)
    .where(and(eq(beatFeeds.beatSlug, beatSlug), isNull(beatFeeds.archivedAt)))
  return rows.map(row => ({
    beatSlug: row.beatSlug,
    feedUrl: row.feedUrl,
    source: row.source,
    trials: row.trials ?? 0,
  }))
}

/**
 * Unsubscribes a beat from a feed. Returns false when it wasn't subscribed.
 *
 * Archived rather than deleted, so the row still records that this beat once
 * read this source — and so re-adding it is an update rather than a fresh row
 * with a new `addedAt`. The articles it already brought in keep their links and
 * their scores; nothing the reader has seen changes.
 */
export async function removeBeatFeed(beatSlug: string, feedUrl: string): Promise<boolean> {
  await migrate()
  const updated = await db()
    .update(beatFeeds)
    // `reader` is what stops the weekly review ever bringing this back. A feed
    // the reader removed on purpose must stay removed; only the ones the review
    // archived itself are eligible for a retrial.
    .set({ archivedAt: Date.now(), archivedReason: 'reader' })
    .where(
      and(
        eq(beatFeeds.beatSlug, beatSlug),
        eq(beatFeeds.feedUrl, feedUrl),
        isNull(beatFeeds.archivedAt),
      ),
    )
    .returning({ feedUrl: beatFeeds.feedUrl })
  return updated.length > 0
}

/**
 * Writes `SEED_BEATS` if — and only if — the table is empty.
 *
 * Guarded on the whole table rather than per slug on purpose. Per-slug upserts
 * would make this a config-sync, quietly resurrecting a beat the reader
 * archived and overwriting a rubric they edited in conversation. The seed exists
 * so a fresh database has something to read, and after the first boot the table
 * is the authority ([ADR-0019](../../docs/decisions/0019-beats-as-reader-owned-data.md)).
 *
 * Returns how many beats it created, so a caller can log a first boot without
 * having to ask a second question.
 */
export async function seedBeats(): Promise<number> {
  await migrate()
  const [existing] = await db().select({ n: sql<number>`count(*)` }).from(beats)
  if ((existing?.n ?? 0) > 0) return 0

  const now = Date.now()
  await batchAll([
    ...SEED_BEATS.map(beat =>
      db()
        .insert(beats)
        .values({
          slug: beat.slug,
          title: beat.title,
          emoji: beat.emoji,
          rubric: beat.rubric,
          subtopics: [...beat.subtopics],
          digestThreshold: beat.digestThreshold ?? null,
          maxItemsPerDigest: beat.maxItemsPerDigest ?? null,
          createdAt: now,
          archivedAt: null,
        })
        .onConflictDoNothing(),
    ),
    ...SEED_BEATS.flatMap(beat =>
      beat.feeds.map(feed =>
        db()
          .insert(beatFeeds)
          .values({
            beatSlug: beat.slug,
            feedUrl: feed.url,
            source: feed.source,
            subtopic: feed.subtopic ?? null,
            addedAt: now,
            archivedAt: null,
          })
          .onConflictDoNothing(),
      ),
    ),
  ])
  return SEED_BEATS.length
}
