import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'
import { jobPipeline, jobScout } from '../config/jobs.js'
import { SEED_JOB_SOURCES } from '../config/seed-job-sources.js'
import { advertKey } from '../services/job-identity.js'
import { db, migrate } from './client.js'
// `job-searches.ts` reaches only for the client and the schema, so this cannot
// cycle back — the dependency runs one way, repository to repository.
import { activeSearches } from './job-searches.js'
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

/**
 * Every source worth fetching for the searches currently running.
 *
 * **Two reasons a row is skipped, and they are not the same thing.** Archived is
 * permanent and is a judgement about the *source* — it died, or it produced
 * nothing worth reading. The domain check is temporary and is a judgement about
 * the *fit between this source and today's searches*: a software-only board is
 * skipped while every active search is chemistry, and comes back the moment a
 * software search does, with no row edited either way.
 *
 * That asymmetry is why this is computed per run rather than stored. A reader
 * who retargets from software to chemistry and back would otherwise need every
 * board un-archived by hand, and the archive would stop meaning "this source is
 * bad" — which is the thing `decayAtsBoards` and `yieldOfSources` both rely on
 * it meaning.
 *
 * **A null `domain` always survives**, because null means the board carries
 * every field rather than an unknown one — see the column's note in `schema.ts`.
 * So does every row when no search names a domain at all: an older search row
 * with a null domain must not silently switch off half the table, which is the
 * same bias toward keeping that `filterJob` follows throughout.
 */
export async function activeJobSources(): Promise<JobSource[]> {
  await migrate()
  const rows = await db()
    .select()
    .from(jobSources)
    .where(isNull(jobSources.archivedAt))
    .orderBy(asc(jobSources.id))

  const wanted = new Set(
    (await activeSearches()).map(search => search.domain).filter((d): d is string => Boolean(d)),
  )
  if (wanted.size === 0) return rows
  return rows.filter(row => !row.domain || wanted.has(row.domain))
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
 * The verdict stored for a posting the deterministic filter or the dedupe threw
 * out, so no model ever read it.
 *
 * A constant rather than a literal because two places have to agree on it and
 * they are in different files: `scoreSearch` writes it, and `yieldOfSources`
 * excludes it so a source is judged on the slots it *spent* rather than on the
 * ones it was refused. A typo in either would not fail — it would quietly change
 * which sources get archived.
 */
export const FILTERED_BEFORE_SCORING = 'Filtered out before scoring.'

/** One source's record against the reader's current bar. */
export interface SourceYield {
  sourceId: string
  label: string
  /** Postings a model actually read. Pre-filtered ones are excluded — see below. */
  scored: number
  /** Of those, how many cleared their own search's delivery threshold. */
  cleared: number
  /** `cleared / scored`, or null when the sample is too small to mean anything. */
  rate: number | null
}

/**
 * When each source's record starts counting.
 *
 * The latest criteria change across the active searches — retarget one and every
 * source's history restarts, not just the boards that search happened to touch.
 * Blunt on purpose: sources are shared by every search, so "which boards did
 * this search's change invalidate?" has no honest answer short of all of them.
 * Erring toward a longer amnesty is the safe direction, because the cost of
 * waiting is a few cheap requests and the cost of being wrong is a good board
 * switched off.
 */
async function yieldWindowStart(): Promise<number> {
  const searches = await activeSearches()
  return searches.reduce((latest, search) => Math.max(latest, search.criteriaChangedAt ?? 0), 0)
}

/**
 * What each active source has produced since the reader last changed what they
 * want.
 *
 * **Counted over postings a model actually read, not over postings fetched.** A
 * source that returns a thousand adverts the deterministic filter rejects has
 * cost almost nothing — one HTTP request and some regex — and judging it on that
 * volume would archive a broad board that also carries good roles. What is
 * scarce is `maxJobsPerScoringRun`, so the denominator is slots consumed, and
 * this measures the only thing the pipeline actually spends.
 *
 * Exported so `pnpm jobs:check` can print the table the archiving decision is
 * made from. A rule that silently switches sources off needs its evidence
 * readable *before* it fires, which is the lesson `verdictForBeat` and
 * `pnpm review:check` already record on the news side.
 */
export async function yieldOfSources(): Promise<SourceYield[]> {
  await migrate()
  const since = await yieldWindowStart()
  const searches = await activeSearches()
  const bar = new Map(
    searches.map(search => [
      search.slug,
      search.fitThreshold ?? jobPipeline.defaultFitThreshold,
    ]),
  )
  if (bar.size === 0) return []

  const rows = await db()
    .select({
      sourceId: jobs.sourceId,
      label: jobSources.label,
      searchSlug: jobMatches.searchSlug,
      fit: jobMatches.fit,
    })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobs.id, jobMatches.jobId))
    .innerJoin(jobSources, eq(jobSources.id, jobs.sourceId))
    .where(
      and(
        isNull(jobSources.archivedAt),
        isNotNull(jobMatches.fit),
        gte(jobMatches.scoredAt, since),
        // The verdict `saveVerdicts` writes for a posting no model ever read.
        // Including these would make the denominator "postings we declined to
        // pay for", which is the opposite of what this measures.
        ne(jobMatches.reason, FILTERED_BEFORE_SCORING),
        inArray(jobMatches.searchSlug, [...bar.keys()]),
      ),
    )

  const tally = new Map<string, SourceYield>()
  for (const row of rows) {
    const entry = tally.get(row.sourceId) ?? {
      sourceId: row.sourceId,
      label: row.label,
      scored: 0,
      cleared: 0,
      rate: null,
    }
    entry.scored += 1
    if ((row.fit ?? 0) >= (bar.get(row.searchSlug) ?? jobPipeline.defaultFitThreshold)) {
      entry.cleared += 1
    }
    tally.set(row.sourceId, entry)
  }

  return [...tally.values()]
    .map(entry => ({
      ...entry,
      rate: entry.scored >= jobScout.minYieldSample ? entry.cleared / entry.scored : null,
    }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1))
}

/**
 * Switches off sources that keep costing scoring slots and returning nothing.
 *
 * **The gap `decayAtsBoards` leaves open, and the larger of the two.** That
 * mechanism recognises a *silent* board. This one recognises a *loud and useless*
 * one, which is the failure mode that actually cost this pipeline: Remote OK
 * served 100 entries of scraped page furniture and looked perfectly healthy for
 * two runs, and jobicy spent a third of every scoring window for a year's worth
 * of nothing. Neither was ever quiet, so neither was ever a candidate for
 * `emptySince`.
 *
 * Marked `unproductive` rather than `idle`, and the distinction matters for the
 * same reason `idle` matters: `decayAtsBoards` deletes an `idle` row after
 * `atsForgetDays` so the employer becomes discoverable again. A board switched
 * off here must **not** be swept up by that — being bad at serving this reader is
 * not a fact with a shelf life the way "not hiring" is, and re-discovering jobicy
 * in four months to re-learn the same lesson is exactly the loop that rule exists
 * to prevent. A different status keeps it out of that DELETE.
 *
 * Applies to every kind, not just `ats`. A seeded board is not privileged here —
 * the seed is nine rows a human chose once, and three of them are measurably the
 * problem. The reader can always re-add one; `setSourceArchived` is one call.
 */
export async function decayUnproductiveSources(): Promise<SourceYield[]> {
  await migrate()
  const doomed = (await yieldOfSources()).filter(
    entry => entry.rate !== null && entry.rate < jobScout.minYieldRate,
  )
  if (doomed.length === 0) return []

  await db()
    .update(jobSources)
    .set({ archivedAt: Date.now(), lastStatus: 'unproductive' })
    .where(
      and(
        isNull(jobSources.archivedAt),
        inArray(
          jobSources.id,
          doomed.map(entry => entry.sourceId),
        ),
      ),
    )
  return doomed
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
