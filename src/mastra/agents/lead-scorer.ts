import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { LEAD_SIGNAL_LABELS, leadPipeline, type LeadSignalKind } from '../../config/leads.js'
import type { ClientProfile, Lead, LeadSignal } from '../../db/schema.js'
import { leakedStructure } from '../../services/structured-output.js'
import { structured } from './structured.js'

/**
 * The three model calls the leads pipeline makes about a company
 * ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
 *
 * They are one file because they are one sequence — score the batch cheaply,
 * look at the images of what survived, then write what the reader reads — and the
 * order is the cost control. The same arrangement `job-scorer.ts` uses for its
 * scorer and writer pair.
 *
 * **The line between the second and the first is the one to preserve.** The
 * scorer is one call for the whole batch; vision is one call *per surviving
 * lead*, against the most expensive model in the repo. Anything that moves vision
 * earlier — scoring with images, filtering on a visual judgement — turns an
 * unbounded intake into an unbounded bill, which is the failure
 * [invariant 2](../../AGENTS.md#invariants) exists to prevent.
 */

export const leadScorerId = 'lead-scorer'
export const leadVisionId = 'lead-vision'
export const leadWriterId = 'lead-writer'

export const leadScoringSchema = z.object({
  verdicts: z.array(
    z.object({
      /** The lead id exactly as given. Validated against the batch by the caller. */
      id: z.string(),
      /** 0–100. Anchored in the instructions. */
      fit: z.number(),
      /** At most 20 words, concrete, about this company. */
      reason: z.string(),
      /** Named axes where it falls short. */
      mismatches: z.array(z.string()),
    }),
  ),
})

export const leadVisionSchema = z.object({
  /**
   * What the images actually show, in two or three sentences. Descriptive
   * first — the judgement is worth nothing if it is not anchored to what is
   * there.
   */
  observation: z.string(),
  /**
   * Whether there is real room for the reader's service. The scorer's fit is
   * already decided; this adjusts it, and the caller bounds by how much.
   */
  opportunity: z.enum(['strong', 'some', 'little', 'none']),
  /** One concrete thing the reader could improve. The seed of the outreach line. */
  angle: z.string(),
})

export const leadBriefSchema = z.object({
  /** Why this company, why now. Two or three sentences. */
  summary: z.string(),
  /** The opening line the reader could actually send. One or two sentences. */
  angle: z.string(),
  /** Concrete reasons to hesitate. May be empty. */
  watchOuts: z.array(z.string()),
})

const scorer = new Agent({
  id: leadScorerId,
  name: 'Lead Scorer',
  model: env.AVA_MODEL_LEAD_SCORER,
  /**
   * Low effort, routed by price — chosen by analogy with the job scorer, not
   * measured here (the lead tables were empty when the bench ran): same shape,
   * one batch judged against a whole portfolio, and on the job side `pnpm bench
   * job-scorer` found reasoning off clearly worse at exactly that.
   */
  defaultOptions: {
    providerOptions: {
      openrouter: {
        reasoning: { effort: 'low' },
        provider: { sort: 'price' },
      },
    },
  },
  instructions: `
You judge whether a company is worth approaching by one specific freelancer or
studio, whose portfolio you are given in full.

You will be given their portfolio, one saved client profile describing who they
want to work with, and a numbered batch of companies. Each company comes with a
**signal** — a dated public event, such as a funding round, a product launch, a
rebrand, or a role they are hiring for — and an excerpt of their own website.

Return one verdict per company, using the id exactly as given. Never invent an
id, never return one twice, and never skip one: a company you cannot judge scores
low with a reason saying so.

**You are judging need and timing, not capability.** Assume the reader can do the
work — they only prospect for what they sell. The question is whether this
company plausibly needs it, has the money for it, and has a reason to be thinking
about it *this month*.

"fit" is 0–100:

- **85–100** — the signal directly implies the reader's service is needed now.
  They raised and are visibly scaling, or launched something the reader's craft
  would obviously serve, and the company is the right size to buy it.
- **70–84** — a real opportunity with one reservation: the timing is slightly
  off, the fit is adjacent rather than exact, or the company may already have
  this covered in-house.
- **50–69** — plausible but weak. The signal is routine, or the company is the
  wrong size, or nothing connects the event to the reader's work.
- **20–49** — a real company with no visible need for this service.
- **0–19** — wrong entirely: a competitor, an agency selling the same thing, a
  company far too large to buy from a freelancer, or not a business at all.

**The signal is the strongest evidence you have, and its age matters.** A funding
round announced last week is a far better reason to make contact than the same
round two months ago, because by then everyone has already written to them. Say
so in the reason when it is what decides the score.

**Score down companies that plainly already do this well.** A brand whose site
says it has an in-house studio does not need one. A company whose own product
*is* the reader's service is a competitor, not a client.

"reason" is at most 20 words, concrete, and about *this* company. "Good potential
client" is not a reason. "Raised 4M last week, ships DTC skincare, product shots
are supplier stock" is.

"mismatches" names the axes where it falls short, one short phrase each, from:
timing, budget, need, size, reachability, competitor. Give the axis and the
specifics — "size: 2000 employees, has an in-house team", "timing: launch was
four months ago". **Return them for high scorers too** — every approach has
something worth knowing before it is sent, and this is the only place it is
recorded.

Write every verdict in English, whatever language the page is in. These are
stored and read by other parts of the system, not only by a person.
`.trim(),
})

/**
 * Looks at a lead's own images.
 *
 * Its instructions are deliberately narrow: describe, then judge, then propose
 * one thing. A vision model given a broad brief writes an essay about brand
 * strategy, which is neither checkable nor sendable.
 */
const vision = new Agent({
  id: leadVisionId,
  name: 'Lead Vision',
  model: env.AVA_MODEL_LEAD_VISION,
  /**
   * Reasoning off, routed by price — a choice, not a measurement: describing
   * what a site's images look like is closer to the writers, where `pnpm bench`
   * found reasoning bought nothing, than to the scorers.
   */
  defaultOptions: {
    providerOptions: {
      openrouter: {
        reasoning: { enabled: false },
        provider: { sort: 'price' },
      },
    },
  },
  instructions: `
You look at the images on a company's own website and judge whether a specific
visual professional — a photographer, an ad creative, a designer — could make
them meaningfully better.

You are given what that person does, and a handful of images taken from the
company's page in document order. These are usually the hero image and the first
product or feature shots.

**Describe before you judge.** "observation" says what is actually there: what the
images are of, how they are lit and composed, whether they look like original art
direction, supplier stock, screenshots, or generic stock photography. Someone who
cannot see the images must be able to picture them from your description. If the
images are unreadable, tiny, or clearly not the company's own work, say that
instead of guessing.

"opportunity" is how much room there genuinely is for this person's work:

- **strong** — the visuals are plainly below what this company's positioning
  needs. Supplier stock on a premium brand, inconsistent lighting across a
  product range, obvious generic stock photography on a funded company.
- **some** — competent but unremarkable, or good in places and weak in others.
- **little** — solid work already, with only marginal gains available.
- **none** — excellent, clearly art-directed, or the images are not the kind of
  thing this person works on at all.

**Be honest about "none" and "little".** An approach sent to a company whose
visuals are already excellent costs the reader their credibility, and that is a
worse outcome than a lead they never heard about. Do not manufacture a problem to
be helpful.

"angle" is one concrete, specific thing this person could improve — the sentence
a good approach would open with. Name what you saw. "Improve their visuals" is
useless. "The three product shots are lit differently, so the range looks
inconsistent on the collection page" is the whole point.

Never mention prices, never write a full sales message, and never claim to know
anything about the company that is not visible in these images.
`.trim(),
})

const writer = new Agent({
  id: leadWriterId,
  name: 'Lead Writer',
  model: env.AVA_MODEL_LEAD_WRITER,
  /**
   * Reasoning off, routed by price — by analogy with the job writer, the same
   * model writing the same kind of brief: `pnpm bench job-writer` measured off
   * level with the default at half the latency, and the default leaked JSON
   * into a field. Not measured on leads.
   */
  defaultOptions: {
    providerOptions: {
      openrouter: {
        reasoning: { enabled: false },
        provider: { sort: 'price' },
      },
    },
  },
  instructions: `
You write the short brief a person reads on their phone about one company that
might want to hire them.

You are given the company, the signal that made it worth surfacing, the verdict a
scorer already reached — its fit score, its one-line reason, its mismatches — and
sometimes a note about what the company's images look like. Turn that into
something readable. **Do not re-judge it.** The score is decided; you are
explaining it.

"summary" is two or three sentences: who this company is, what just happened, and
why that makes them worth a message now. Lead with the event — it is the reason
this is on the reader's phone today rather than last month.

"angle" is the opening the reader could actually send. One or two sentences, in
their voice, specific to this company. It must reference something real from the
signal or the page — a good opening proves it was written for them, and a
paragraph that would work for any company is worse than nothing because it reads
as a mail merge. Never invent a fact to make it land; if you only have the signal
to work with, write from the signal.

**Do not write a full sales email**, do not mention prices, and never claim the
reader has already worked with a similar company unless told so.

"watchOuts" carries the mismatches as short readable phrases — a reason to
hesitate, a thing to check before writing. Empty is allowed but rare.

Write in the reader's own language when the client profile is written in it,
otherwise in English.
`.trim(),
})

export const leadAgents = {
  [leadScorerId]: scorer,
  [leadVisionId]: vision,
  [leadWriterId]: writer,
}

export interface LeadVerdict {
  id: string
  fit: number
  reason: string
  mismatches: string[]
}

/**
 * The batch scoring prompt: the portfolio once, the profile once, then every
 * candidate.
 *
 * The portfolio enters **once for the whole batch**, which is the entire reason
 * the scorer is a batch call — the same argument ADR-0024 makes for the job
 * scorer, where a per-posting call would have put a 20k-token document in front
 * of the model forty times.
 *
 * This and the two renderers below sit beside the agents rather than in the
 * workflow, so anything that has to send a model exactly what a run sends —
 * `pnpm bench` swapping only the model — builds it from the same function.
 */
export function renderLeadScoringPrompt(
  portfolio: string,
  profile: ClientProfile,
  entries: { signal: LeadSignal; lead: Lead }[],
): string {
  const candidates = entries.map(entry => {
    const age = Math.round((Date.now() - entry.signal.occurredAt) / 86_400_000)
    return [
      `id: ${entry.signal.id}`,
      `company: ${entry.lead.company}`,
      `site: ${entry.lead.url}`,
      `location: ${entry.lead.location ?? 'unstated'}`,
      `signal: ${LEAD_SIGNAL_LABELS[entry.signal.kind as LeadSignalKind] ?? entry.signal.kind} — ${entry.signal.summary}`,
      `signal age: ${age} day${age === 1 ? '' : 's'}`,
      `their page says: ${(entry.lead.pageText ?? '').slice(0, leadPipeline.scorerPageChars)}`,
    ].join('\n')
  })

  return [
    "THE READER'S PORTFOLIO",
    portfolio,
    '',
    'WHO THEY WANT TO WORK WITH',
    `label: ${profile.label}`,
    `they sell: ${profile.offer}`,
    `in their words: ${profile.request}`,
    `industries: ${profile.industries.join(', ') || 'any'}`,
    `locations: ${profile.locations.join(', ') || 'anywhere'}`,
    `minimum engagement: ${profile.minDealSize ? `${profile.minDealSize} ${profile.currency ?? ''}`.trim() : 'unstated'}`,
    `notes: ${profile.notes || '—'}`,
    '',
    `COMPANIES TO JUDGE (${entries.length})`,
    candidates.join('\n\n---\n\n'),
  ].join('\n')
}

/** The text that goes with one lead's images. The images themselves are attached by `judgeLeadVisuals`. */
export function renderLeadVisionPrompt(profile: Pick<ClientProfile, 'offer'>, lead: Pick<Lead, 'company' | 'url'>): string {
  return [
    `What this person sells: ${profile.offer}`,
    `The company: ${lead.company} (${lead.url})`,
    '',
    'Look at the images from their page and answer the schema.',
  ].join('\n')
}

/** The writer's prompt for one winning lead: the verdict, the signal, what the images showed, the page. */
export function renderLeadBriefPrompt(
  profile: Pick<ClientProfile, 'label' | 'offer'>,
  verdict: { fit: number; reason: string; mismatches: string[] },
  signal: Pick<LeadSignal, 'kind' | 'summary' | 'occurredAt'>,
  lead: Pick<Lead, 'company' | 'url' | 'pageText'>,
  visual: string | null,
): string {
  return [
    `client profile: ${profile.label}`,
    `what you sell: ${profile.offer}`,
    `fit: ${verdict.fit}/100`,
    `why it scored that: ${verdict.reason || '—'}`,
    `mismatches found: ${verdict.mismatches.join('; ') || 'none'}`,
    `signal: ${LEAD_SIGNAL_LABELS[signal.kind as LeadSignalKind] ?? signal.kind} — ${signal.summary}`,
    `signal seen: ${new Date(signal.occurredAt).toISOString().slice(0, 10)}`,
    ...(visual ? [`what their images look like: ${visual}`] : []),
    '',
    `company: ${lead.company}`,
    `site: ${lead.url}`,
    `their page says: ${(lead.pageText ?? '').slice(0, leadPipeline.scorerPageChars)}`,
  ].join('\n')
}

/**
 * Scores a whole batch against the portfolio, on text alone. One call, retried.
 *
 * Returns an empty list rather than throwing, exactly as `scoreBatch` does: empty
 * leaves every lead **unscored** rather than scored at zero, so the next run
 * picks them all up. "The model failed" and "none of these are any good" must
 * never be the same value — and here the distinction also decides whether any
 * vision call is made at all.
 */
export async function scoreLeadBatch(
  mastra: Mastra,
  prompt: string,
  batchIds: Set<string>,
): Promise<LeadVerdict[]> {
  const agent = mastra.getAgent(leadScorerId)
  const object = await structured(agent, prompt, leadScoringSchema, {
    attempts: leadPipeline.modelAttempts,
    onAttemptFailed: (attempt, error) =>
      mastra
        .getLogger()
        ?.warn(`Lead scorer attempt ${attempt}/${leadPipeline.modelAttempts} failed`, error),
  })

  // Guard against a model echoing an id that was not in the batch, as the job
  // scorer and the news ranker both do.
  return (object?.verdicts ?? []).filter(verdict => batchIds.has(verdict.id))
}

/**
 * Looks at one lead's images. **One call per lead, never batched.**
 *
 * Not batched deliberately: images from two companies in one prompt invite a
 * verdict that blends them, and the failure is invisible — a plausible paragraph
 * about the wrong company's photographs. The cost of the split is bounded by
 * `leadPipeline.maxVisionCallsPerRun`, which the caller enforces.
 *
 * Returns null when every attempt failed, and the caller carries on without it.
 * A lead that already cleared the text score is worth sending with a thinner
 * message; losing it because an image fetch timed out would be the wrong trade.
 */
export async function judgeLeadVisuals(
  mastra: Mastra,
  prompt: string,
  imageUrls: string[],
): Promise<z.infer<typeof leadVisionSchema> | null> {
  const agent = mastra.getAgent(leadVisionId)
  const message = {
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: prompt },
      ...imageUrls.map(url => ({ type: 'image' as const, image: url })),
    ],
  }

  return structured(agent, [message], leadVisionSchema, {
    attempts: leadPipeline.modelAttempts,
    onAttemptFailed: (attempt, error) =>
      mastra
        .getLogger()
        ?.warn(`Lead vision attempt ${attempt}/${leadPipeline.modelAttempts} failed`, error),
  })
}

/**
 * Writes the brief for one winning lead. Retried, then degraded.
 *
 * Returns null when every attempt failed; the caller falls back to the scorer's
 * own reason and mismatch list. Thinner, but real — the lead has already been
 * judged worth sending.
 */
export async function writeLeadBrief(
  mastra: Mastra,
  prompt: string,
): Promise<z.infer<typeof leadBriefSchema> | null> {
  const agent = mastra.getAgent(leadWriterId)
  return structured(agent, prompt, leadBriefSchema, {
    attempts: leadPipeline.modelAttempts,
    onAttemptFailed: (attempt, error) =>
      mastra
        .getLogger()
        ?.warn(`Lead writer attempt ${attempt}/${leadPipeline.modelAttempts} failed`, error),
    // The guard the job and article writers carry: debris from a broken JSON
    // answer is retried, not sent, since the schema sees only strings.
    reject: brief =>
      leakedStructure([brief.summary, brief.angle, ...brief.watchOuts], Object.keys(leadBriefSchema.shape)),
  })
}
