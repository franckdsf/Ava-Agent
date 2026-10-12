import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { jobPipeline } from '../../config/jobs.js'
import type { JobSearch } from '../../db/schema.js'
import { leakedStructure, withRetry } from '../../services/structured-output.js'

/**
 * The two model calls in a job run, and they are deliberately two.
 *
 * **The scorer** reads the CV once and judges the whole batch against it — N
 * postings in, N verdicts out. One call, not one per posting: that is what lets
 * a 20,000-token CV be paid for once a run instead of forty times, and it is
 * what keeps this step a *classifier over a fixed row set*, which is what
 * [invariant 2](../../../AGENTS.md#invariants) requires of anything on a
 * schedule.
 *
 * **The writer** turns one winning verdict into the message a person reads. Per
 * posting, and only for the handful that cleared the bar — the same split the
 * news pipeline makes between its ranker and its article writer.
 *
 * Two agents rather than one prompt doing both, for the reason the namer and the
 * scout are separate: the jobs share nothing. One is a judge emitting numbers
 * over a large fixed input; the other is a writer emitting prose about a single
 * item. Merging them would put the CV in every writing call.
 */

export const jobScorerId = 'job-scorer'
export const jobWriterId = 'job-writer'

export const scoringSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      fit: z.number().min(0).max(100),
      reason: z.string(),
      mismatches: z.array(z.string()),
    }),
  ),
})

/**
 * **Strict on purpose — no `.default([])` on the arrays.**
 *
 * Defaults were tried first, after gemini-3.1-flash-lite returned
 * `{"summary":"…This role is fully` — truncated mid-string against its output
 * cap — and strict fields made Mastra throw
 * `STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED`. Making the arrays default to
 * empty *does* stop the throw, and that is exactly what is wrong with it: a
 * response that lost two thirds of its content silently becomes a valid one,
 * and nothing ever reports that it happened. Retrying is the right answer to a
 * truncated response, and a strict schema is what tells us to retry.
 *
 * (A zod default also makes the schema's *input* type optional while its output
 * type stays required, and `response.object` is typed from the input side — so
 * the fields arrive as possibly-`undefined` anyway and every caller has to
 * normalize them. Strict avoids that too.)
 */
export const jobSummarySchema = z.object({
  /** What the role is and why it is being shown. Two or three sentences. */
  summary: z.string(),
  /** Concrete reasons it suits the reader. */
  fits: z.array(z.string()),
  /** Concrete reasons to hesitate. May be empty, and usually is not. */
  watchOuts: z.array(z.string()),
})

const scorer = new Agent({
  id: jobScorerId,
  name: 'Job Scorer',
  model: env.AVA_MODEL_JOB_SCORER,
  /**
   * Low effort, set rather than left to the provider — the setting `pnpm bench
   * job-scorer` chose the model at. Off was measured and is worse here: judging
   * fit against a whole CV is where the thinking earns its tokens.
   */
  defaultOptions: {
    providerOptions: {
      openrouter: {
        reasoning: { effort: 'low' },
        // Cheapest endpoint first, falling back on failure, as Newy and Joob
        // route. Agents move to it as they are benched, not all at once — one
        // still pinned to endpoints has not been re-measured yet.
        provider: { sort: 'price' },
      },
    },
  },
  instructions: `
You judge how well job postings suit one specific person, whose CV you are given
in full.

You will be given their CV, one saved search describing what they are currently
looking for, and a numbered batch of postings. Return one verdict per posting,
using the id exactly as given. Never invent an id, never return one twice, and
never skip one — a posting you cannot judge scores low with a reason saying so.

"fit" is 0–100. Anchor it, because a scale everyone invents for themselves is
worthless:

- **85–100** — they should apply today. The role matches what they do, at their
  level, and nothing in it contradicts what they said they want.
- **70–84** — worth a serious look. Clearly in their field and level, with one
  real reservation.
- **50–69** — plausible but compromised: wrong level, wrong stack emphasis, or a
  named thing they said they did not want.
- **20–49** — same industry, not their job.
- **0–19** — not their field at all.

Judge against **what the CV shows they have actually done**, not against the job
advert's own enthusiasm. Every advert claims to be an exciting opportunity; that
is not evidence. A posting that lists a stack they have shipped repeatedly is a
better fit than one that lists a stack they mention once.

Read the search's own notes as the reader's current intent, and let it **override
the CV where they disagree**. A CV is a record of what someone has done; the
search is what they want next, and someone moving away from a stack has still
written a lot of it.

"reason" is at most 20 words, concrete, and about *this* posting. "Good match for
their skills" is not a reason. "Ships React and TypeScript at scale, exactly their
last four years" is.

"mismatches" names the axes where it falls short, one short phrase each, from:
seniority, location, stack, compensation, contract, domain, company type. Give
the axis and the specifics — "seniority: asks for 10+ years, they have 6",
"stack: Vue, they are React". **Return them for high scorers too.** A posting
worth applying to still has things worth knowing before the interview, and this
field is the only place they are recorded. Return an empty array only when there
is genuinely nothing.

Write every verdict in English, whatever language the posting is in. These are
stored and read by other parts of the system, not only by a person.
`.trim(),
})

const writer = new Agent({
  id: jobWriterId,
  name: 'Job Writer',
  model: env.AVA_MODEL_JOB_WRITER,
  instructions: `
You write the short brief a person reads on their phone about one job that
matched their search.

You are given the posting, and the verdict a scorer already reached about it —
its fit score, its one-line reason, and the mismatches it found. Your job is to
turn that into something readable. **Do not re-judge it.** The score is decided;
you are explaining it.

Return three things:

- "summary": two or three sentences. What the role actually is, what the company
  does, and why it is being shown to this person. Lead with the role, not with the
  company's mission statement.
- "fits": two to four concrete reasons it suits them. Specifics from the posting,
  not adjectives — "React and TypeScript, their main stack", not "great technical
  match".
- "watchOuts": the mismatches, in plain words a person can act on. Keep every one
  the scorer found; do not soften them and do not add new ones. Empty only if the
  scorer returned none.

Rules that matter:

- **Never invent a fact.** Not a salary, not a team size, not a technology, not a
  location. If the posting does not say, it is not known. An advert that omits pay
  is extremely common and "pay not stated" is the honest line.
- **Drop the boilerplate.** Job adverts carry equal-opportunity statements,
  benefits lists and culture paragraphs. None of it belongs here. **And never
  mention that you dropped it** — no "the posting also covers benefits".
- **No hype.** You are not selling the job. If the strongest honest thing to say
  is that it is a reasonable fit with a real drawback, say that.
- Write in the same language the reader's search is written in. If that is not
  clear, write in English.
- Plain prose, no markdown headings, no bullets inside a field — the message
  template adds structure around what you return.
`.trim(),
  /**
   * Raised because the default truncated a real response mid-string.
   *
   * The first live run came back as `{"summary":"…This role is fully` and threw
   * schema validation — three fields of prose does not sound like much until a
   * model spends its budget on the first one. 2000 is several times what a
   * well-behaved response needs, and an unused allowance costs nothing.
   *
   * Reasoning off, said explicitly: `pnpm bench job-writer` measured it level
   * with the provider's default at half the latency, and the default leaked
   * JSON fragments into a field twice in 48 briefs (none in 24 with it off).
   * Cheapest endpoint first.
   */
  defaultOptions: {
    modelSettings: { maxOutputTokens: 2000 },
    providerOptions: {
      openrouter: {
        reasoning: { enabled: false },
        provider: { sort: 'price' },
      },
    },
  },
})

export const jobAgents = { [jobScorerId]: scorer, [jobWriterId]: writer }

/** One posting as the batch scorer sees it. Deliberately compact — see below. */
export function renderPostingForScoring(job: {
  id: string
  title: string
  company: string
  location: string | null
  remote: string
  salaryText: string | null
  contractType: string | null
  description: string | null
}): string {
  return [
    `id: ${job.id}`,
    `title: ${job.title}`,
    `company: ${job.company}`,
    `location: ${job.location ?? 'not stated'} (${job.remote})`,
    job.salaryText ? `pay: ${job.salaryText}` : null,
    job.contractType ? `contract: ${job.contractType}` : null,
    // Truncated hard, and this is the knob that decides whether the batch fits.
    // The opening of an advert carries the role; the tail carries the
    // equal-opportunity statement.
    job.description
      ? `description: ${job.description.slice(0, jobPipeline.scorerDescriptionChars)}`
      : 'description: (none)',
  ]
    .filter(Boolean)
    .join('\n')
}

type ScorablePosting = Parameters<typeof renderPostingForScoring>[0]

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
 * The batch scoring prompt: the CV once, the search once, then every posting.
 *
 * Beside the agent rather than in the workflow step, so anything that has to
 * send the scorer exactly what a run sends — `pnpm bench` swapping only the
 * model — builds it from the same function.
 */
export function renderJobScoringPrompt(cv: string, search: JobSearch, postings: ScorablePosting[]): string {
  return [
    '## The person',
    cv,
    '',
    '## What they are looking for right now',
    renderSearchForScoring(search),
    '',
    `## Postings to judge (${postings.length})`,
    postings.map(renderPostingForScoring).join('\n\n---\n\n'),
  ].join('\n')
}

/** The writer's prompt for one winning posting: the scorer's verdict, then the posting. */
export function renderJobBriefPrompt(
  search: Pick<JobSearch, 'label'>,
  verdict: { fit: number; reason: string | null; mismatches: string[] | null },
  posting: ScorablePosting,
): string {
  return [
    `search: ${search.label}`,
    `fit: ${verdict.fit}/100`,
    `why it scored that: ${verdict.reason ?? '—'}`,
    `mismatches found: ${(verdict.mismatches ?? []).join('; ') || 'none'}`,
    '',
    renderPostingForScoring(posting),
  ].join('\n')
}

/** What the scorer returned for one posting, already validated against the batch. */
export interface ScoredVerdict {
  id: string
  fit: number
  reason: string
  mismatches: string[]
}

/**
 * Scores a whole batch against the CV. One call, retried.
 *
 * A failure here is expensive — the batch is the run's entire model spend, and
 * losing it means no jobs this cycle — so it retries and then returns an empty
 * list rather than throwing. Empty leaves every posting **unscored**, not scored
 * at zero, so the next run picks them all up. "The model failed" and "none of
 * these are any good" must never be the same value.
 */
export async function scoreBatch(
  mastra: Mastra,
  prompt: string,
  batchIds: Set<string>,
): Promise<ScoredVerdict[]> {
  const agent = mastra.getAgent(jobScorerId)
  const object = await withRetry<z.infer<typeof scoringSchema>>(
    jobPipeline.modelAttempts,
    () => agent.generate(prompt, { structuredOutput: { schema: scoringSchema } }),
    (attempt, error) =>
      mastra
        .getLogger()
        ?.warn(`Job scorer attempt ${attempt}/${jobPipeline.modelAttempts} failed`, error),
  )

  // Guard against a model echoing an id that was not in the batch, exactly as
  // the news ranker does.
  return (object?.verdicts ?? []).filter(verdict => batchIds.has(verdict.id))
}

/**
 * Writes the brief for one winning posting. Retried, then degraded.
 *
 * Returns null when every attempt failed. The caller falls back to the scorer's
 * own reason and mismatch list, which is a thinner message but a real one — the
 * posting has already been judged worth sending, and losing it because prose
 * generation failed would be the wrong trade.
 */
export async function writeJobBrief(
  mastra: Mastra,
  prompt: string,
): Promise<z.infer<typeof jobSummarySchema> | null> {
  const agent = mastra.getAgent(jobWriterId)
  return withRetry<z.infer<typeof jobSummarySchema>>(
    jobPipeline.modelAttempts,
    () => agent.generate(prompt, { structuredOutput: { schema: jobSummarySchema } }),
    (attempt, error) =>
      mastra
        .getLogger()
        ?.warn(`Job writer attempt ${attempt}/${jobPipeline.modelAttempts} failed`, error),
    // A brief carrying its own JSON debris is retried, not sent — the schema
    // accepts it because every field is still a string.
    brief =>
      leakedStructure([brief.summary, ...brief.fits, ...brief.watchOuts], Object.keys(jobSummarySchema.shape)),
  )
}
