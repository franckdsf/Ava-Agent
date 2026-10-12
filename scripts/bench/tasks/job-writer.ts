/**
 * `pnpm bench job-writer` — `AVA_MODEL_JOB_WRITER`, through `writeJobBrief`.
 *
 * A fixture is four postings that were actually delivered, dealt across the
 * searches that won them, each with the verdict the scorer stored — exactly what
 * the deliver step hands the writer. One run writes all four, one call each.
 *
 * Most delivered postings state no pay, which makes the writer's first rule —
 * never invent a fact — checkable for the fact most worth inventing: an amount
 * in the summary or the fits of a posting that names none is a flag.
 *
 * A failed brief is not a failed run: production degrades it to the scorer's
 * reason and mismatches and still sends it. The run fails only when all four did.
 */
import { and, desc, eq, gt } from 'drizzle-orm'
import { bench } from '../../../src/config/bench.js'
import { db } from '../../../src/db/client.js'
import { jobDeliveries, jobMatches, jobs, jobSearches } from '../../../src/db/schema.js'
import {
  jobAgents,
  jobSummarySchema,
  jobWriterId,
  renderJobBriefPrompt,
  writeJobBrief,
} from '../../../src/mastra/agents/job-scorer.js'
import type { z } from 'zod'
import type { BenchTask } from '../kit.js'

type Brief = z.infer<typeof jobSummarySchema>
type Briefs = (Brief | null)[]

interface Posting {
  id: string
  title: string
  company: string
  location: string | null
  remote: string
  salaryText: string | null
  contractType: string | null
  description: string | null
}

interface Winner {
  search: string
  verdict: { fit: number; reason: string | null; mismatches: string[] | null }
  posting: Posting
}

export interface JobWriterFixture {
  winners: Winner[]
}

const prompt = (w: Winner): string => renderJobBriefPrompt({ label: w.search }, w.verdict, w.posting)

/** An amount of money: a currency sign or code beside a number, or "80k". */
const PAY = /[$€£]\s?\d|\d[\d,. ]*\s?(k|K)\b|\d[\d,. ]*\s?(€|eur|usd|gbp|chf)\b/i

/**
 * An amount whose number appears nowhere in the posting. "Raised $20M" read
 * off the description is the posting talking, not the writer inventing — only
 * a number the posting never wrote is a claim the model made up.
 */
function invents(text: string, posting: Posting): boolean {
  const amount = text.match(PAY)?.[0]
  const number = amount?.match(/\d+/)?.[0]
  if (!number) return false
  return ![posting.title, posting.description ?? ''].some(source => source.includes(number))
}

/** Markdown the instructions forbid inside a field: a heading, a bullet, bold. */
const MARKDOWN = /(^|\n)\s*(#{1,6}\s|[-*•]\s)|\*\*/

/** Everything code can prove wrong with one run's briefs. */
export function jobWriterFlags(briefs: Briefs, fixture: JobWriterFixture): string[] {
  const flags: string[] = []
  briefs.forEach((brief, index) => {
    const winner = fixture.winners[index]
    const at = `posting ${index + 1}`
    if (!brief) {
      flags.push(`${at}: every attempt failed — production would send the scorer's bare reason`)
      return
    }
    if (!brief.summary.trim()) flags.push(`${at}: empty summary`)
    const { min, max } = bench.jobBriefFits
    if (brief.fits.length < min || brief.fits.length > max) {
      flags.push(`${at}: ${brief.fits.length} fits, the rule is ${min} to ${max}`)
    }
    // "Keep every one the scorer found": dropping all of them is provable;
    // merging two into one is not, so only the first is a flag.
    if (brief.watchOuts.length === 0 && (winner?.verdict.mismatches?.length ?? 0) > 0) {
      flags.push(`${at}: no watch-outs, but the scorer found ${winner?.verdict.mismatches?.length}`)
    }
    // Summary and fits only: a watch-out may carry a pay floor the scorer saw in
    // the search, which the posting itself need not state.
    const claimed = winner ? [brief.summary, ...brief.fits].find(text => invents(text, winner.posting)) : undefined
    if (winner && !winner.posting.salaryText && claimed) {
      flags.push(`${at}: names an amount the posting does not state — "${claimed.slice(0, 90)}"`)
    }
    const marked = [brief.summary, ...brief.fits, ...brief.watchOuts].find(text => MARKDOWN.test(text))
    if (marked) flags.push(`${at}: markdown inside a field — "${marked.slice(0, 60)}"`)
  })
  return flags
}

/** Delivered postings with the verdict that won them, most recent first, dealt across searches. */
async function readFixtures(count: number): Promise<JobWriterFixture[]> {
  const rows = await db()
    .select({
      searchSlug: jobDeliveries.searchSlug,
      search: jobSearches.label,
      fit: jobMatches.fit,
      reason: jobMatches.reason,
      mismatches: jobMatches.mismatches,
      id: jobs.id,
      title: jobs.title,
      company: jobs.company,
      location: jobs.location,
      remote: jobs.remote,
      salaryText: jobs.salaryText,
      contractType: jobs.contractType,
      description: jobs.description,
    })
    .from(jobDeliveries)
    .innerJoin(jobs, eq(jobs.identity, jobDeliveries.identity))
    .innerJoin(
      jobMatches,
      and(eq(jobMatches.jobId, jobs.id), eq(jobMatches.searchSlug, jobDeliveries.searchSlug), gt(jobMatches.fit, 0)),
    )
    .innerJoin(jobSearches, eq(jobSearches.slug, jobDeliveries.searchSlug))
    .orderBy(desc(jobDeliveries.deliveredAt))

  const bySearch = new Map<string, Winner[]>()
  for (const row of rows) {
    const { searchSlug, search, fit, reason, mismatches, ...posting } = row
    const winner: Winner = { search, verdict: { fit: fit ?? 0, reason, mismatches }, posting }
    bySearch.set(searchSlug, [...(bySearch.get(searchSlug) ?? []), winner])
  }
  const dealt: Winner[] = []
  const queues = [...bySearch.values()]
  while (queues.some(queue => queue.length)) {
    for (const queue of queues) {
      const next = queue.shift()
      if (next) dealt.push(next)
    }
  }

  const fixtures: JobWriterFixture[] = []
  for (let i = 0; i + bench.writerBatch <= dealt.length && fixtures.length < count; i += bench.writerBatch) {
    fixtures.push({ winners: dealt.slice(i, i + bench.writerBatch) })
  }
  return fixtures
}

export const jobWriter: BenchTask<JobWriterFixture, Briefs> = {
  title: 'job-writer',
  knob: 'AVA_MODEL_JOB_WRITER',
  agentId: jobWriterId,
  agent: jobAgents[jobWriterId],
  field: [
    { model: 'openrouter/openai/gpt-5.6-luna', efforts: [false, 'low'] },
    { model: 'openrouter/deepseek/deepseek-v4.1-flash', efforts: [false, 'low'] },
    { model: 'openrouter/anthropic/claude-haiku-5.5', efforts: [false, 'low'] },
  ],
  fixtures: readFixtures,
  describe: f => `${f.winners.length} postings — ${f.winners.map(w => `${w.posting.title.slice(0, 40)} @ ${w.posting.company}`).join(' · ')}`,
  call: async (mastra, fixture) => {
    // One after another: the pool already holds eight runs in flight.
    const briefs: Briefs = []
    for (const winner of fixture.winners) briefs.push(await writeJobBrief(mastra, prompt(winner)))
    return briefs.some(Boolean) ? briefs : null
  },
  check: jobWriterFlags,
  metrics: briefs => {
    const ok = briefs.filter((b): b is Brief => b !== null)
    const avg = (pick: (b: Brief) => number) => (ok.length ? ok.reduce((sum, b) => sum + pick(b), 0) / ok.length : NaN)
    return {
      'summary words': avg(b => b.summary.split(/\s+/).filter(Boolean).length),
      fits: avg(b => b.fits.length),
      'watch-outs': avg(b => b.watchOuts.length),
    }
  },
  judgeInput: fixture => fixture.winners.map((w, i) => `## Posting ${i + 1}\n\n${prompt(w)}`).join('\n\n---\n\n'),
  renderOutput: (briefs, fixture) =>
    briefs
      .map((brief, index) => {
        const head = `Posting ${index + 1} — ${fixture.winners[index]?.posting.title ?? ''}`
        return brief
          ? [
            head,
            `summary: ${brief.summary}`,
            `fits: ${brief.fits.join(' / ') || '(none)'}`,
            `watch-outs: ${brief.watchOuts.join(' / ') || '(none)'}`,
          ].join('\n')
          : `${head}\nFAILED — production would send the scorer's bare reason`
      })
      .join('\n\n'),
  criteria: [
    'Every fact is in the posting or the verdict. An invented salary, team size, technology or location ' +
    'is the worst failure here; "pay not stated" is the honest line.',
    'The summary leads with what the role actually is and why it was sent, not the company\'s mission.',
    'Fits are concrete specifics from the posting; watch-outs keep every mismatch the scorer found, in ' +
    'plain words a person can act on, neither softened nor added to. The score is not re-judged.',
    'No hype and no boilerplate — benefits, culture, equal-opportunity text — and no mention of having ' +
    'dropped it.',
  ],
  caveats: () => [
    'The writer sees the posting as the scorer did, its description cut to the scorer\'s limit — the bench ' +
    'sends what production sends. `$/run` and the median are for four postings, one call each.',
  ],
}
