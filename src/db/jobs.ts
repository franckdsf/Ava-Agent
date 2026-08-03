import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'
import { jobPipeline } from '../config/jobs.js'
import { SEED_JOB_SOURCES } from '../config/seed-job-sources.js'
import { db, migrate } from './client.js'
import {
  jobDeliveries,
  jobMatches,
  jobRuns,
  jobSources,
  jobs,
  type Job,
  type JobSource,
  type NewJob,
} from './schema.js'

/**
 * Reads and writes the job tables.
 *
 * Mirrors `src/db/articles.ts` in shape — insert-many with conflicts ignored,
 * link to searches, list unscored, save verdicts, mark delivered — because the
 * pipeline stages are the same. What differs is entirely in the identity and the
 * delivery ledger; see `src/services/job-identity.ts` and the note on
 * `jobDeliveries` in `schema.ts`.
 */

/** Writes the starter sources if the table is empty. A no-op on every later boot. */
export async function seedJobSources(): Promise<number> {
  await migrate()
  const existing = await db().select({ id: jobSources.id }).from(jobSources).limit(1)
  if (existing.length > 0) return 0
  await db().insert(jobSources).values(SEED_JOB_SOURCES).onConflictDoNothing()
  return SEED_JOB_SOURCES.length
}

export async function activeJobSources(): Promise<JobSource[]> {
  await migrate()
  return db()
    .select()
    .from(jobSources)
    .where(isNull(jobSources.archivedAt))
    .orderBy(asc(jobSources.id))
}

/** Records what a fetch did, so a source that quietly stops returning is visible. */
export async function recordSourceFetch(
  sourceId: string,
  update: {
    status: string
    error?: string
    etag?: string | null
    lastModified?: string | null
    count?: number
  },
): Promise<void> {
  await migrate()
  await db()
    .update(jobSources)
    .set({
      lastFetchedAt: Date.now(),
      lastStatus: update.status,
      lastError: update.error ?? null,
      // A 304 carries no validators of its own; keeping the stored ones is what
      // makes the *next* request conditional too.
      ...(update.etag !== undefined ? { etag: update.etag } : {}),
      ...(update.lastModified !== undefined ? { lastModified: update.lastModified } : {}),
      ...(update.count !== undefined ? { lastCount: update.count } : {}),
    })
    .where(eq(jobSources.id, sourceId))
}

/**
 * Inserts postings, ignoring ones already stored.
 *
 * `onConflictDoNothing` on the month-keyed primary key **is** the cross-board
 * dedupe: the same role on five boards produces five identical ids and one row.
 * Returns how many were genuinely new.
 */
export async function insertJobs(postings: NewJob[]): Promise<number> {
  if (postings.length === 0) return 0
  await migrate()
  let inserted = 0
  // Chunked because SQLite caps variables per statement and a first run can
  // carry several hundred postings across every source at once.
  for (let index = 0; index < postings.length; index += 50) {
    const result = await db()
      .insert(jobs)
      .values(postings.slice(index, index + 50))
      .onConflictDoNothing()
    inserted += result.rowsAffected ?? 0
  }
  return inserted
}

/** Attaches postings to a search, so that search's scorer will see them. */
export async function linkToSearch(jobIds: string[], searchSlug: string): Promise<number> {
  if (jobIds.length === 0) return 0
  await migrate()
  let linked = 0
  for (let index = 0; index < jobIds.length; index += 50) {
    const result = await db()
      .insert(jobMatches)
      .values(jobIds.slice(index, index + 50).map(jobId => ({ jobId, searchSlug })))
      .onConflictDoNothing()
    linked += result.rowsAffected ?? 0
  }
  return linked
}

/**
 * Attaches every stored posting this search has never seen to it.
 *
 * **The step the first live run was missing.** `listUnscored` reads through
 * `job_matches`, so a search with no rows there sees nothing however many
 * postings are stored — the run fetched 383, considered 0, and finished in three
 * seconds looking exactly like a working pipeline with nothing to say.
 *
 * Done here rather than at ingest, and that is deliberate: a search created
 * today is linked to everything already in the table, so it starts with a real
 * batch instead of only whatever the boards publish next. Same reasoning as
 * `/addfeed` backfilling a beat from the database rather than re-fetching.
 *
 * Undelivered only — a posting already sent should not come back as pending work
 * for a search that did not send it. `onConflictDoNothing` inside `linkToSearch`
 * makes this idempotent, so running it every cycle costs one insert that mostly
 * does nothing.
 */
export async function linkPendingToSearch(searchSlug: string): Promise<number> {
  await migrate()
  const rows = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .leftJoin(
      jobMatches,
      and(eq(jobMatches.jobId, jobs.id), eq(jobMatches.searchSlug, searchSlug)),
    )
    .where(and(isNull(jobMatches.jobId), isNull(jobs.deliveredAt)))
    .orderBy(desc(jobs.discoveredAt))
  return linkToSearch(
    rows.map(row => row.id),
    searchSlug,
  )
}

/** Postings this search has not scored yet, newest first. */
export async function listUnscored(searchSlug: string, limit: number): Promise<Job[]> {
  await migrate()
  const rows = await db()
    .select({ job: jobs })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobs.id, jobMatches.jobId))
    .where(and(eq(jobMatches.searchSlug, searchSlug), isNull(jobMatches.scoredAt)))
    .orderBy(desc(jobs.discoveredAt))
    .limit(limit)
  return rows.map(row => row.job)
}

export interface JobVerdict {
  jobId: string
  fit: number
  reason: string
  mismatches: string[]
}

export async function saveVerdicts(searchSlug: string, verdicts: JobVerdict[]): Promise<void> {
  if (verdicts.length === 0) return
  await migrate()
  const now = Date.now()
  for (const verdict of verdicts) {
    await db()
      .update(jobMatches)
      .set({
        fit: verdict.fit,
        reason: verdict.reason,
        mismatches: verdict.mismatches,
        scoredAt: now,
      })
      .where(and(eq(jobMatches.jobId, verdict.jobId), eq(jobMatches.searchSlug, searchSlug)))
  }
}

export interface ScoredJob {
  job: Job
  searchSlug: string
  fit: number
  reason: string | null
  mismatches: string[] | null
}

/**
 * Scored, undelivered postings across the given searches, best fit first.
 *
 * The ordering is load-bearing in the same way `listRankedUndelivered` is: the
 * arbiter takes the first verdict it sees for a posting as its best one, so
 * "take the first N" means "take the best N" rather than an arbitrary slice.
 */
export async function listScoredUndelivered(
  searchSlugs: string[],
  minFit: number,
): Promise<ScoredJob[]> {
  if (searchSlugs.length === 0) return []
  await migrate()
  const rows = await db()
    .select({ job: jobs, match: jobMatches })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobs.id, jobMatches.jobId))
    .where(
      and(
        inArray(jobMatches.searchSlug, searchSlugs),
        isNull(jobs.deliveredAt),
        gte(jobMatches.fit, minFit),
      ),
    )
    .orderBy(desc(jobMatches.fit))
  return rows.map(row => ({
    job: row.job,
    searchSlug: row.match.searchSlug,
    fit: row.match.fit ?? 0,
    reason: row.match.reason,
    mismatches: row.match.mismatches,
  }))
}

/**
 * Identities delivered recently enough to suppress a re-send.
 *
 * This is the guard that actually prevents a duplicate, rather than the ratio
 * between the ingest window and retention — see the note on `jobDeliveries` in
 * `schema.ts` for the hole it closes.
 */
export async function recentlyDelivered(identities: string[]): Promise<Set<string>> {
  if (identities.length === 0) return new Set()
  await migrate()
  const cutoff = Date.now() - jobPipeline.redeliveryGuardDays * 24 * 60 * 60 * 1000
  const rows = await db()
    .select({ identity: jobDeliveries.identity })
    .from(jobDeliveries)
    .where(and(inArray(jobDeliveries.identity, identities), gte(jobDeliveries.deliveredAt, cutoff)))
  return new Set(rows.map(row => row.identity))
}

/**
 * Marks a posting delivered and writes its permanent ledger row.
 *
 * Both together, because a posting that reached the reader without a ledger row
 * is one that can be sent again. `onConflictDoUpdate` on the identity refreshes
 * the date rather than appending — the only question this table answers is how
 * long ago something was seen.
 */
export async function markJobDelivered(job: Job, searchSlug: string): Promise<void> {
  await migrate()
  const now = Date.now()
  await db()
    .update(jobs)
    .set({ deliveredAt: now, deliveredSearch: searchSlug })
    .where(eq(jobs.id, job.id))
  await db()
    .insert(jobDeliveries)
    .values({
      identity: job.identity,
      company: job.company,
      title: job.title,
      url: job.url,
      searchSlug,
      deliveredAt: now,
    })
    .onConflictDoUpdate({
      target: jobDeliveries.identity,
      set: { deliveredAt: now, searchSlug, url: job.url, title: job.title, company: job.company },
    })
}

/**
 * Deletes postings past retention.
 *
 * `job_deliveries` is deliberately untouched: it is what stops a posting a board
 * still serves from being re-ingested and re-sent once its `jobs` row is gone.
 */
export async function pruneJobs(): Promise<number> {
  await migrate()
  const cutoff = Date.now() - jobPipeline.retentionDays * 24 * 60 * 60 * 1000
  const stale = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(lt(jobs.discoveredAt, cutoff))
  if (stale.length === 0) return 0

  const ids = stale.map(row => row.id)
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100)
    await db().delete(jobMatches).where(inArray(jobMatches.jobId, batch))
    await db().delete(jobs).where(inArray(jobs.id, batch))
  }
  return ids.length
}

/**
 * When the last run started, or null if none ever has.
 *
 * Read by the workflow's gate. Deliberately `startedAt` and not `finishedAt`: a
 * run that crashed halfway still consumed the cycle's fetches and model calls,
 * and re-running it an hour later on the next daily fire would double them.
 */
export async function lastRunStartedAt(): Promise<number | null> {
  await migrate()
  const [row] = await db()
    .select({ startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .orderBy(desc(jobRuns.startedAt))
    .limit(1)
  return row?.startedAt ?? null
}

export async function startJobRun(): Promise<string> {
  await migrate()
  const id = `run-${Date.now().toString(36)}`
  await db().insert(jobRuns).values({ id, startedAt: Date.now() })
  return id
}

export async function finishJobRun(
  id: string,
  counters: {
    fetched?: number
    stored?: number
    considered?: number
    scored?: number
    delivered?: number
    note?: string
  },
): Promise<void> {
  await migrate()
  await db()
    .update(jobRuns)
    .set({ finishedAt: Date.now(), ...counters })
    .where(eq(jobRuns.id, id))
}

/** Counts for a report, in one round trip. */
export async function jobCounts(): Promise<{ stored: number; delivered: number; sources: number }> {
  await migrate()
  const [row] = await db()
    .select({
      stored: sql<number>`count(*)`,
      delivered: sql<number>`sum(case when ${jobs.deliveredAt} is not null then 1 else 0 end)`,
    })
    .from(jobs)
  const sources = await db().select({ id: jobSources.id }).from(jobSources).where(isNull(jobSources.archivedAt))
  return {
    stored: Number(row?.stored ?? 0),
    delivered: Number(row?.delivered ?? 0),
    sources: sources.length,
  }
}
