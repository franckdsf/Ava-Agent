import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { jobPipeline, jobScout } from '../../config/jobs.js'
import { JOOB_TOPICS } from '../../config/joob-topics.js'
import { runNotices } from '../../config/run-notices.js'
import { claimCycle, hoursSince } from '../../db/cycles.js'
import { activeSearches } from '../../db/job-searches.js'
import {
  activeJobSources,
  decayAtsBoards,
  decayUnproductiveSources,
  FILTERED_BEFORE_SCORING,
  type SourceYield,
  finishJobRun,
  insertJobs,
  knownAtsCompanies,
  linkPendingToSearch,
  recordAtsBoards,
  listScoredUndelivered,
  listUnscored,
  markJobDelivered,
  pruneJobs,
  recentlyDelivered,
  recordSourceFetch,
  saveVerdicts,
  startJobRun,
  type DeliveredRecently,
  type JobVerdict,
} from '../../db/jobs.js'
import type { Job, JobSearch, NewJob } from '../../db/schema.js'
import { joobTelegram } from '../../services/joob-telegram.js'
import { fetchJobSource, type RawPosting } from '../../services/job-fetch.js'
import { fetchSonarSource } from '../../services/job-scout.js'
import { cvSkillTags, filterJobs, rankByCvOverlap } from '../../services/job-filter.js'
import {
  advertKey,
  jobId,
  jobIdentity,
  leadId,
  leadIdentity,
} from '../../services/job-identity.js'
import { deriveTags } from '../../services/job-tags.js'
import { fetchPortfolio, PortfolioError } from '../../services/portfolio.js'
import { escapeMarkdown } from '../../services/telegram.js'
import {
  jobSummarySchema,
  renderPostingForScoring,
  scoreBatch,
  writeJobBrief,
} from '../agents/job-scorer.js'

/**
 * The daily job run.
 *
 * ```
 * gate → ingest → fetch CV → per search: filter, score → arbitrate → deliver
 * ```
 *
 * Deterministic except the two model calls, which is what
 * [invariant 2](../../../AGENTS.md#invariants) requires of anything on a
 * schedule: the scorer is a classifier over a row set handed to it, and its
 * answers are validated against that set on the way back.
 *
 * **The schedule fires daily and `jobPipeline.intervalHours` decides whether a
 * firing works.** The gate stays even though the cadence is now daily too: a
 * missed schedule firing on boot has already put two runs in flight at once in
 * this repo. It also keeps the cadence a property of the data, so retuning it is
 * one number here rather than a cron expression that has to encode an interval.
 *
 * **`job_runs.startedAt` was said to make that impossible, and it did not.** The
 * gate read it and inserted the next run several awaits later, so two fires
 * arriving together both read the same answer and both went — the read-then-write
 * shape, one level above the delivery bug of the same kind. The interval is
 * unchanged; what decides is now a single guarded write against
 * `pipeline_cycles` ([ADR-0034](../../../docs/decisions/0034-a-pipeline-claims-its-cycle.md)).
 * `job_runs` stays what it always was underneath: the log, not the lock.
 *
 * **The filter runs before the model and is not an optimisation.** Scoring is one
 * batch call, so cutting the intake is what makes that call *possible*: the
 * unfiltered intake would run to hundreds of thousands of characters before the
 * CV is added.
 */

const runInput = z.object({
  /** Skips the elapsed-time gate. For Studio and for a reader-triggered run. */
  force: z.boolean().optional(),
  searches: z
    .array(z.string())
    .optional()
    .describe('Restrict the run to these search slugs. Omit for every active one.'),
})

/**
 * **Every field carries a default, unlike `curateAll`'s.**
 *
 * A `stateSchema` whose fields have no defaults makes `initialState` mandatory
 * on *every* entry point — Studio fills it in from the schema, so the gap only
 * shows up elsewhere: an HTTP `start-async` with an empty body answers 500
 * listing the fields, and an in-process `run.start()` throws before the first
 * step. That papercut is documented against `curateAll` in AGENTS.md and is
 * simply avoided here. `ingest` overwrites all of it on the first step anyway.
 */
const runState = z.object({
  runId: z.string().default(''),
  skipped: z.boolean().default(false),
  note: z.string().default(''),
  fetched: z.number().default(0),
  stored: z.number().default(0),
  sourceErrors: z.array(z.string()).default([]),
  cv: z.string().default(''),
})

const searchRef = z.object({ searchSlug: z.string() })

const scoredSearch = searchRef.extend({
  considered: z.number(),
  scored: z.number(),
  rejected: z.number(),
  /** Postings dropped as the same advert as something else. See `dedupe`. */
  duplicates: z.number(),
})

const assignedSearch = scoredSearch.extend({ jobIds: z.array(z.string()) })

const deliveredSearch = assignedSearch.extend({
  sent: z.number(),
  sendErrors: z.array(z.string()),
})

const runReport = z.object({
  skipped: z.boolean(),
  note: z.string(),
  fetched: z.number(),
  stored: z.number(),
  considered: z.number(),
  scored: z.number(),
  duplicates: z.number(),
  sent: z.number(),
  sourceErrors: z.array(z.string()),
  sendErrors: z.array(z.string()),
  searches: z.array(deliveredSearch),
})

/**
 * Decides whether this fire does anything, then fetches every source and the CV.
 *
 * One step rather than three because the two later halves are pointless without
 * the first, and a workflow that branches on state is harder to read than one
 * that records "skipped" and lets every later step see an empty list.
 */
const ingest = createStep({
  id: 'ingest',
  inputSchema: runInput,
  outputSchema: z.array(searchRef),
  stateSchema: runState,
  execute: async ({ inputData, setState, mastra }) => {
    const idle = {
      runId: '',
      skipped: true,
      fetched: 0,
      stored: 0,
      sourceErrors: [] as string[],
      cv: '',
    }

    // The gate, taken as a single guarded write rather than a read followed by
    // one. `job_runs` is still the log, but it is no longer what decides: asking
    // it "when did the last run start?" and inserting the answer several awaits
    // later left a window in which two fires arriving together both read
    // yesterday and both went. At boot — where `migrate()` runs on the first
    // query and replayed fires land milliseconds apart — that window is at its
    // widest ([ADR-0034](../../../docs/decisions/0034-a-pipeline-claims-its-cycle.md)).
    //
    // The interval is unchanged. What changed is that only one caller can be
    // told it has elapsed.
    const cycle = await claimCycle('jobs', jobPipeline.intervalHours * 3_600_000, {
      force: inputData.force,
    })
    if (!cycle.claimed) {
      const elapsedHours = hoursSince(cycle.lastStartedAt)
      await setState({
        ...idle,
        note: `Only ${elapsedHours.toFixed(1)}h since the last run; the interval is ${jobPipeline.intervalHours}h.`,
      })
      return []
    }

    const searches = await activeSearches()
    const wanted = inputData.searches
      ? searches.filter(search => inputData.searches?.includes(search.slug))
      : searches
    if (wanted.length === 0) {
      await setState({ ...idle, note: 'Nothing to look for — no active searches. Use /target.' })
      return []
    }

    const runId = await startJobRun()

    // The CV. A failure here stops the run rather than scoring against nothing:
    // unscored postings simply wait, and the next run picks them all up. It is
    // reported loudly, because silence is indistinguishable from "no matches".
    let cv: string
    try {
      const portfolio = await fetchPortfolio()
      cv = portfolio.markdown
      if (portfolio.truncated) {
        // Not fatal, but it means the tail of the CV is not being read at all.
        await joobTelegram
          .sendToTelegram(
            `Heads up — your portfolio is ${portfolio.chars.toLocaleString('en-US')} characters and I only read the first part of it. Worth trimming, or raising the cap.`,
            'chat',
          )
          .catch(() => {})
      }
    } catch (error) {
      const message = error instanceof PortfolioError ? error.message : String(error)
      await finishJobRun(runId, { note: `portfolio: ${message}` })
      await joobTelegram
        .sendToTelegram(
          [
            `I couldn't read your CV, so I've skipped this run rather than guess.`,
            escapeMarkdown(message),
            `Nothing is lost — the postings I found are waiting, and the next run will score them all.`,
          ].join('\n\n'),
          'chat',
        )
        .catch(() => {})
      await setState({ ...idle, runId, note: `portfolio unreadable: ${message}` })
      return []
    }

    const sources = await activeJobSources()

    // Announced after the CV, never before it. The two paths above return early
    // with a message of their own — "I couldn't read your CV, so I've skipped
    // this run" is a complete report, and a "looking for jobs now" in front of it
    // would only contradict it. From here on the run really is happening, and it
    // is about to spend minutes: the sonar leg is a model call plus a page fetch
    // per lead, which is exactly the silence this notice covers.
    mastra
      .getLogger()
      ?.info('Job run started', { runId, sources: sources.length, searches: wanted.length })
    if (runNotices.jobs.start) {
      await joobTelegram
        .sendToTelegram(renderJobsStart(sources.length, wanted.length), 'chat')
        .catch(() => {})
    }

    const postings: NewJob[] = []
    const sourceErrors: string[] = []
    let fetched = 0

    const cutoff = Date.now() - jobPipeline.ingestWindowDays * 24 * 60 * 60 * 1000

    /**
     * When this run first saw everything it is about to store — **one timestamp
     * for the whole run**, not one per posting.
     *
     * `Date.now()` inside the loop below encoded something that is not
     * information: sources are fetched in batches of `sourceConcurrency` in `id`
     * order, so the millisecond a posting was stamped with was its source's
     * position in the fetch, and `listUnscored` then ordered the scoring queue by
     * it. Two sources were never scored at all as a result — see the note there.
     *
     * It also strengthens what `postingMonth` already wanted. That function falls
     * back to first-seen rather than `now()` so one advert crawled either side of
     * midnight on the 31st is not two jobs; a run-level stamp makes that true for
     * a whole run rather than for whichever postings landed on the same side.
     */
    const firstSeenAt = Date.now()

    /**
     * One fetch result folded into the rows to insert.
     *
     * `identify` differs by source kind and that is the whole reason this takes a
     * function: a board posting is keyed on company + title + location, while a
     * sonar lead is keyed on company + careers page because its title is a
     * model's phrasing and is not stable between runs. See `job-identity.ts`.
     */
    const collect = (
      result: { sourceId: string; postings: RawPosting[] },
      identify: (posting: RawPosting) => { id: string; identity: string },
    ) => {
      fetched += result.postings.length
      for (const posting of result.postings) {
        // The ingest window. A posting older than this is refused on age, which
        // is the first of the two guards against a pruned posting returning —
        // `job_deliveries` is the second and the one that actually holds.
        if (posting.postedAt !== null && posting.postedAt < cutoff) continue

        postings.push({
          ...identify(posting),
          sourceId: result.sourceId,
          company: posting.company,
          title: posting.title,
          location: posting.location,
          remote: posting.remote,
          url: posting.url,
          description: posting.description,
          salaryText: posting.salaryText,
          contractType: posting.contractType,
          tags: posting.tags,
          derivedTags: deriveTags(posting),
          // Null for a board's advert, a count for a sonar lead. See the column.
          listedRoles: posting.listedRoles ?? null,
          postedAt: posting.postedAt,
          discoveredAt: firstSeenAt,
        })
      }
    }

    const identifyPosting = (posting: RawPosting) => {
      const input = {
        company: posting.company,
        title: posting.title,
        location: posting.location,
        remote: posting.remote === 'remote',
        postedAt: posting.postedAt,
        firstSeenAt,
      }
      return { id: jobId(input), identity: jobIdentity(input) }
    }

    const identifyLead = (posting: RawPosting) => {
      const input = { careersUrl: posting.url, firstSeenAt }
      return { id: leadId(input), identity: leadIdentity(input) }
    }

    // Boards, in parallel batches. One dead board must not take down the run.
    const boards = sources.filter(source => source.kind !== 'sonar')
    for (let index = 0; index < boards.length; index += jobPipeline.sourceConcurrency) {
      const batch = boards.slice(index, index + jobPipeline.sourceConcurrency)
      const results = await Promise.all(batch.map(source => fetchJobSource(source)))

      for (const result of results) {
        await recordSourceFetch(result.sourceId, {
          status: result.status,
          error: result.error,
          etag: result.etag,
          lastModified: result.lastModified,
          count: result.postings.length,
        })
        if (result.error) sourceErrors.push(`${result.sourceId}: ${result.error}`)
        collect(result, identifyPosting)
      }
    }

    // Sonar, after the boards and never inside their batch. It is a model call
    // plus a page fetch per lead — minutes, against a board's seconds — and
    // putting it in a `Promise.all` with three boards would hold their results
    // behind it for no gain. It also needs what no board needs: the searches, so
    // it can ask about each one, and a `mastra` handle. Its failure is contained
    // inside `fetchSonarSource`, so a bad run costs its own leads and nothing else.
    for (const source of sources.filter(source => source.kind === 'sonar')) {
      const result = await fetchSonarSource(source, mastra, wanted, await knownAtsCompanies())
      await recordSourceFetch(result.sourceId, {
        status: result.status,
        error: result.error,
        count: result.postings.length,
      })
      // **The pipeline's one compounding step.** Every employer whose board was
      // verified this run becomes a source row, polled from the next run onward
      // with no model call and no page resolution behind it. Written before the
      // postings are stored so a crash in `insertJobs` still leaves the boards
      // behind — re-finding them costs a whole sonar cycle.
      await recordAtsBoards(result.boards ?? []).catch(() => 0)
      if (result.error) sourceErrors.push(`${result.sourceId}: ${result.error}`)
      // **This source alone emits both kinds.** A lead is a company plus a
      // careers page and is keyed on that URL; a posting expanded off the
      // employer's ATS board is a real advert and is keyed like any board's. One
      // identity function for the whole result would collapse a 40-role board
      // into a single row — see `keyedAs` on `RawPosting`.
      collect(result, posting =>
        posting.keyedAs === 'lead' ? identifyLead(posting) : identifyPosting(posting),
      )
    }

    // The primary key collapses the same role seen on several boards.
    const stored = await insertJobs(postings)

    await setState({ runId, skipped: false, note: '', fetched, stored, sourceErrors, cv })
    return wanted.map(search => ({ searchSlug: search.slug }))
  },
})

/** One search's filter and one batch scoring call. */
const scoreSearch = createStep({
  id: 'score-search',
  inputSchema: searchRef,
  outputSchema: scoredSearch,
  stateSchema: runState,
  execute: async ({ inputData, state, mastra }) => {
    const idle = { ...inputData, considered: 0, scored: 0, rejected: 0, duplicates: 0 }
    const searches = await activeSearches()
    const search = searches.find(entry => entry.slug === inputData.searchSlug)
    if (!search || !state.cv) return idle

    // Link first, then read. `listUnscored` goes through `job_matches`, so
    // without this a search sees nothing however many postings are stored — the
    // first live run fetched 383, considered 0 and finished in three seconds
    // looking exactly like a healthy pipeline with nothing to report.
    await linkPendingToSearch(search.slug)

    const pending = await listUnscored(search.slug, jobPipeline.maxJobsPerScoringRun * 4)
    if (pending.length === 0) return idle

    const { kept, rejected, tags } = filterJobs(pending, search)
    const rejectedCount = [...rejected.values()].reduce((total, count) => total + count, 0)

    const { unique, duplicates } = dedupe(kept, await recentlyDelivered())

    // Everything the filter rejected or the dedupe dropped is settled at zero
    // rather than left pending, so it never re-enters a later batch. The reason is
    // kept — it is what makes "why didn't I see that?" answerable for a posting no
    // model ever read.
    const survived = new Set(unique.map(job => job.id))
    const settled: JobVerdict[] = []
    for (const job of pending) {
      if (survived.has(job.id)) continue
      settled.push({
        jobId: job.id,
        fit: 0,
        reason: duplicates.get(job.id) ?? FILTERED_BEFORE_SCORING,
        mismatches: [],
      })
    }

    // Ordered by how much of the reader's own stack a posting mentions, so the
    // capped batch is spent on the plausible ones rather than on whatever the
    // boards happened to publish most recently. This is the **only** place the
    // CV touches the deterministic path, and it can only reorder: a posting that
    // misses the cap is scored on a later run, where one wrongly filtered is
    // gone for good.
    const batch = rankByCvOverlap(unique, cvSkillTags(state.cv), tags).slice(
      0,
      jobPipeline.maxJobsPerScoringRun,
    )
    if (batch.length === 0) {
      await saveVerdicts(search.slug, settled)
      return { ...idle, rejected: rejectedCount, duplicates: duplicates.size }
    }

    // Retried inside `scoreBatch`, and an empty result means every attempt
    // failed. The filtered-out postings are still settled below, but nothing in
    // the batch is written — they stay unscored so the next run tries again.
    // "The model failed" and "none of these are any good" must not be the same
    // value.
    const returned = await scoreBatch(
      mastra,
      [
        '## The person',
        state.cv,
        '',
        '## What they are looking for right now',
        renderSearchForScoring(search),
        '',
        `## Postings to judge (${batch.length})`,
        batch.map(renderPostingForScoring).join('\n\n---\n\n'),
      ].join('\n'),
      new Set(batch.map(job => job.id)),
    )
    const answered = new Set(returned.map(verdict => verdict.id))

    const verdicts: JobVerdict[] = returned.map(verdict => ({
      jobId: verdict.id,
      fit: verdict.fit,
      reason: verdict.reason,
      mismatches: verdict.mismatches,
    }))

    // Anything in the batch the model silently dropped. Left pending rather than
    // settled at zero: it was never judged, and the next run should try again.
    const missed = batch.filter(job => !answered.has(job.id)).length

    await saveVerdicts(search.slug, [...verdicts, ...settled])
    return {
      ...inputData,
      considered: batch.length - missed,
      scored: verdicts.length,
      rejected: rejectedCount,
      duplicates: duplicates.size,
    }
  },
})

/**
 * Drops every posting that is the same advert as one the reader already has, or
 * as another posting in this same batch.
 *
 * **Before the scorer, and that placement is the whole point.** The ledger check
 * in `assignBest` already stopped a repeat *reaching* the reader, but it ran
 * after the model had read it: a duplicate still consumed one of
 * `maxJobsPerScoringRun` slots, which is the scarcest thing in this pipeline —
 * a live search saturated that cap exactly, and the postings pushed out of the
 * batch wait a whole run. Paying a model to judge a posting twice and then
 * discarding the second answer is the thing this exists to stop.
 *
 * **Two keys, because identity alone let a pair through — measured 2026-08-09.**
 * `sonar` found `3Pillar Global` and its Lever board; from the next run that board
 * was polled directly, and Lever publishes no company name, so the same advert
 * was stored twice under two spellings that hash differently. Both were sent, in
 * the same second. `job-fetch.ts` now files an ATS board's postings under its
 * source label so the identities agree — this is the guard for the next provider
 * that disagrees about a name, and it is where a *cross-month* repeat of one
 * identity is caught too.
 *
 * Returns the survivors in their incoming order, so `listUnscored`'s "newest
 * posted date first" still decides which copy of a pair is the one kept.
 */
function dedupe(kept: Job[], seen: DeliveredRecently): {
  unique: Job[]
  /** Job id → the reason it was dropped, written onto its settled verdict. */
  duplicates: Map<string, string>
} {
  const unique: Job[] = []
  const duplicates = new Map<string, string>()
  const identities = new Set<string>()
  const adverts = new Set<string>()

  for (const job of kept) {
    // Null means the title carries nothing this key can use, so the advert half
    // does not apply to this row and identity decides alone. See `advertKey`.
    const advert = advertKey(job.url, job.title)
    if (seen.identities.has(job.identity) || (advert !== null && seen.adverts.has(advert))) {
      duplicates.set(job.id, 'Already sent — the reader has seen this advert.')
      continue
    }
    if (identities.has(job.identity) || (advert !== null && adverts.has(advert))) {
      duplicates.set(job.id, 'The same advert as another posting in this batch.')
      continue
    }
    identities.add(job.identity)
    if (advert !== null) adverts.add(advert)
    unique.push(job)
  }

  return { unique, duplicates }
}

function renderSearchForScoring(search: JobSearch): string {
  const list = (values: string[]) => (values.length > 0 ? values.join(', ') : 'no preference stated')
  return [
    `title: ${search.label}`,
    `in their own words: ${search.request}`,
    `locations: ${list(search.locations)}`,
    `remote: ${search.remote}`,
    `seniority: ${list(search.seniority)}`,
    `contract: ${list(search.contractTypes)}`,
    `must involve: ${list(search.mustHave)}`,
    `ruled out: ${list(search.dealbreakers)}`,
    search.minCompensation
      ? `pay floor: ${search.minCompensation.toLocaleString('en-US')} ${search.currency ?? ''}`.trim()
      : 'pay floor: none stated',
    search.notes ? `other: ${search.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Decides which search sends each posting, and drops anything already seen.
 *
 * The one global step, and the reason scoring and delivery are two fan-outs: a
 * posting can be wanted by several searches and no single search's run can know
 * it lost. Same shape as the news pipeline's arbiter.
 *
 * The ledger check happens **here**, not at delivery, so a posting suppressed as
 * a repeat does not consume a search's per-run cap.
 */
const assignBest = createStep({
  id: 'assign-best',
  inputSchema: z.array(scoredSearch),
  outputSchema: z.array(assignedSearch),
  execute: async ({ inputData }) => {
    if (inputData.length === 0) return []

    const slugs = inputData.map(entry => entry.searchSlug)
    const searches = await activeSearches()
    const thresholds = new Map(
      searches.map(search => [search.slug, search.fitThreshold ?? jobPipeline.defaultFitThreshold]),
    )
    const floor = Math.min(...[...thresholds.values()], jobPipeline.defaultFitThreshold)

    const candidates = await listScoredUndelivered(slugs, floor)
    if (candidates.length === 0) return inputData.map(entry => ({ ...entry, jobIds: [] }))

    // Everything the reader has already been shown, whichever search sent it.
    const seen = await recentlyDelivered()

    /**
     * Adverts already claimed by a winner in *this* run, by both keys.
     *
     * `dedupe` runs per search and so cannot see across them: two searches each
     * scoring one row of a duplicated pair both reach here with a row nothing has
     * suppressed. That is not hypothetical — the 2026-08-09 pair was delivered in
     * the same second, and this is the point at which one of them has to lose.
     * Candidates arrive fit-descending, so the copy that survives is the better
     * scored one.
     */
    const claimed = { identities: new Set<string>(), adverts: new Set<string>() }

    const wonBy = new Map<string, string>()
    for (const candidate of candidates) {
      // Candidates arrive fit-descending, so the first verdict seen for a job is
      // its best one and later ones are skipped. Checked before the claims below,
      // or a job's own claim would read as a duplicate of itself.
      if (wonBy.has(candidate.job.id)) continue
      const { identity } = candidate.job
      const advert = advertKey(candidate.job.url, candidate.job.title)
      const dupOf = (set: { identities: Set<string>; adverts: Set<string> }) =>
        set.identities.has(identity) || (advert !== null && set.adverts.has(advert))
      if (dupOf(seen) || dupOf(claimed)) continue
      const threshold = thresholds.get(candidate.searchSlug)
      if (threshold === undefined || candidate.fit < threshold) continue
      claimed.identities.add(identity)
      if (advert !== null) claimed.adverts.add(advert)
      wonBy.set(candidate.job.id, candidate.searchSlug)
    }

    const bySearch = new Map<string, string[]>()
    for (const [id, slug] of wonBy) {
      const existing = bySearch.get(slug)
      if (existing) existing.push(id)
      else bySearch.set(slug, [id])
    }

    return inputData.map(entry => ({
      ...entry,
      jobIds: (bySearch.get(entry.searchSlug) ?? []).slice(0, jobPipeline.maxJobsPerDelivery),
    }))
  },
})

/** Writes and sends the postings one search won. */
const deliverSearch = createStep({
  id: 'deliver-search',
  inputSchema: assignedSearch,
  outputSchema: deliveredSearch,
  execute: async ({ inputData, mastra }) => {
    if (inputData.jobIds.length === 0) return { ...inputData, sent: 0, sendErrors: [] }

    const searches = await activeSearches()
    const search = searches.find(entry => entry.slug === inputData.searchSlug)
    if (!search) return { ...inputData, sent: 0, sendErrors: ['search disappeared mid-run'] }

    const threshold = search.fitThreshold ?? jobPipeline.defaultFitThreshold
    const candidates = await listScoredUndelivered([search.slug], threshold)
    const wanted = new Set(inputData.jobIds)
    const winners = candidates.filter(candidate => wanted.has(candidate.job.id))

    const messages = await Promise.all(
      winners.map(async winner => {
        const written = await writeJobBrief(
          mastra,
          [
            `search: ${search.label}`,
            `fit: ${winner.fit}/100`,
            `why it scored that: ${winner.reason ?? '—'}`,
            `mismatches found: ${(winner.mismatches ?? []).join('; ') || 'none'}`,
            '',
            renderPostingForScoring(winner.job),
          ].join('\n'),
        )

        // Retried inside `writeJobBrief`; null means every attempt failed. The
        // scorer already decided this posting is worth sending and wrote a
        // reason and a mismatch list on the way, so a writer failure degrades to
        // *that* rather than losing the posting entirely.
        const summary = written ?? {
          summary: winner.reason ?? `Matched "${search.label}".`,
          fits: [],
          watchOuts: winner.mismatches ?? [],
        }

        return { job: winner.job, text: renderJobMessage(winner.job, search, winner.fit, summary) }
      }),
    )

    let sent = 0
    const sendErrors: string[] = []
    for (const message of messages) {
      try {
        await joobTelegram.sendToTelegram(message.text, 'jobs')
        // Marks the posting *and* writes its permanent ledger row. Both, because
        // a posting that reached the reader without a ledger row can be re-sent.
        await markJobDelivered(message.job, search.slug)
        sent += 1
      } catch (error) {
        sendErrors.push(
          `${message.job.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    return { ...inputData, sent, sendErrors }
  },
})

/**
 * One posting as a Telegram message.
 *
 * Structure from the template and prose from the model, for the reason the news
 * digest does it that way: a model asked to emit its own markdown eventually
 * emits a broken link, and the URL is the one part that must be exactly right.
 *
 * Blank lines between blocks, never single newlines — a single newline is a soft
 * wrap and collapses two blocks into one run-on line.
 */
export function renderJobMessage(
  job: Job,
  search: JobSearch,
  fit: number,
  summary: z.infer<typeof jobSummarySchema>,
): string {
  const clean = (values: string[]) => values.map(value => value.trim()).filter(Boolean)
  const fits = clean(summary.fits)
  const watchOuts = clean(summary.watchOuts)

  const footer = [job.company, job.location ?? undefined, search.label, `fit ${fit}`]
    .filter((value): value is string => Boolean(value))
    .map(escapeMarkdown)
    .join(' · ')

  return [
    `## 💼 [${escapeMarkdown(job.title)}](${job.url})`,
    '',
    summary.summary.trim(),
    ...(fits.length > 0 ? ['', '**Fits**', ...fits.map(fit => `- ${escapeMarkdown(fit)}`)] : []),
    ...(watchOuts.length > 0
      ? ['', '**Worth knowing**', ...watchOuts.map(item => `- ${escapeMarkdown(item)}`)]
      : []),
    '',
    `_${footer}_`,
  ].join('\n')
}

/** Folds the per-search results together and closes the run row. */
const report = createStep({
  id: 'report',
  inputSchema: z.array(deliveredSearch),
  outputSchema: runReport,
  stateSchema: runState,
  execute: async ({ inputData, state, mastra }) => {
    const totals = {
      considered: inputData.reduce((sum, entry) => sum + entry.considered, 0),
      scored: inputData.reduce((sum, entry) => sum + entry.scored, 0),
      duplicates: inputData.reduce((sum, entry) => sum + entry.duplicates, 0),
      sent: inputData.reduce((sum, entry) => sum + entry.sent, 0),
    }

    // Retention runs here rather than on a cron of its own: it is bookkeeping for
    // this pipeline and nothing else reads these rows, so a second schedule would
    // only be a second thing to forget. Its failure must not lose the run's
    // counters, hence the catch — a table one cycle too large costs nothing.
    if (!state.skipped) {
      await pruneJobs().catch(() => 0)
      // Beside the prune and for the same reason: bookkeeping this pipeline owns,
      // where a second schedule would only be a second thing to forget. This is
      // the counterweight to `recordAtsBoards` above — without it the table this
      // run adds to only ever grows. Its failure must not lose the run's counters.
      await decayAtsBoards().catch(() => ({ idled: 0, forgotten: 0 }))

      // And the other half of the same job: a board that is loud rather than
      // silent, costing scoring slots and returning nothing the reader wants.
      // Reported rather than swallowed — `decayAtsBoards` idles a board nobody
      // chose, but this can switch off a *seeded* source the reader is expecting
      // to hear from, and a source disappearing with no explanation is the kind
      // of silence this pipeline's notices exist to prevent.
      const unproductive = await decayUnproductiveSources().catch(() => [])
      if (unproductive.length > 0) {
        await joobTelegram
          .sendToTelegram(renderUnproductiveSources(unproductive), 'chat')
          .catch(() => {})
      }
    }

    if (state.runId) {
      await finishJobRun(state.runId, {
        fetched: state.fetched,
        stored: state.stored,
        considered: totals.considered,
        scored: totals.scored,
        delivered: totals.sent,
        note: state.note || undefined,
      })
    }

    const summary = {
      skipped: state.skipped,
      note: state.note,
      fetched: state.fetched,
      stored: state.stored,
      sourceErrors: state.sourceErrors,
      sendErrors: inputData.flatMap(entry => entry.sendErrors),
      searches: inputData,
      ...totals,
    }

    mastra.getLogger()?.info(state.skipped ? 'Job run skipped' : 'Job run finished', {
      note: state.note || undefined,
      fetched: summary.fetched,
      stored: summary.stored,
      considered: summary.considered,
      scored: summary.scored,
      duplicates: summary.duplicates,
      sent: summary.sent,
      sourceErrors: summary.sourceErrors.length,
      sendErrors: summary.sendErrors.length,
    })

    // In Chat rather than in the Jobs tab — a quiet week and a broken pipeline
    // look identical otherwise, and that is exactly the question the counters
    // exist to answer. A gated firing says nothing: it did no work, `state.note`
    // records why, and a message for it would be a message most days.
    if (!state.skipped && runNotices.jobs.finish) {
      await joobTelegram.sendToTelegram(renderJobsFinish(summary), 'chat').catch(() => {})
    }

    return summary
  },
})

/* ────────────────────────────────── notices ────────────────────────────────── */

/**
 * "I'm looking for jobs now."
 *
 * Exported unsent for the reason every rendered message in this repo is: it is
 * pure, and a block structure that collapses into one run-on line is invisible
 * in code and obvious through `adapter.formatConverter.toAst()`.
 */
export function renderJobsStart(sources: number, searches: number): string {
  return (
    `💼 **Looking for jobs now** — ${sources} source${sources === 1 ? '' : 's'} ` +
    `for ${searches} search${searches === 1 ? '' : 'es'}.`
  )
}

/**
 * What the run came to.
 *
 * **This is also the "nothing worth sending" report**, which used to be its own
 * message sent only when nothing cleared the bar. Folding them is the point: a
 * run that delivered nothing and a run that delivered eight are the same event,
 * and two mechanisms reporting one event is how a quiet run gets announced
 * twice. The zero case keeps its old wording and its `/targets` hint, because
 * that hint is the useful half of it — the counters say the pipeline is healthy,
 * and the hint says where to look if it keeps saying so.
 *
 * Source errors are named here and nowhere else. They have been collected per
 * run since the pipeline was written and reported only into a Studio run graph,
 * so a board that has been 403ing for a fortnight looked exactly like a board
 * with no vacancies.
 */
export function renderJobsFinish(report: z.infer<typeof runReport>): string {
  // Named, because a run that judged 12 of 90 looks like a thin week and may
  // instead be one board arriving twice under two names — which is exactly how
  // the duplicate this counter was added for went unnoticed for three days.
  const repeats =
    report.duplicates > 0
      ? ` Set aside ${report.duplicates} I'd already found elsewhere.`
      : ''

  const blocks: string[] =
    report.sent === 0
      ? [
          `💼 **Nothing new worth sending this time.**`,
          `I read ${report.fetched} posting${report.fetched === 1 ? '' : 's'}, ` +
            `${report.stored} of them new, and looked closely at ${report.considered}. ` +
            `None cleared the bar.` +
            repeats,
          `If that keeps happening, \`/targets\` shows what I'm filtering on.`,
        ]
      : [
          `💼 **Job run done** — read ${report.fetched} posting${report.fetched === 1 ? '' : 's'}, ` +
            `${report.stored} new, judged ${report.considered}, ` +
            `sent ${report.sent}.` +
            repeats,
        ]

  const problems = [...report.sourceErrors, ...report.sendErrors]
  if (problems.length > 0) {
    const shown = problems.slice(0, runNotices.maxErrorsShown)
    const rest = problems.length - shown.length
    // Two blocks, not one: a heading and its list separated by a single newline
    // is a soft wrap and renders as one run-on line. The bullets themselves are
    // single-newline separated, which is what makes them a list.
    blocks.push(
      `**${problems.length} problem${problems.length === 1 ? '' : 's'}:**`,
      [
        ...shown.map(problem => `- ${escapeMarkdown(problem)}`),
        ...(rest > 0 ? [`- …and ${rest} more.`] : []),
      ].join('\n'),
    )
  }

  return blocks.join('\n\n')
}

export const findJobs = createWorkflow({
  id: 'find-jobs',
  inputSchema: runInput,
  outputSchema: runReport,
  stateSchema: runState,
  // Daily, gated by `job_runs.startedAt` — see the note at the head of this file
  // for why the cron does not express the cadence itself.
  schedule: [
    {
      id: 'jobs-daily',
      cron: `0 ${jobPipeline.runHour} * * *`,
      timezone: env.AGENT_TIMEZONE,
      inputData: {},
    },
  ],
})
  .then(ingest)
  .foreach(scoreSearch)
  .then(assignBest)
  .foreach(deliverSearch)
  .then(report)
  .commit()

/** Named for the tab its output lands in, so a reader of `index.ts` can tell. */
export const JOB_DELIVERY_TAB = JOOB_TOPICS.jobs.slug

/**
 * "I've stopped reading these boards, and here's the evidence."
 *
 * **A report, not a courtesy, and the reason it exists is asymmetry with
 * `decayAtsBoards`.** An idled ATS board was discovered by a scout the reader
 * never saw pick it; nobody is waiting to hear from it, so it is switched off in
 * silence. A source archived here may be one of the nine seeded boards the
 * reader chose by hand, and a board they chose going quiet with no explanation
 * is indistinguishable from the pipeline breaking — which is precisely the
 * failure Remote OK produced for two runs.
 *
 * The numbers are shown rather than summarised because they are the argument. A
 * reader who disagrees needs to see the sample size to disagree usefully, and
 * re-adding a source is one `/target`-shaped decision they are entitled to make
 * against the evidence rather than against a verdict.
 */
export function renderUnproductiveSources(dropped: readonly SourceYield[]): string {
  const bar = Math.round(jobScout.minYieldRate * 100)
  return [
    `🧹 **Switched off ${dropped.length} source${dropped.length === 1 ? '' : 's'}** — ` +
      `${dropped.length === 1 ? 'it was' : "they were"} costing me scoring slots and returning nothing you'd want.`,
    dropped
      .map(
        entry =>
          `- **${escapeMarkdown(entry.label)}** (\`${entry.sourceId}\`) — ` +
          `${entry.cleared} of ${entry.scored} judged postings cleared your bar ` +
          `(${((entry.rate ?? 0) * 100).toFixed(1)}%, and I need ${bar}%).`,
      )
      .join('\n'),
    `Nothing already found is lost. If you want one back, say so and I'll re-add it — ` +
      `and retargeting a search resets every source's record, since the bar it was measured against has moved.`,
  ].join('\n\n')
}
