import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'
import { batchAll, db, migrate } from './client.js'
import { articleBeats, articles } from './schema.js'
import type { Article, DeliveryKind } from './schema.js'
import type { ArticleRanking, BeatLink, DiscoveredArticle, PendingArticle } from './types.js'

/**
 * Articles, and what each beat made of them.
 *
 * Two tables, and the split is the point: `articles` is what is true about a
 * story, `article_beats` is one beat's opinion of it. A story on three beats is
 * stored once and judged three times.
 */

/**
 * Inserts newly discovered articles, ignoring any whose id already exists. Since
 * the id is a hash of the canonical link, this is the global dedupe: a story
 * carried by two feeds — or matching two beats — is stored once.
 *
 * Returns the number of genuinely new articles. A story that was already stored
 * is *not* counted, but it may still gain a beat link below — the two numbers
 * answer different questions and a run reports both.
 */
export async function insertDiscovered(discovered: DiscoveredArticle[]): Promise<number> {
  if (discovered.length === 0) return 0
  await migrate()
  const now = Date.now()
  const inserted = await db()
    .insert(articles)
    .values(discovered.map(article => ({ ...article, discoveredAt: now })))
    .onConflictDoNothing()
    .returning({ id: articles.id })
  return inserted.length
}

/**
 * Attaches articles to the beats whose feeds carried them.
 *
 * Conflicts are ignored, which makes this idempotent across runs: a story still
 * being served by its feed re-links to the same beat and keeps whatever score it
 * already has, rather than being reset to unranked and scored a second time.
 *
 * `subtopic` is the feed's pin, written here at ingest so it is in place before
 * the ranker runs — `saveRankings` coalesces onto it rather than overwriting.
 */
export async function linkToBeats(links: BeatLink[]): Promise<number> {
  if (links.length === 0) return 0
  await migrate()
  const inserted = await db()
    .insert(articleBeats)
    .values(
      links.map(link => ({
        articleId: link.articleId,
        beatSlug: link.beatSlug,
        subtopic: link.subtopic,
      })),
    )
    .onConflictDoNothing()
    .returning({ articleId: articleBeats.articleId })
  return inserted.length
}

/**
 * Articles already stored from a feed, recent enough to still be news.
 *
 * This is what makes a *newly subscribed* beat useful immediately, and it exists
 * because of a trap that is invisible until you hit it. `feed_state` is keyed by
 * URL, so a feed another beat already polls answers **304** — the next run fetches
 * it, gets nothing back, and the new beat is linked to nothing. Not until the
 * feed's content actually changes, which on a quiet source is days.
 *
 * The articles are not missing, though: they are already in this table. So the
 * fix is a read, not a re-fetch — link what is already stored and let the normal
 * pipeline rank it. Clearing `feed_state` to force a 200 was the obvious answer
 * and is the weaker one: it recovers only what the feed *currently serves*, which
 * for Hacker News is fifteen items and for a dormant feed is nothing at all.
 *
 * `maxItemAgeDays`, not `retentionDays`. Articles are kept for 30 days but only
 * ingested within 7, so backfilling the full retention window would hand a new
 * beat three-week-old stories to rank and deliver as news. The window ingest uses
 * is the window that defines "current".
 */
export async function articleIdsFromFeed(feedUrl: string, since: number): Promise<string[]> {
  await migrate()
  const rows = await db()
    .select({ id: articles.id })
    .from(articles)
    .where(and(eq(articles.feedUrl, feedUrl), gte(articles.discoveredAt, since)))
  return rows.map(row => row.id)
}

/**
 * Articles this beat has not yet judged, oldest first.
 *
 * Joins rather than selecting from `articles` alone because "unranked" is now a
 * property of the pair: the same story can be settled on one beat and pending on
 * another. `subtopic` comes from the link row, so a feed's pin reaches the
 * ranker's input the same way it used to.
 */
export async function listUnranked(beatSlug: string, limit: number): Promise<PendingArticle[]> {
  await migrate()
  const rows = await db()
    .select({ article: articles, subtopic: articleBeats.subtopic })
    .from(articleBeats)
    .innerJoin(articles, eq(articles.id, articleBeats.articleId))
    .where(and(eq(articleBeats.beatSlug, beatSlug), isNull(articleBeats.rankedAt)))
    .orderBy(asc(articles.discoveredAt))
    .limit(limit)
  return rows.map(row => ({ ...row.article, subtopic: row.subtopic }))
}

export async function saveRankings(beatSlug: string, rankings: ArticleRanking[]): Promise<void> {
  if (rankings.length === 0) return
  await migrate()
  const now = Date.now()
  await batchAll(
    rankings.map(ranking =>
      db()
        .update(articleBeats)
        .set({
          score: ranking.score,
          // A feed-pinned subtopic wins over the ranker's guess.
          subtopic: sql`coalesce(${articleBeats.subtopic}, ${ranking.subtopic})`,
          reason: ranking.reason,
          rankedAt: now,
        })
        .where(
          and(eq(articleBeats.beatSlug, beatSlug), eq(articleBeats.articleId, ranking.id)),
        ),
    ),
  )
}

export async function saveClusters(
  beatSlug: string,
  assignments: { id: string; clusterId: string }[],
): Promise<void> {
  if (assignments.length === 0) return
  await migrate()
  await batchAll(
    assignments.map(assignment =>
      db()
        .update(articleBeats)
        .set({ clusterId: assignment.clusterId })
        .where(
          and(eq(articleBeats.beatSlug, beatSlug), eq(articleBeats.articleId, assignment.id)),
        ),
    ),
  )
}

/** A beat's verdict on an article that is ranked, undelivered, and still in play. */
export interface Candidate {
  article: Article
  beatSlug: string
  score: number
  subtopic: string | null
  reason: string | null
}

/**
 * Every ranked, undelivered article across the given beats, best first.
 *
 * This is the input to arbitration, which is why it spans beats rather than
 * running per beat: a story is delivered to exactly one beat — the highest
 * scorer among those clearing their own threshold — and no single beat's run can
 * know it lost. Ordering is applied here so the caller's "first wins" grouping is
 * the same thing as "highest score wins".
 *
 * `minScore` is the *lowest* threshold among the beats in play, not each beat's
 * own. It exists to bound the result set; the per-beat threshold is applied by
 * the caller, which is the only place that has each beat resolved.
 */
export async function listRankedUndelivered(
  beatSlugs: readonly string[],
  minScore: number,
): Promise<Candidate[]> {
  if (beatSlugs.length === 0) return []
  await migrate()
  const rows = await db()
    .select({
      article: articles,
      beatSlug: articleBeats.beatSlug,
      score: articleBeats.score,
      subtopic: articleBeats.subtopic,
      reason: articleBeats.reason,
    })
    .from(articleBeats)
    .innerJoin(articles, eq(articles.id, articleBeats.articleId))
    .where(
      and(
        inArray(articleBeats.beatSlug, [...beatSlugs]),
        isNull(articles.deliveredAt),
        isNotNull(articleBeats.rankedAt),
        gte(articleBeats.score, minScore),
      ),
    )
    .orderBy(desc(articleBeats.score), desc(articles.publishedAt))
  return rows.map(row => ({
    article: row.article,
    beatSlug: row.beatSlug,
    score: row.score ?? 0,
    subtopic: row.subtopic,
    reason: row.reason,
  }))
}

/**
 * Marks articles delivered, recording which beat sent them.
 *
 * Written on `articles` rather than on the link row because a story goes out
 * once: the losing beats keep their score and their reason, and the fact that
 * this article is spent is true for all of them at once. Guarded on
 * `deliveredAt is null` so a concurrent beat cannot double-send a story that
 * arbitration awarded elsewhere between the read and the write.
 */
export async function markDelivered(
  ids: string[],
  beatSlug: string,
  kind: DeliveryKind,
): Promise<void> {
  if (ids.length === 0) return
  await migrate()
  await db()
    .update(articles)
    .set({ deliveredAt: Date.now(), deliveredBeat: beatSlug, deliveryKind: kind })
    .where(and(inArray(articles.id, ids), isNull(articles.deliveredAt)))
}

/**
 * True when this image already appears on a *different* article from the same
 * feed — the signature of a site-wide banner rather than the post's own
 * artwork. og:image is only worth using when it is post-specific, and repetition
 * across a feed is the cheapest reliable way to tell the difference.
 *
 * Self-correcting rather than perfect: the first post carrying a banner passes,
 * and every later one is caught once that URL is on record.
 */
export async function isSharedFeedImage(
  feedUrl: string,
  imageUrl: string,
  exceptArticleId: string,
): Promise<boolean> {
  await migrate()
  const rows = await db()
    .select({ id: articles.id })
    .from(articles)
    .where(
      and(
        eq(articles.feedUrl, feedUrl),
        eq(articles.imageUrl, imageUrl),
        ne(articles.id, exceptArticleId),
      ),
    )
    .limit(1)
  return rows.length > 0
}

export async function saveImageUrl(id: string, imageUrl: string): Promise<void> {
  await migrate()
  await db().update(articles).set({ imageUrl }).where(eq(articles.id, id))
}

export async function getArticle(id: string): Promise<Article | null> {
  await migrate()
  const rows = await db().select().from(articles).where(eq(articles.id, id)).limit(1)
  return rows[0] ?? null
}

/**
 * Every beat's verdict on one article, best score first.
 *
 * The near-miss reader: the ranker writes a `reason` for everything it scores,
 * so this answers "why didn't you send me that?" — including for the beats that
 * scored it and lost. Nothing consumed this before the split, because there was
 * only ever one verdict per article and it was on the article itself.
 */
/** What one feed has actually done for one beat over a window. */
export interface FeedPerformance {
  feedUrl: string
  /** Articles this feed contributed to this beat. */
  collected: number
  /** How many of those the ranker has scored. The rest arrived too recently. */
  ranked: number
  /** How many this beat actually sent. The number that matters. */
  delivered: number
  /** Mean score over the ranked ones, rounded. Null when none are ranked yet. */
  meanScore: number | null
  /** Best score it ever earned here — one good story is worth knowing about. */
  bestScore: number | null
}

/**
 * Per-feed performance for one beat, worst first.
 *
 * The number that decides whether a feed earns its keep. Every feed is fetched on
 * every digest and every article it brings is ranked, so a feed that has
 * contributed 300 articles and delivered none is pure cost — and nothing in the
 * system could see that before this.
 *
 * **Attribution is approximate for a shared feed, and knowingly so.**
 * `articles.feedUrl` is the feed a story was *first seen in*, and the id is a
 * hash of the link, so a story carried by two feeds is stored once against
 * whichever won the race. A feed whose stories consistently arrive via a faster
 * sibling therefore looks emptier than it is. Correcting it would mean a
 * per-(article, feed) table, which is a large change to make a report tidier —
 * so this is documented rather than fixed, and the weekly review needs a minimum
 * sample before it acts on any of it.
 *
 * Ordered worst first because every caller is looking for the bad ones.
 */
export async function feedPerformance(
  beatSlug: string,
  since: number,
): Promise<FeedPerformance[]> {
  await migrate()
  const rows = await db()
    .select({
      feedUrl: articles.feedUrl,
      collected: sql<number>`count(*)`,
      ranked: sql<number>`sum(case when ${articleBeats.rankedAt} is not null then 1 else 0 end)`,
      delivered: sql<number>`sum(case when ${articles.deliveredBeat} = ${beatSlug} then 1 else 0 end)`,
      meanScore: sql<number | null>`avg(${articleBeats.score})`,
      bestScore: sql<number | null>`max(${articleBeats.score})`,
    })
    .from(articleBeats)
    .innerJoin(articles, eq(articles.id, articleBeats.articleId))
    .where(and(eq(articleBeats.beatSlug, beatSlug), gte(articles.discoveredAt, since)))
    .groupBy(articles.feedUrl)

  return rows
    .map(row => ({
      feedUrl: row.feedUrl,
      collected: Number(row.collected ?? 0),
      ranked: Number(row.ranked ?? 0),
      delivered: Number(row.delivered ?? 0),
      meanScore: row.meanScore === null ? null : Math.round(Number(row.meanScore)),
      bestScore: row.bestScore === null ? null : Number(row.bestScore),
    }))
    .sort(
      (a, b) =>
        a.delivered - b.delivered || (a.meanScore ?? 0) - (b.meanScore ?? 0) || b.collected - a.collected,
    )
}

export async function verdictsForArticle(articleId: string): Promise<
  { beatSlug: string; score: number | null; subtopic: string | null; reason: string | null }[]
> {
  await migrate()
  return db()
    .select({
      beatSlug: articleBeats.beatSlug,
      score: articleBeats.score,
      subtopic: articleBeats.subtopic,
      reason: articleBeats.reason,
    })
    .from(articleBeats)
    .where(eq(articleBeats.articleId, articleId))
    .orderBy(desc(articleBeats.score))
}

/**
 * Deletes articles discovered before `cutoff`, in batches, and reports how many
 * went. This is the whole of retention — there is no soft delete and no
 * tombstone.
 *
 * `discoveredAt` rather than `publishedAt` because it is the non-null column and
 * it measures the thing being reclaimed: how long this row has occupied the
 * database. It is also the safe one for dedupe. An article published *after* we
 * discovered it does not exist, so `discoveredAt < cutoff` implies
 * `publishedAt < cutoff`, and with `retentionDays` well above `maxItemAgeDays`
 * that guarantees ingest would reject the same story on sight rather than
 * treating a freed id as a new story. See `pipeline.retentionDays`.
 *
 * Link rows go with the article. There is no foreign key to cascade — SQLite
 * would need one declared and enforced — so the delete is explicit and runs
 * first, in the same batch window, or `article_beats` accumulates rows pointing
 * at nothing and every join silently gets narrower.
 *
 * Batched because each row fires the `articles_fts` delete trigger: one statement
 * over thousands of rows is a long write lock, and the digest schedules share
 * this connection.
 */
export async function deleteArticlesOlderThan(
  cutoff: number,
  batchSize: number,
): Promise<{ articles: number; links: number }> {
  await migrate()
  let deletedArticles = 0
  let deletedLinks = 0
  for (;;) {
    // Materialized rather than left as a subquery: the ids are needed twice, and
    // the second use runs after the first has already deleted the rows a
    // subquery would re-evaluate against.
    const batch = await db()
      .select({ id: articles.id })
      .from(articles)
      .where(lt(articles.discoveredAt, cutoff))
      .limit(batchSize)
    if (batch.length === 0) return { articles: deletedArticles, links: deletedLinks }

    const ids = batch.map(row => row.id)
    const links = await db()
      .delete(articleBeats)
      .where(inArray(articleBeats.articleId, ids))
      .returning({ articleId: articleBeats.articleId })
    const gone = await db()
      .delete(articles)
      .where(inArray(articles.id, ids))
      .returning({ id: articles.id })

    deletedLinks += links.length
    deletedArticles += gone.length
    if (gone.length < batchSize) return { articles: deletedArticles, links: deletedLinks }
  }
}
