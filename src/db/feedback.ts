import { desc, eq } from 'drizzle-orm'
import { db, migrate } from './client.js'
import { feedback } from './schema.js'
import type { Item, Vote } from './schema.js'

/** A past verdict, shaped for injection into the ranker's interest profile. */
export interface FeedbackSignal {
  title: string
  source: string
  vote: Vote
}

/**
 * Records a 👍/👎. Re-voting on the same item overwrites the previous vote.
 *
 * Takes the whole item rather than an id because the title and source are stored
 * *with* the vote — see the note on the `feedback` table. Caller has the item in
 * hand anyway: a vote arrives as a reaction to a message that was built from it.
 */
export async function recordVote(item: Item, vote: Vote): Promise<void> {
  await migrate()
  const now = Date.now()
  await db()
    .insert(feedback)
    .values({
      itemId: item.id,
      categorySlug: item.categorySlug,
      title: item.title,
      source: item.source,
      vote,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: feedback.itemId,
      // Title and source are deliberately not refreshed: they describe the
      // article as it was when the reader judged it.
      set: { vote, createdAt: now },
    })
}

/**
 * Most recent votes for a category, newest first. This is what turns a static
 * rubric into a curator that learns your taste.
 *
 * Reads only `feedback`. It used to join `items` for the title, which quietly
 * coupled the reader's taste to article retention — every vote older than
 * `retentionDays` would have vanished from the profile the day its article was
 * pruned, with no error and no empty result to notice.
 */
export async function recentFeedback(
  categorySlug: string,
  limit: number,
): Promise<FeedbackSignal[]> {
  await migrate()
  return db()
    .select({ title: feedback.title, source: feedback.source, vote: feedback.vote })
    .from(feedback)
    .where(eq(feedback.categorySlug, categorySlug))
    .orderBy(desc(feedback.createdAt))
    .limit(limit)
}
