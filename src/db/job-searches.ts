import { asc, eq, isNotNull, isNull } from 'drizzle-orm'
import { db, migrate } from './client.js'
import {
  jobSearches,
  type JobSearch,
  type NewJobSearch,
  type TargetSuggestion,
} from './schema.js'

/**
 * Reads and writes `job_searches` — what Joob is looking for.
 *
 * Every function awaits `migrate()` first, like every other repository here: a
 * migration that throws must take down the caller rather than surface later as a
 * missing column.
 *
 * Nothing in this file writes a fit score, a delivery or a run's output. It is
 * the configuration half of [invariant 8](../../AGENTS.md#invariants), which is
 * what makes it legal to call from a slash command.
 */

/** Active searches, oldest first so `/targets` reads in the order they were made. */
export async function activeSearches(): Promise<JobSearch[]> {
  await migrate()
  return db()
    .select()
    .from(jobSearches)
    .where(isNull(jobSearches.archivedAt))
    .orderBy(asc(jobSearches.createdAt))
}

/** Archived searches, for reporting what `/untarget` has switched off. */
export async function archivedSearches(): Promise<JobSearch[]> {
  await migrate()
  return db()
    .select()
    .from(jobSearches)
    .where(isNotNull(jobSearches.archivedAt))
    .orderBy(asc(jobSearches.createdAt))
}

export async function getSearch(slug: string): Promise<JobSearch | undefined> {
  await migrate()
  const rows = await db().select().from(jobSearches).where(eq(jobSearches.slug, slug)).limit(1)
  return rows[0]
}

/**
 * Writes a search, replacing one with the same slug.
 *
 * An upsert rather than an insert because re-running `/target` with a refined
 * sentence is the normal way to correct a bad parse — the reader sees what was
 * understood, disagrees, and says it again more precisely. Making that a
 * duplicate row with a suffixed slug would leave the wrong one running.
 *
 * `archivedAt` is reset to null on conflict, so re-targeting something
 * previously switched off brings it back rather than silently writing a row that
 * stays archived. That is the opposite of how `beat_feeds` treats a
 * reader-removed feed, and deliberately: there, the reader's removal must
 * survive an automated re-proposal; here, the reader *is* the one re-adding it.
 *
 * Any stored suggestion is cleared, explicitly rather than by omission: the
 * caller spreads a row it read earlier, so leaving these out of the `set` would
 * carry advice about the *previous* criteria onto the new ones. `/target` writes
 * a fresh suggestion after this call when the new target is still loose.
 */
export async function saveSearch(search: NewJobSearch): Promise<void> {
  await migrate()
  // Stamped here rather than by the caller, on both the insert and the update
  // paths, because every route into this function is a criteria change by
  // definition — `/target`, `/retarget` and the advisor's applied suggestion all
  // land here. A caller that had to remember would eventually forget, and the
  // failure is silent: source yield would go on being measured against a bar
  // that had moved.
  const values = { ...search, suggestion: null, suggestedAt: null, criteriaChangedAt: Date.now() }
  await db()
    .insert(jobSearches)
    .values(values)
    .onConflictDoUpdate({
      target: jobSearches.slug,
      set: { ...values, archivedAt: null },
    })
}

/**
 * Parks the advisor's proposal on the search it is about.
 *
 * Separate from `saveSearch` because it is written *after* it — the advisor only
 * runs once the row exists, and a failed fetch or a failed call must leave that
 * row intact.
 */
export async function saveSuggestion(slug: string, suggestion: TargetSuggestion): Promise<void> {
  await migrate()
  await db()
    .update(jobSearches)
    .set({ suggestion, suggestedAt: Date.now() })
    .where(eq(jobSearches.slug, slug))
}

/**
 * Switches a search off without losing it, or back on.
 *
 * Soft, for the reason pausing a beat is: the postings it won stay readable and
 * the definition survives, so "stop looking for this" and "delete this" are the
 * same operation at two depths and neither loses history.
 */
export async function setSearchArchived(slug: string, archived: boolean): Promise<boolean> {
  await migrate()
  const result = await db()
    .update(jobSearches)
    .set({ archivedAt: archived ? Date.now() : null })
    .where(eq(jobSearches.slug, slug))
  return (result.rowsAffected ?? 0) > 0
}
