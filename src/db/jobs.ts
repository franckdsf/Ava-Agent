import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'
import { jobPipeline, jobScout } from '../config/jobs.js'
import { SEED_JOB_SOURCES } from '../config/seed-job-sources.js'
import { advertKey } from '../services/job-identity.js'
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

/**
 * Remembers an applicant-tracking board a sonar lead turned up.
 *
 * **This is the only way a source row is ever created outside the seed, and it is
 * the pipeline's one compounding mechanism.** Every other cost here is paid again
 * every run: sonar proposes companies, code resolves their pages, and the whole
 * lot is discarded before the next cycle. A board is different — it is a URL that
 * keeps answering. Writing it down converts one model call into a source that is
 * polled for free from then on, so the reader's coverage is a function of how
 * long the pipeline has been running rather than of what one run could afford.
 *
 * `onConflictDoNothing` on a deterministic id makes re-discovery free, which
 * matters because sonar has no memory and will propose a good employer again.
 * **An archived row stays archived**: the reader switching a board off must not be
 * undone by the scout finding it a second time.
 *
 * Returns how many were genuinely new, for the run report.
 */
export async function recordAtsBoards(
  boards: readonly { id: string; adapter: string; url: string; label: string }[],
): Promise<number> {
  if (boards.length === 0) return 0
  await migrate()
  const result = await db()
    .insert(jobSources)
    .values(
      boards.map(board => ({
        id: board.id,
        kind: 'ats' as const,
        adapter: board.adapter,
        url: board.url,
        label: board.label,
        addedAt: Date.now(),
      })),
    )
    .onConflictDoNothing()
  return result.rowsAffected ?? 0
}

/**
 * Labels of every ATS board already known, archived ones included.
 *
 * Handed to the scout as companies to skip. Without it every run spends its
 * proposals re-finding the employers already being polled — the model has no
 * memory between runs, and `seenCompanies` only dedupes within one. Archived
 * boards are in the list on purpose: the reader switched that employer off, and
 * proposing it again is exactly what they asked not to happen.
 */
export async function knownAtsCompanies(): Promise<string[]> {
  await migrate()
  const rows = await db()
    .select({ label: jobSources.label })
    .from(jobSources)
    .where(eq(jobSources.kind, 'ats'))
  return rows.map(row => row.label)
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
      // The empty streak, maintained in SQL rather than by the caller so no fetch
      // path can forget it. `kind <> 'ats'` is the first branch because a 304 on a
      // feed is a healthy zero — see the note on `emptySince` in `schema.ts`.
      ...(update.count !== undefined
        ? {
            emptySince: sql`case
              when ${jobSources.kind} <> 'ats' then null
              when ${update.count} > 0 then null
              when ${jobSources.emptySince} is null then ${Date.now()}
              else ${jobSources.emptySince}
            end`,
          }
        : {}),
    })
    .where(eq(jobSources.id, sourceId))
}

/**
 * Switches off ATS boards that have stopped producing, and forgets old ones.
 *
 * **The counterweight to `recordAtsBoards`.** Discovery with no decay is a table
 * that only grows: boards arrive at up to `leadsPerSearch × maxSearchesPerRun` a
 * day and each one costs a request every run forever. This is what makes the
 * compounding bounded instead of unbounded.
 *
 * Two stages, and the gap between them is load-bearing. A board silent for
 * `atsIdleDays` is *archived* and marked `idle` — it stops being fetched, but the
 * row survives, so `knownAtsCompanies` keeps telling the scout not to propose that
 * employer again. Only after `atsForgetDays` more is the row deleted, which is
 * what finally makes the employer discoverable afresh. Delete at the first stage
 * instead and the next run simply re-finds the same empty board.
 *
 * **`lastStatus = 'idle'` is the marker that separates an automatic archive from
 * the reader's own.** A row the reader archived by hand keeps whatever status its
 * last fetch left, is never deleted, and so can never be undone by rediscovery —
 * their decision outlives the mechanism.
 */
export async function decayAtsBoards(): Promise<{ idled: number; forgotten: number }> {
  await migrate()
  const now = Date.now()

  const idled = await db()
    .update(jobSources)
    .set({ archivedAt: now, lastStatus: 'idle' })
    .where(
      and(
        eq(jobSources.kind, 'ats'),
        isNull(jobSources.archivedAt),
        lt(jobSources.emptySince, now - jobScout.atsIdleDays * 24 * 60 * 60 * 1000),
      ),
    )

  const forgotten = await db()
    .delete(jobSources)
    .where(
      and(
        eq(jobSources.kind, 'ats'),
        eq(jobSources.lastStatus, 'idle'),
        lt(jobSources.archivedAt, now - jobScout.atsForgetDays * 24 * 60 * 60 * 1000),
      ),
    )

  return { idled: idled.rowsAffected ?? 0, forgotten: forgotten.rowsAffected ?? 0 }
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

/**
 * Postings this search has not scored yet, newest first — **by the board's own
 * date, never by when we happened to fetch it**.
 *
 * This ordering is the whole reason some sources are looked at and others are
 * not, because `limit` is far smaller than the backlog. Sorting on
 * `discoveredAt` alone was therefore a silent source filter: ingest stamps
 * `Date.now()` once per run, but before that it stamped it per posting, and
 * sources are fetched in batches of `sourceConcurrency` in `id` order — so every
 * We Work Remotely posting landed a few hundred milliseconds "newer" than every
 * API board's, and `weworkremotely-fullstack`, alphabetically last in its batch,
 * was the newest thing in the table on every run.
 *
 * Measured 2026-08-06, and it is not a small effect. The window of 240 for
 * `front-end-developer` was 143 rows from that day's fetch plus 97 older ones —
 * and all 97 were `weworkremotely-fullstack`. Himalayas, alphabetically *first*
 * and so collected first, had never been scored by any search in any run; nor had
 * `weworkremotely-devops`. Seven postings were delivered that cycle and all seven
 * were WWR, which looked like a source quality difference and was not.
 *
 * `coalesce` rather than `postedAt` alone because a `sonar` lead has no date —
 * it is a careers page, not an advert. Falling back to `discoveredAt` puts leads
 * at the top of the window, which is right: there are at most
 * `leadsPerSearch × maxSearchesPerRun` of them and each one cost a model call and
 * a page fetch.
 */
export async function listUnscored(searchSlug: string, limit: number): Promise<Job[]> {
  await migrate()
  const rows = await db()
    .select({ job: jobs })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobs.id, jobMatches.jobId))
    .where(and(eq(jobMatches.searchSlug, searchSlug), isNull(jobMatches.scoredAt)))
    // `discoveredAt` stays as the tiebreak. Postings that share a posted date are
    // common on boards that publish at day granularity, and among an exact tie
    // fetch order is arbitrary rather than biased.
    .orderBy(sql`coalesce(${jobs.postedAt}, ${jobs.discoveredAt}) desc`, desc(jobs.discoveredAt))
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

/** Everything the reader has already been shown, in both the forms that identify it. */
export interface DeliveredRecently {
  identities: Set<string>
  /** `advertKey` of each delivered posting. See why below. */
  adverts: Set<string>
}

/**
 * What has been delivered recently enough to suppress a re-send.
 *
 * This is the guard that actually prevents a duplicate, rather than the ratio
 * between the ingest window and retention — see the note on `jobDeliveries` in
 * `schema.ts` for the hole it closes.
 *
 * **The advert set is the second key, and it is what identity alone could not
 * catch.** Two rows for one advert under two spellings of the employer hash to
 * two identities and cleared this guard twice — measured 2026-08-09, see
 * `advertKey`. Same URL under the same title is a one-way proof of sameness, so
 * checking both costs nothing and closes that class.
 *
 * Reads the whole window rather than filtering on a candidate list, because the
 * advert half cannot be an `IN` — the stored URLs and titles have to be
 * normalized in JS before they can be compared. The window is small by
 * construction: at `maxJobsPerDelivery` per search per run it is low hundreds of
 * rows.
 */
export async function recentlyDelivered(): Promise<DeliveredRecently> {
  await migrate()
  const cutoff = Date.now() - jobPipeline.redeliveryGuardDays * 24 * 60 * 60 * 1000
  const rows = await db()
    .select({ identity: jobDeliveries.identity, url: jobDeliveries.url, title: jobDeliveries.title })
    .from(jobDeliveries)
    .where(gte(jobDeliveries.deliveredAt, cutoff))
  return {
    identities: new Set(rows.map(row => row.identity)),
    adverts: new Set(
      rows
        .map(row => advertKey(row.url, row.title))
        .filter((key): key is string => key !== null),
    ),
  }
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
