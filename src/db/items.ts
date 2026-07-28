import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'
import { batchAll, db, migrate } from './client.js'
import { items } from './schema.js'
import type { DeliveryKind, Item } from './schema.js'
import type { DiscoveredItem, ItemRanking } from './types.js'

/**
 * Inserts newly discovered items, ignoring any whose id already exists. Since
 * the id is a hash of the canonical link, this is the global dedupe: a story
 * carried by two feeds — or matching two categories — is stored once.
 *
 * Returns the number of genuinely new items.
 */
export async function insertDiscovered(discovered: DiscoveredItem[]): Promise<number> {
  if (discovered.length === 0) return 0
  await migrate()
  const now = Date.now()
  const inserted = await db()
    .insert(items)
    .values(discovered.map(item => ({ ...item, discoveredAt: now })))
    .onConflictDoNothing()
    .returning({ id: items.id })
  return inserted.length
}

/** Items awaiting a ranking verdict, oldest first. */
export async function listUnranked(categorySlug: string, limit: number): Promise<Item[]> {
  await migrate()
  return db()
    .select()
    .from(items)
    .where(and(eq(items.categorySlug, categorySlug), isNull(items.rankedAt)))
    .orderBy(asc(items.discoveredAt))
    .limit(limit)
}

export async function saveRankings(rankings: ItemRanking[]): Promise<void> {
  if (rankings.length === 0) return
  await migrate()
  const now = Date.now()
  await batchAll(
    rankings.map(ranking =>
      db()
        .update(items)
        .set({
          score: ranking.score,
          // A feed-pinned subtopic wins over the ranker's guess.
          subtopic: sql`coalesce(${items.subtopic}, ${ranking.subtopic})`,
          reason: ranking.reason,
          rankedAt: now,
        })
        .where(eq(items.id, ranking.id)),
    ),
  )
}

export async function saveClusters(
  assignments: { id: string; clusterId: string }[],
): Promise<void> {
  if (assignments.length === 0) return
  await migrate()
  await batchAll(
    assignments.map(assignment =>
      db()
        .update(items)
        .set({ clusterId: assignment.clusterId })
        .where(eq(items.id, assignment.id)),
    ),
  )
}

/**
 * Ranked, undelivered, at or above `minScore` — best first. Drives both the
 * scheduled digest and the breaking-alert sweep; only the threshold differs.
 */
export async function listDeliverable(
  categorySlug: string,
  minScore: number,
  limit: number,
): Promise<Item[]> {
  await migrate()
  return db()
    .select()
    .from(items)
    .where(
      and(
        eq(items.categorySlug, categorySlug),
        isNull(items.deliveredAt),
        isNotNull(items.rankedAt),
        gte(items.score, minScore),
      ),
    )
    .orderBy(desc(items.score), desc(items.publishedAt))
    .limit(limit)
}

export async function markDelivered(ids: string[], kind: DeliveryKind): Promise<void> {
  if (ids.length === 0) return
  await migrate()
  await db()
    .update(items)
    .set({ deliveredAt: Date.now(), deliveryKind: kind })
    .where(inArray(items.id, ids))
}

/**
 * True when this image already appears on a *different* item from the same
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
  exceptItemId: string,
): Promise<boolean> {
  await migrate()
  const rows = await db()
    .select({ id: items.id })
    .from(items)
    .where(
      and(eq(items.feedUrl, feedUrl), eq(items.imageUrl, imageUrl), ne(items.id, exceptItemId)),
    )
    .limit(1)
  return rows.length > 0
}

export async function saveImageUrl(id: string, imageUrl: string): Promise<void> {
  await migrate()
  await db().update(items).set({ imageUrl }).where(eq(items.id, id))
}

export async function getItem(id: string): Promise<Item | null> {
  await migrate()
  const rows = await db().select().from(items).where(eq(items.id, id)).limit(1)
  return rows[0] ?? null
}

/**
 * Deletes items discovered before `cutoff`, in batches, and reports how many
 * went. This is the whole of retention — there is no soft delete and no
 * tombstone.
 *
 * `discoveredAt` rather than `publishedAt` because it is the non-null column and
 * it measures the thing being reclaimed: how long this row has occupied the
 * database. It is also the safe one for dedupe. An item published *after* we
 * discovered it does not exist, so `discoveredAt < cutoff` implies
 * `publishedAt < cutoff`, and with `retentionDays` well above `maxItemAgeDays`
 * that guarantees ingest would reject the same story on sight rather than
 * treating a freed id as a new story. See `pipeline.retentionDays`.
 *
 * Batched because each row fires the `items_fts` delete trigger: one statement
 * over thousands of rows is a long write lock, and the digest schedules share
 * this connection.
 */
export async function deleteItemsOlderThan(cutoff: number, batchSize: number): Promise<number> {
  await migrate()
  let deleted = 0
  for (;;) {
    // Subquery rather than two round trips: the `limit` belongs to the select,
    // and SQLite does not accept `limit` on `delete` unless it was compiled
    // with SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which libsql is not.
    const batch = db()
      .select({ id: items.id })
      .from(items)
      .where(lt(items.discoveredAt, cutoff))
      .limit(batchSize)
    const gone = await db().delete(items).where(inArray(items.id, batch)).returning({ id: items.id })
    deleted += gone.length
    if (gone.length < batchSize) return deleted
  }
}
