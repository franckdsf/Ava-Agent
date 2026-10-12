import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { JOOB_TOPICS } from '../../config/joob-topics.js'
import { LEAD_SIGNAL_LABELS, leadPipeline, type LeadSignalKind } from '../../config/leads.js'
import {
  activeProfiles,
  claimLeadDelivery,
  getLeads,
  inCooldown,
  insertSignals,
  listDeliverable,
  listUnscoredSignals,
  pruneLeads,
  releaseLeadDelivery,
  saveLeadAngle,
  saveLeadPage,
  saveLeadVerdicts,
  saveVisionVerdict,
  upsertLeads,
} from '../../db/leads.js'
import { finishRun } from '../../db/runs.js'
import { filterLead, visionIsStale } from '../../services/lead-filter.js'
import { hiringSignalsFromJobs, idOf, resolveLeadPage } from '../../services/lead-signals.js'
import { scoutProspects } from '../../services/lead-scout.js'
import { proposeProspects } from '../agents/lead-scout.js'
import { LEADS } from '../pipelines.js'
import { joobTelegram } from '../../services/joob-telegram.js'
import { fetchPortfolio } from '../../services/portfolio.js'
import { escapeMarkdown } from '../../services/telegram.js'
import {
  judgeLeadVisuals,
  renderLeadBriefPrompt,
  renderLeadScoringPrompt,
  renderLeadVisionPrompt,
  scoreLeadBatch,
  writeLeadBrief,
} from '../agents/lead-scorer.js'
import type { ClientProfile, Lead, LeadSignal } from '../../db/schema.js'

/**
 * The prospecting run
 * ([ADR-0038](../../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
 *
 * ```
 * signals → resolve pages → filter → score batch (text) → vision on survivors → write + deliver
 * ```
 *
 * **The order is the cost control, not a style.** Job intake is bounded by what
 * boards published; lead intake is bounded by nothing at all, and the last stage
 * before delivery is the most expensive model call in this repo. Three things
 * keep that finite, and each is load-bearing:
 *
 * 1. A lead only exists because a **dated signal** put it here, inside
 *    `signalWindowDays`. The narrowing is done by the source, not by a criterion.
 * 2. Vision runs **only on leads that already cleared the text score**, one call
 *    each, never on the batch.
 * 3. `maxVisionCallsPerRun` is a hard stop, and `pipeline_runs.detail.visionCalls` records
 *    how close a run came to it — so a filter regression is visible here rather
 *    than only on an invoice.
 *
 * It reads the `jobs` table and writes nothing to it. Same database, same
 * container, same portfolio fetch, same cycle claim — and no job row is touched.
 */

const runInput = z.object({
  /** Skips the elapsed-time gate. Studio and a reader-triggered run. */
  force: z.boolean().optional(),
  /** Limits the run to these profile slugs. All active ones when absent. */
  profiles: z.array(z.string()).optional(),
})

const runState = z.object({
  runId: z.string(),
  skipped: z.boolean(),
  fetched: z.number(),
  stored: z.number(),
  noCompanyDomain: z.number(),
  portfolio: z.string(),
  note: z.string().optional(),
})

const profileRef = z.object({ profileSlug: z.string() })

const scoredProfile = profileRef.extend({
  considered: z.number(),
  scored: z.number(),
  problems: z.array(z.string()),
})

const deliveredProfile = scoredProfile.extend({
  sent: z.number(),
  visionCalls: z.number(),
  sendErrors: z.array(z.string()),
})

const runReport = z.object({
  skipped: z.boolean(),
  fetched: z.number(),
  stored: z.number(),
  considered: z.number(),
  scored: z.number(),
  visionCalls: z.number(),
  delivered: z.number(),
  note: z.string().optional(),
})

/**
 * Collects signals, resolves the companies behind them, and stores both.
 *
 * The cycle is claimed through `LEADS.open()` — one guarded write, for the
 * reason [ADR-0034](../../../docs/decisions/0034-a-pipeline-claims-its-cycle.md)
 * records, and handed back if the run stops before spending anything. The cycle
 * id is `leads`, distinct from `jobs`, so the two pipelines never block each
 * other.
 */
const collect = createStep({
  id: 'collect-signals',
  inputSchema: runInput,
  outputSchema: z.array(profileRef),
  stateSchema: runState,
  execute: async ({ inputData, setState, mastra }) => {
    const idle = {
      runId: '',
      skipped: true,
      fetched: 0,
      stored: 0,
      noCompanyDomain: 0,
      portfolio: '',
    }

    // Nothing inside this window fetches a source or calls a model, so a run
    // that stops here — no profiles, or the run row losing the write lock —
    // hands the 44h cycle back (audit F1). Everything after it has spent it.
    const opened = await LEADS.open({ force: inputData.force }, async ({ abandon }) => {
      const profiles = await activeProfiles()
      const wanted = inputData.profiles
        ? profiles.filter(profile => inputData.profiles?.includes(profile.slug))
        : profiles
      if (wanted.length === 0) {
        return abandon('Nobody to prospect for — no active client profiles. Use /client.')
      }
      return wanted
    })
    if (!opened.ok) {
      await setState({ ...idle, note: opened.note })
      return []
    }
    const { value: wanted, runId } = opened

    // The portfolio is the rubric, exactly as it is for jobs. A failure stops
    // the run rather than scoring against nothing: unscored signals simply wait
    // and the next run picks them up. Reported loudly, because silence is
    // indistinguishable from "no leads matched".
    let portfolio: string
    try {
      portfolio = (await fetchPortfolio()).markdown
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await joobTelegram
        .notify(
          `I couldn't read your portfolio, so I've skipped this prospecting run rather than guess what you sell. ${escapeMarkdown(reason)}`,
          'chat',
        )
      await setState({ ...idle, runId, note: `Portfolio fetch failed: ${reason}` })
      await finishRun(runId, { note: `Portfolio fetch failed: ${reason}` })
      return []
    }

    // The free source: companies already in the `jobs` table. Read-only, and
    // bounded by that table's own 30-day window, so it cannot flood a run.
    const harvest = await hiringSignalsFromJobs(leadPipeline.maxLeadsPerScoringRun * 4)

    // The sonar scout, on its **own** budget
    // ([ADR-0039](../../../docs/decisions/0039-a-lead-scout-with-its-own-budget.md)).
    // Measured 2026-08-19, before it existed: 37 of 39 leads came from postings
    // the *job* scout happened to fetch, so lead coverage was a function of
    // `jobScout.maxSearchesPerRun` — a number chosen for a different pipeline's
    // cost. `leadScout.maxProfilesPerRun` is what this one is chosen against.
    //
    // Everything it proposes is verified before it is stored: the company's own
    // site must answer with real text and name the company, and the announcement
    // must resolve. An unverifiable prospect is dropped, never downgraded.
    const scouted = await scoutProspects(wanted, profile => proposeProspects(mastra, profile))
    if (scouted.problems.length > 0) {
      mastra
        .getLogger()
        ?.info(`Lead scout dropped ${scouted.problems.length} proposals`, {
          reasons: scouted.problems.slice(0, 10),
        })
    }

    // One company per run across both sources. The scout goes first because its
    // signal is richer — "raised $4M last week" beats "has an open role" — and a
    // duplicate host from the jobs table would only restate what it already said.
    const bySource = new Map(scouted.signals.map(signal => [signal.leadId, signal]))
    for (const signal of harvest.signals) {
      if (!bySource.has(signal.leadId)) bySource.set(signal.leadId, signal)
    }
    const collected = [...bySource.values()]

    const now = Date.now()
    await upsertLeads(
      collected.map(signal => ({
        id: signal.leadId,
        company: signal.company,
        location: signal.location,
        url: signal.companyUrl,
        discoveredAt: now,
        lastSignalAt: signal.occurredAt,
      })),
    )

    const stored = await insertSignals(
      collected.map(signal => ({
        id: idOf(signal),
        leadId: signal.leadId,
        kind: signal.kind,
        sourceUrl: signal.sourceUrl,
        origin: signal.origin,
        occurredAt: signal.occurredAt,
        summary: signal.summary,
        discoveredAt: now,
      })),
    )

    // Resolve the pages of leads that have never been read. This is the evidence
    // the filter and the scorer judge on — a lead described only by a model's
    // one-line "why" is rejected by every literal rule there is, which is the
    // failure ADR-0026 measured and fixed by reading the page instead.
    const leadIds = [...new Set(collected.map(signal => signal.leadId))]
    const rows = await getLeads(leadIds)
    const unread = rows.filter(lead => !lead.pageFetchedAt)
    for (let index = 0; index < unread.length; index += leadPipeline.pageConcurrency) {
      const slice = unread.slice(index, index + leadPipeline.pageConcurrency)
      await Promise.all(
        slice.map(async lead => {
          const page = await resolveLeadPage(lead.url)
          if (page.problem) return
          await saveLeadPage(lead.id, page.text, lead.location)
        }),
      )
    }

    await pruneLeads()

    await setState({
      runId,
      skipped: false,
      fetched: collected.length,
      stored,
      noCompanyDomain: harvest.noCompanyDomain,
      portfolio,
    })

    return wanted.map(profile => ({ profileSlug: profile.slug }))
  },
})

/** Filters, then scores one batch for one profile. One model call. */
const scoreProfile = createStep({
  id: 'score-profile',
  inputSchema: profileRef,
  outputSchema: scoredProfile,
  stateSchema: runState,
  execute: async ({ inputData, state, mastra }) => {
    const empty = { ...inputData, considered: 0, scored: 0, problems: [] as string[] }
    if (state.skipped) return empty

    const profiles = await activeProfiles()
    const profile = profiles.find(entry => entry.slug === inputData.profileSlug)
    if (!profile) return { ...empty, problems: ['profile disappeared mid-run'] }

    const kinds = profile.signalKinds as LeadSignalKind[]
    const signals = await listUnscoredSignals(
      profile.slug,
      kinds,
      leadPipeline.maxLeadsPerScoringRun,
    )
    if (signals.length === 0) return empty

    const leads = await getLeads([...new Set(signals.map(signal => signal.leadId))])
    const byId = new Map(leads.map(lead => [lead.id, lead]))

    // The deterministic gate. Two rules, because the signal already did the
    // narrowing — see `lead-filter.ts` for why this is deliberately thinner than
    // `filterJob`.
    const kept: { signal: LeadSignal; lead: Lead }[] = []
    for (const signal of signals) {
      const lead = byId.get(signal.leadId)
      if (!lead) continue
      if (!lead.pageText) continue
      if (!filterLead(lead, profile).keep) continue
      kept.push({ signal, lead })
    }
    if (kept.length === 0) return empty

    const prompt = renderLeadScoringPrompt(state.portfolio, profile, kept)
    const batchIds = new Set(kept.map(entry => entry.signal.id))
    const verdicts = await scoreLeadBatch(mastra, prompt, batchIds)

    const bySignal = new Map(kept.map(entry => [entry.signal.id, entry]))
    await saveLeadVerdicts(
      profile.slug,
      verdicts.flatMap(verdict => {
        const entry = bySignal.get(verdict.id)
        if (!entry) return []
        return [
          {
            leadId: entry.lead.id,
            signalId: entry.signal.id,
            fit: verdict.fit,
            reason: verdict.reason,
            mismatches: verdict.mismatches,
          },
        ]
      }),
    )

    return { ...inputData, considered: kept.length, scored: verdicts.length, problems: [] }
  },
})

/**
 * Looks at the winners' images, writes them up, and sends them.
 *
 * **This is the only step that spends a vision call**, and it does so after two
 * cheaper stages have already thrown most candidates away. The budget is
 * per-run and shared across profiles by being recomputed from the deliveries
 * already made in this step — a lead beyond it keeps its text score and is
 * picked up next run rather than being lost.
 */
const deliverProfile = createStep({
  id: 'deliver-profile',
  inputSchema: scoredProfile,
  outputSchema: deliveredProfile,
  stateSchema: runState,
  execute: async ({ inputData, state, mastra }) => {
    const empty = { ...inputData, sent: 0, visionCalls: 0, sendErrors: [] as string[] }
    if (state.skipped) return empty

    const profiles = await activeProfiles()
    const profile = profiles.find(entry => entry.slug === inputData.profileSlug)
    if (!profile) return empty

    const threshold = profile.fitThreshold ?? leadPipeline.defaultFitThreshold
    const candidates = await listDeliverable(
      profile.slug,
      threshold,
      leadPipeline.maxLeadsPerDelivery * 2,
    )
    if (candidates.length === 0) return empty

    // The cooldown, which is what `job_deliveries`'s key does for jobs. The
    // ledger here deliberately admits a second delivery for a *new* signal, so
    // without this a company that raised, launched and hired in one week would
    // arrive three times in three days.
    const cooling = await inCooldown()
    const eligible = candidates
      .filter(candidate => !cooling.has(candidate.leadId))
      .slice(0, leadPipeline.maxLeadsPerDelivery)
    if (eligible.length === 0) return empty

    const leads = await getLeads(eligible.map(candidate => candidate.leadId))
    const byId = new Map(leads.map(lead => [lead.id, lead]))

    let visionCalls = 0
    let sent = 0
    const sendErrors: string[] = []
    // One company per run, even across profiles: two profiles both winning the
    // same company must not produce two messages about it.
    const sentThisRun = new Set<string>()

    for (const candidate of eligible) {
      const lead = byId.get(candidate.leadId)
      if (!lead) continue
      if (sentThisRun.has(lead.id)) continue

      const signal = await signalFor(candidate.signalId)
      if (!signal) continue

      // Vision, bounded three ways: only here, only on a survivor, and only
      // within the run's budget. A cached verdict is reused rather than re-paid.
      let visual = lead.visionVerdict
      if (
        visionCalls < leadPipeline.maxVisionCallsPerRun &&
        visionIsStale(lead, leadPipeline.visionStaleDays, signal.kind)
      ) {
        const page = await resolveLeadPage(lead.url)
        if (page.images.length > 0) {
          visionCalls += 1
          const judged = await judgeLeadVisuals(mastra, renderLeadVisionPrompt(profile, lead), page.images)
          if (judged) {
            visual = `${judged.observation} Opportunity: ${judged.opportunity}. Angle: ${judged.angle}`
            await saveVisionVerdict(lead.id, visual)
          }
        }
      }

      const written = await writeLeadBrief(
        mastra,
        renderLeadBriefPrompt(profile, candidate, signal, lead, visual),
      )

      // The writer already retried. A failure degrades to the scorer's own
      // reason rather than losing a lead that has been judged worth sending.
      const brief = written ?? {
        summary: candidate.reason || `Matched "${profile.label}".`,
        angle: '',
        watchOuts: candidate.mismatches,
      }

      // Claimed before it is sent, per
      // [ADR-0033](../../../docs/decisions/0033-a-delivery-is-claimed-before-it-is-sent.md).
      const claimed = await claimLeadDelivery({
        leadId: lead.id,
        signalId: signal.id,
        company: lead.company,
        url: lead.url,
        profileSlug: profile.slug,
        signalKind: signal.kind,
      })
      if (!claimed) continue

      try {
        await joobTelegram.sendToTelegram(
          renderLeadMessage(lead, profile, signal, candidate.fit, brief),
          'leads',
        )
        if (brief.angle) {
          await saveLeadAngle(lead.id, signal.id, profile.slug, brief.angle)
        }
        sentThisRun.add(lead.id)
        sent += 1
      } catch (error) {
        // The claim is released so the next run may try again — a send that
        // failed is not a delivery.
        await releaseLeadDelivery(lead.id, signal.id)
        sendErrors.push(`${lead.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return { ...inputData, sent, visionCalls, sendErrors }
  },
})

/** Folds the per-profile results together and closes the run row. */
const report = createStep({
  id: 'report',
  inputSchema: z.array(deliveredProfile),
  outputSchema: runReport,
  stateSchema: runState,
  execute: async ({ inputData, state }) => {
    if (state.skipped || !state.runId) {
      return {
        skipped: true,
        fetched: 0,
        stored: 0,
        considered: 0,
        scored: 0,
        visionCalls: 0,
        delivered: 0,
        note: state.note,
      }
    }

    const sum = (pick: (entry: z.infer<typeof deliveredProfile>) => number) =>
      inputData.reduce((total, entry) => total + pick(entry), 0)

    const considered = sum(entry => entry.considered)
    const scored = sum(entry => entry.scored)
    const visionCalls = sum(entry => entry.visionCalls)
    const delivered = sum(entry => entry.sent)

    // A run that found nothing and a run that could not attribute anything to a
    // company look identical in the counters, so the gap is named. A large
    // `noCompanyDomain` is the measurement that says the sonar lead scout is now
    // worth building — see ADR-0038's source table.
    const notes: string[] = []
    if (state.noCompanyDomain > 0 && state.fetched === 0) {
      notes.push(
        `${state.noCompanyDomain} postings had no company domain — every one was on a board or an ATS host.`,
      )
    }
    if (visionCalls >= leadPipeline.maxVisionCallsPerRun) {
      notes.push(`Hit the vision cap (${leadPipeline.maxVisionCallsPerRun}); the rest wait.`)
    }

    await finishRun(state.runId, {
      fetched: state.fetched,
      stored: state.stored,
      considered,
      scored,
      delivered,
      note: notes.join(' ') || null,
      detail: { visionCalls },
    })

    return {
      skipped: false,
      fetched: state.fetched,
      stored: state.stored,
      considered,
      scored,
      visionCalls,
      delivered,
      note: notes.join(' ') || undefined,
    }
  },
})

/** One signal by id. Small enough to be worth a helper rather than a join. */
async function signalFor(id: string): Promise<LeadSignal | null> {
  const { db, migrate } = await import('../../db/client.js')
  const { leadSignals } = await import('../../db/schema.js')
  const { eq } = await import('drizzle-orm')
  await migrate()
  const [row] = await db().select().from(leadSignals).where(eq(leadSignals.id, id)).limit(1)
  return row ?? null
}

/**
 * One lead as a Telegram message.
 *
 * Structure from the template and prose from the model, for the reason the
 * digest and the job message both do it that way: a model asked to emit its own
 * markdown eventually emits a broken link, and the URL is the one part that must
 * be exactly right.
 *
 * The **angle is quoted rather than bulleted**, because it is the one block the
 * reader will copy out and send. A blockquote makes the boundary of what is
 * theirs to send unambiguous on a phone.
 */
export function renderLeadMessage(
  lead: Lead,
  profile: ClientProfile,
  signal: LeadSignal,
  fit: number,
  brief: { summary: string; angle: string; watchOuts: string[] },
): string {
  const watchOuts = brief.watchOuts.map(value => value.trim()).filter(Boolean)
  const kind = LEAD_SIGNAL_LABELS[signal.kind as LeadSignalKind] ?? signal.kind

  const footer = [lead.location ?? undefined, kind, profile.label, `fit ${fit}`]
    .filter((value): value is string => Boolean(value))
    .map(escapeMarkdown)
    .join(' · ')

  return [
    `## 🎯 [${escapeMarkdown(lead.company)}](${lead.url})`,
    '',
    `**${escapeMarkdown(signal.summary)}** — [source](${signal.sourceUrl})`,
    '',
    brief.summary.trim(),
    ...(brief.angle.trim() ? ['', '**An opening**', `> ${escapeMarkdown(brief.angle.trim())}`] : []),
    ...(watchOuts.length > 0
      ? ['', '**Worth checking**', ...watchOuts.map(item => `- ${escapeMarkdown(item)}`)]
      : []),
    '',
    `_${footer}_`,
  ].join('\n')
}

export const findLeads = createWorkflow({
  id: LEADS.workflowId,
  inputSchema: runInput,
  outputSchema: runReport,
  stateSchema: runState,
  // 09:00 and 21:00, gated by the `leads` cycle claim — the cron does not
  // express the cadence, for the reason at the head of `find-jobs.ts`; the kit
  // renders it from `LEADS`. An hour after each job fire so the two never
  // contend for the same portfolio fetch, and so a hiring signal ingested this
  // morning is available to prospect on the same day.
  schedule: LEADS.schedule,
})
  .then(collect)
  .foreach(scoreProfile)
  .foreach(deliverProfile)
  .then(report)
  .commit()

/** Named for the tab its output lands in, so a reader of `index.ts` can tell. */
export const LEAD_DELIVERY_TAB = JOOB_TOPICS.leads.slug
