import { desc, eq } from 'drizzle-orm'
import { db, migrate } from './client.js'
import { feedback, items } from './schema.js'
import type { Vote } from './schema.js'

/** A past verdict, shaped for injection into the ranker's interest profile. */
export interface FeedbackSignal {
  title: string
  source: string
  vote: Vote
}

/** Re-voting on the same item overwrites the previous vote. */
export async function recordVote(itemId: string, categorySlug: string, vote: Vote): Promise<void> {
  await migrate()
  await db()
    .insert(feedback)
    .values({ itemId, categorySlug, vote, createdAt: Date.now() })
    .onConflictDoUpdate({
      target: feedback.itemId,
      set: { vote, createdAt: Date.now() },
    })
}

/**
 * Most recent votes for a category, newest first. This is what turns a static
 * rubric into a curator that learns your taste.
 */
export async function recentFeedback(
  categorySlug: string,
  limit: number,
): Promise<FeedbackSignal[]> {
  await migrate()
  return db()
    .select({ title: items.title, source: items.source, vote: feedback.vote })
    .from(feedback)
    .innerJoin(items, eq(items.id, feedback.itemId))
    .where(eq(feedback.categorySlug, categorySlug))
    .orderBy(desc(feedback.createdAt))
    .limit(limit)
}
