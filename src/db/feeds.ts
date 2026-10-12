import { eq } from 'drizzle-orm'
import { db, migrate } from './client.js'
import { feedState } from './schema.js'
import type { FeedStateRow } from './schema.js'

export async function getFeedState(feedUrl: string): Promise<FeedStateRow | null> {
  await migrate()
  const rows = await db().select().from(feedState).where(eq(feedState.feedUrl, feedUrl)).limit(1)
  return rows[0] ?? null
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
