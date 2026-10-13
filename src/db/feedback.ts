import { and, desc, eq } from 'drizzle-orm'
import { db, migrate } from './client.js'
import { feedback } from './schema.js'
import type { Article, Vote } from './schema.js'

/** A past verdict, shaped for injection into the ranker's interest profile. */
export interface FeedbackSignal {
  title: string
  source: string
  vote: Vote
}

/**
 * Records a 👍/👎. Re-voting on the same article overwrites the previous vote.
 *
 * Takes the whole article rather than an id because the title and source are
 * stored *with* the vote — see the note on the `feedback` table. Caller has the
 * article in hand anyway: a vote arrives as a reaction to a message that was
 * built from it.
 *
 * The beat is passed separately now rather than read off the article. A story
 * can be scored on several beats, so "which beat was this vote about" is a
 * question about the message the reader reacted to — the tab it was sitting in —
 * not about the row. That is `articles.deliveredBeat` at the call site.
 */
export async function recordVote(article: Article, beatSlug: string, vote: Vote): Promise<void> {
  await migrate()
  const now = Date.now()
  await db()
    .insert(feedback)
    .values({
      articleId: article.id,
      beatSlug,
      title: article.title,
      source: article.source,
      vote,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: feedback.articleId,
      // Title and source are deliberately not refreshed: they describe the
      // article as it was when the reader judged it.
      set: { vote, createdAt: now },
    })
}

/**
 * Most recent votes for a beat, newest first. This is what turns a static
 * rubric into a curator that learns your taste.
 *
 * Reads only `feedback`. It used to join the articles table for the title, which
 * quietly coupled the reader's taste to article retention — every vote older than
 * `retentionDays` would have vanished from the profile the day its article was
 * pruned, with no error and no empty result to notice.
 */
export async function recentFeedback(beatSlug: string, limit: number): Promise<FeedbackSignal[]> {
  await migrate()
  return db()
    .select({ title: feedback.title, source: feedback.source, vote: feedback.vote })
    .from(feedback)
    .where(eq(feedback.beatSlug, beatSlug))
    .orderBy(desc(feedback.createdAt))
    .limit(limit)
}

/**
 * The reader's own votes, newest first, optionally one beat or one direction.
 *
 * No join to `articles`: a vote carries its own title and source so it survives
 * the article being pruned. Votes outlive articles here by design.
 */
export async function votes(opts: {
  beat?: string
  vote?: Vote
  limit: number
}): Promise<{ title: string; source: string; vote: Vote; beat: string }[]> {
  await migrate()
  return db()
    .select({
      title: feedback.title,
      source: feedback.source,
      vote: feedback.vote,
      beat: feedback.beatSlug,
    })
    .from(feedback)
    .where(
      and(
        ...(opts.beat ? [eq(feedback.beatSlug, opts.beat)] : []),
        ...(opts.vote ? [eq(feedback.vote, opts.vote)] : []),
      ),
    )
    .orderBy(desc(feedback.createdAt))
    .limit(opts.limit)
}
