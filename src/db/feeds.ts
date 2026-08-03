import { desc, eq } from 'drizzle-orm'
import { db, migrate } from './client.js'
import { feedState } from './schema.js'
import type { FeedStateRow } from './schema.js'

export async function getFeedState(feedUrl: string): Promise<FeedStateRow | null> {
  await migrate()
  const rows = await db().select().from(feedState).where(eq(feedState.feedUrl, feedUrl)).limit(1)
  return rows[0] ?? null
}

/**
 * When any feed was last fetched, or null if none ever has.
 *
 * The news pipeline keeps no run table, so this is the closest thing it has to
 * "when did it last do anything": ingest writes a row here for every feed it
 * touches, 304s and errors included, and nothing else in the app writes this
 * table — `checkFeed` and the discovery probes deliberately don't, or a
 * `/follow` would look like a curation run. Read by the boot catch-up
 * ([ADR-0025](../../docs/decisions/0025-a-boot-catch-up-for-a-stale-pipeline.md)).
 *
 * Nulls sort last under `DESC` in SQLite, so a feed that has never been fetched
 * cannot mask a real timestamp.
 */
export async function lastFeedFetchAt(): Promise<number | null> {
  await migrate()
  const [row] = await db()
    .select({ lastFetchedAt: feedState.lastFetchedAt })
    .from(feedState)
    .orderBy(desc(feedState.lastFetchedAt))
    .limit(1)
  return row?.lastFetchedAt ?? null
}

export type FeedStateUpdate = Omit<FeedStateRow, 'lastFetchedAt'> & { lastFetchedAt?: number }

export async function saveFeedState(state: FeedStateUpdate): Promise<void> {
  await migrate()
  const row = { ...state, lastFetchedAt: state.lastFetchedAt ?? Date.now() }
  await db()
    .insert(feedState)
    .values(row)
    .onConflictDoUpdate({
      target: feedState.feedUrl,
      set: {
        etag: row.etag,
        lastModified: row.lastModified,
        lastFetchedAt: row.lastFetchedAt,
        lastStatus: row.lastStatus,
        lastError: row.lastError,
      },
    })
}
