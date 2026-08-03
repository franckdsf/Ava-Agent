import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { jobPipeline } from '../../config/jobs.js'
import { JOOB_TOPICS } from '../../config/joob-topics.js'
import { activeSearches } from '../../db/job-searches.js'
import {
  activeJobSources,
  finishJobRun,
  insertJobs,
  lastRunStartedAt,
  linkPendingToSearch,
  listScoredUndelivered,
  listUnscored,
  markJobDelivered,
  pruneJobs,
  recentlyDelivered,
  recordSourceFetch,
  saveVerdicts,
  startJobRun,
  type JobVerdict,
} from '../../db/jobs.js'
import type { Job, JobSearch, NewJob } from '../../db/schema.js'
import { joobTelegram } from '../../services/joob-telegram.js'
import { fetchJobSource } from '../../services/job-fetch.js'
import { cvTechTags, filterJobs, rankByCvOverlap } from '../../services/job-filter.js'
import { jobId, jobIdentity } from '../../services/job-identity.js'
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
 * The every-two-days job run.
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
 * **The schedule fires daily and the gate makes it every two days.** A
 * day-of-month cron step is not "every two days" — it fires on the 1st, 3rd …
 * 31st and then the 1st again — and a missed schedule firing on boot has already
 * put two runs in flight at once in this repo. `job_runs.startedAt` makes the
 * cadence a property of the data instead.
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
  execute: async ({ inputData, setState }) => {
    const idle = {
      runId: '',
      skipped: true,
      fetched: 0,
      stored: 0,
      sourceErrors: [] as string[],
      cv: '',
    }

    // The gate. `startedAt`, not `finishedAt`: a run that crashed halfway still
    // spent the cycle's fetches and model calls, and re-running it on tomorrow's
    // fire would spend them again.
    const last = await lastRunStartedAt()
    const elapsedHours = last === null ? Infinity : (Date.now() - last) / 3_600_000
    if (!inputData.force && elapsedHours < jobPipeline.intervalHours) {
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

    // Sources, in parallel batches. One dead board must not take down the run.
    const sources = await activeJobSources()
    const postings: NewJob[] = []
    const sourceErrors: string[] = []
    let fetched = 0

    for (let index = 0; index < sources.length; index += jobPipeline.sourceConcurrency) {
      const batch = sources.slice(index, index + jobPipeline.sourceConcurrency)
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
        fetched += result.postings.length

        const cutoff = Date.now() - jobPipeline.ingestWindowDays * 24 * 60 * 60 * 1000
        for (const posting of result.postings) {
          // The ingest window. A posting older than this is refused on age, which
          // is the first of the two guards against a pruned posting returning —
          // `job_deliveries` is the second and the one that actually holds.
          if (posting.postedAt !== null && posting.postedAt < cutoff) continue

          const input = {
            company: posting.company,
            title: posting.title,
            location: posting.location,
            remote: posting.remote === 'remote',
            postedAt: posting.postedAt,
            firstSeenAt: Date.now(),
          }
          postings.push({
            id: jobId(input),
            identity: jobIdentity(input),
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
            postedAt: posting.postedAt,
            discoveredAt: Date.now(),
          })
        }
      }
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
    const idle = { ...inputData, considered: 0, scored: 0, rejected: 0 }
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

    const { kept, rejected } = filterJobs(pending, search)
    const rejectedCount = [...rejected.values()].reduce((total, count) => total + count, 0)

    // Everything the filter rejected is settled at zero rather than left pending,
    // so it never re-enters a later batch. The reason is kept — it is what makes
    // "why didn't I see that?" answerable for a posting no model ever read.
    const settled: JobVerdict[] = []
    for (const job of pending) {
      if (kept.includes(job)) continue
      settled.push({ jobId: job.id, fit: 0, reason: 'Filtered out before scoring.', mismatches: [] })
    }

    // Ordered by how much of the reader's own stack a posting mentions, so the
    // capped batch is spent on the plausible ones rather than on whatever the
    // boards happened to publish most recently. This is the **only** place the
    // CV touches the deterministic path, and it can only reorder: a posting that
    // misses the cap is scored on a later run, where one wrongly filtered is
    // gone for good.
    const batch = rankByCvOverlap(kept, cvTechTags(state.cv)).slice(
      0,
      jobPipeline.maxJobsPerScoringRun,
    )
    if (batch.length === 0) {
      await saveVerdicts(search.slug, settled)
      return { ...idle, rejected: rejectedCount }
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
    }
  },
})

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
    const seen = await recentlyDelivered([...new Set(candidates.map(entry => entry.job.identity))])

    const wonBy = new Map<string, string>()
    for (const candidate of candidates) {
      if (seen.has(candidate.job.identity)) continue
      const threshold = thresholds.get(candidate.searchSlug)
      if (threshold === undefined || candidate.fit < threshold) continue
      // Candidates arrive fit-descending, so the first verdict seen is the best.
      if (!wonBy.has(candidate.job.id)) wonBy.set(candidate.job.id, candidate.searchSlug)
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
  execute: async ({ inputData, state }) => {
    const totals = {
      considered: inputData.reduce((sum, entry) => sum + entry.considered, 0),
      scored: inputData.reduce((sum, entry) => sum + entry.scored, 0),
      sent: inputData.reduce((sum, entry) => sum + entry.sent, 0),
    }

    // Retention runs here rather than on a cron of its own: it is bookkeeping for
    // this pipeline and nothing else reads these rows, so a second schedule would
    // only be a second thing to forget. Its failure must not lose the run's
    // counters, hence the catch — a table one cycle too large costs nothing.
    if (!state.skipped) {
      await pruneJobs().catch(() => 0)
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

    // A run that delivered nothing says so, in Chat rather than in the Jobs tab —
    // a quiet week and a broken pipeline look identical otherwise, and that is
    // exactly the question the counters exist to answer.
    if (!state.skipped && totals.sent === 0) {
      await joobTelegram
        .sendToTelegram(
          [
            `Nothing new worth sending this time.`,
            `I read ${state.fetched} postings, ${state.stored} of them new, and looked closely at ${totals.considered}. None cleared the bar.`,
            `If that keeps happening, \`/targets\` shows what I'm filtering on.`,
          ].join('\n\n'),
          'chat',
        )
        .catch(() => {})
    }

    return {
      skipped: state.skipped,
      note: state.note,
      fetched: state.fetched,
      stored: state.stored,
      sourceErrors: state.sourceErrors,
      sendErrors: inputData.flatMap(entry => entry.sendErrors),
      searches: inputData,
      ...totals,
    }
  },
})

export const findJobs = createWorkflow({
  id: 'find-jobs',
  inputSchema: runInput,
  outputSchema: runReport,
  stateSchema: runState,
  // Daily, gated to every two days by `job_runs.startedAt` — see the note at the
  // head of this file for why the cron does not express the cadence itself.
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
