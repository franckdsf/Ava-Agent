import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { jobCommands } from '../../config/jobs.js'
import { domainIds, isKnownDomain, knownSeniority, seniorityIds } from '../../config/job-taxonomy.js'
import { structured } from './structured.js'

/**
 * The one model call behind `/target`.
 *
 * It turns a sentence about the work the reader wants into the filters a
 * `job_searches` row is made of. Same shape as the beat namer
 * ([ADR-0020](../../../docs/decisions/0020-feed-discovery-from-a-subject.md)):
 * cheap, no search, one small object, and it exists because a phone is a bad
 * place to type structured syntax.
 *
 * **It is a model writing configuration, which this repo treats as a real risk.**
 * The mitigation is different from the rubric's, and stronger. A rubric's
 * mistakes hide behind the ranker's ±10 noise floor; these are deterministic
 * filters, and `/target` echoes every field straight back — so a wrong parse is
 * visible in the reply, and saying it again more precisely overwrites the row.
 * That is why this may write directly where `buildRubric` had to be a template.
 *
 * **Everything it returns is English except `label`.** Same rule as the namer,
 * and for the same reason: stored strings are read by a scoring model, matched
 * against English job postings, and rendered into prompts. `label` is the one
 * string a human reads in a message footer, so it follows the reader.
 */

export const jobTargeterId = 'job-targeter'

/**
 * Deliberately flat and small. Every field is either a filter applied in SQL or
 * the prose that reaches the scoring prompt — there is nothing here a later step
 * has to interpret, which is what keeps a bad parse visible rather than subtle.
 */
export const targetSchema = z.object({
  slug: z.string(),
  label: z.string(),
  /**
   * The field of work, from a closed set, or null.
   *
   * Validated against `DOMAINS` by `parseTarget` rather than trusted — a model
   * answering `"polymer science"` where the vocabulary says `chemistry` would
   * match no posting and filter nothing, silently. Same discipline as the news
   * ranker discarding an article id it was not given.
   */
  domain: z.string().nullable(),
  locations: z.array(z.string()),
  remote: z.enum(['required', 'preferred', 'onsite', 'any']),
  seniority: z.array(z.string()),
  contractTypes: z.array(z.string()),
  mustHave: z.array(z.string()),
  dealbreakers: z.array(z.string()),
  minCompensation: z.number().nullable(),
  currency: z.string().nullable(),
  notes: z.string(),
})

export type ParsedTarget = z.infer<typeof targetSchema>

const targeter = new Agent({
  id: jobTargeterId,
  name: 'Job Targeter',
  model: env.AVA_MODEL_JOB_TARGETER,
  /**
   * Low effort, latency-routed: the reader waits on `/target`. `pnpm bench
   * job-targeter` placed luna at `low` a little above luna off on the judge, at
   * the same wait — see `AVA_MODEL_JOB_TARGETER` for the model.
   */
  defaultOptions: {
    providerOptions: {
      openrouter: {
        reasoning: { effort: 'low' },
        provider: { sort: 'latency' },
      },
    },
  },
  instructions: `
You turn a sentence about the work someone wants into a structured job search.

The reader may write in any language. **Everything you return is English except
"label"**, which is shown back to them and follows their own language. This is
not a preference: these fields are matched against job postings written in
English and are rendered into a scoring prompt, so a French request produces
English filters.

Return:

- "slug": lowercase, hyphenated, at most 48 characters, naming the search the way
  a person would refer to it — "senior-frontend-paris", "remote-rust". Never a
  colon. Derive it from the role and the place, not from the whole sentence.
- "label": the search as a short phrase for a message footer, four to six words,
  in the reader's own language. "Senior frontend, Paris ou remote".
- "domain": the field of work, **exactly one of these strings** — ${domainIds().join(', ')}
  — or null. This is the coarsest filter there is: a posting recognised as
  belonging to a different field is dropped before anything reads it, so getting
  it wrong throws away everything they wanted. **Return null whenever the request
  does not clearly sit in one of those fields**, and null is a perfectly good
  answer — it means "do not filter on this", and a search that filters on no
  field still works. Never stretch a request to fit: a request about marketing,
  architecture or journalism is null, not the closest listed field. Judge it from
  the work described, not from a passing mention — someone who wants a chemistry
  role at a software company is "chemistry".
- "locations": place names they named, as they would appear in a posting —
  "Paris", "Île-de-France", "Germany", "EU". Empty if they named none. Do **not**
  put "remote" here; that is the next field.
- "remote": "required" if they will only take remote work, "onsite" if they will
  only take on-site, "preferred" if they said they would rather have remote but
  did not rule out an office, "any" if they did not say. Most requests are "any";
  do not read a preference into silence.
- "seniority": the bands that fit, **exactly these strings** — ${seniorityIds().join(', ')}.
  Usually one or two. A director, head of or VP role is "manager". Empty if they did not say — an empty list
  means "do not filter on this", which is very different from guessing.
- "contractTypes": from permanent, contract, freelance, internship,
  apprenticeship. Empty if they did not say.
- "mustHave": terms a posting must mention — languages, frameworks, domains.
  A posting is kept if it mentions **any one** of them, and thrown away before
  anything reads it if it mentions none. So this is a list of alternatives, not
  a list of requirements: "Go or Rust" is ["Go", "Rust"], and someone who needs
  TypeScript *and* React gets the more specific one, with the other in "notes".
  **Keep this short, three or four at most.** Put the one or two that really are
  non-negotiable here and let the rest go to "notes".
- "dealbreakers": terms that reject a posting outright — "consulting", "agency",
  "on-call", a named company. Only things they actually ruled out.
- "minCompensation": annual figure as a plain number, or null. "90k" is 90000.
  Null unless they named one; most postings do not state pay, so this filter
  removes far more than a reader expects.
- "currency": ISO code for that figure — "EUR", "USD", "GBP" — or null.
- "notes": everything they said that no filter above can express, in one or two
  sentences. Team size, the kind of product, wanting to avoid management, wanting
  more mentoring, a domain they care about. This is read by the model that scores
  each posting, so write it as a description of what would suit them. Empty
  string if there is nothing left over.

Two rules that matter more than the rest:

**Do not invent a constraint they did not state.** An empty list means "do not
filter on this" and is almost always the right answer for anything they did not
mention. A reader who said "senior frontend, Paris" wants seniority and location
filtered and nothing else — inventing "permanent" or "React" silently throws away
most of what they would have wanted to see.

**Prefer "notes" over a filter when you are unsure.** A wrong entry in "mustHave"
or "dealbreakers" removes postings before anyone reads them, and the reader never
learns what they missed. The same words in "notes" only shift a score. When a
requirement is soft, vague, or one you are guessing at, it belongs in "notes".
`.trim(),
})

export const advisorId = 'job-target-advisor'

export const adviceSchema = z.object({
  /** One sentence on what the current target will and won't do. */
  diagnosis: z.string(),
  /** A complete `/target …` line, ready to paste. */
  suggestion: z.string(),
})

/**
 * Suggests a tighter target when the reader's was too loose to filter anything.
 *
 * **This is the one place the CV is allowed to shape a search, and only as a
 * suggestion the reader chooses to send.** The targeter itself never sees it: it
 * produces *hard filters*, and a filter inferred from what someone has done
 * rather than from what they asked for silently discards postings they would
 * have wanted — a Rust founding-engineer role thrown away because the CV says
 * React. Here the reader reads the suggestion, decides, and pastes it or does
 * not, which puts the inference under their eye instead of under the filter.
 *
 * Shares `AVA_MODEL_JOB_TARGETER` rather than earning its own variable. It is a
 * far larger call — the whole CV — but it fires only when a target is loose,
 * which is a handful of times ever, and splitting the knob would imply the two
 * can be tuned apart when nothing has yet suggested they should.
 */
const advisor = new Agent({
  id: advisorId,
  name: 'Job Target Advisor',
  model: env.AVA_MODEL_JOB_TARGETER,
  /**
   * Shares the targeter's model by design, and moved with it to gpt-5.6-luna
   * on 2026-10-12 — **not benched itself**, so no effort is
   * set and the provider's default applies. Routed by price: it follows a
   * `/target` that already answered, so nobody is waiting on this one.
   */
  defaultOptions: {
    providerOptions: {
      openrouter: {
        provider: { sort: 'price' },
      },
    },
  },
  instructions: `
You help someone tighten a job search that is currently too vague to filter
anything out.

You are given their CV and the search they just saved, already parsed into
filters. The problem is always the same: too few of the filters are set, so
almost every posting on every board survives and the expensive judging step gets
spent on obvious non-matches.

Return two things:

- "diagnosis": one sentence, addressed to them, saying what their current target
  will let through. Concrete — "this matches every remote role on every board,
  including sales and support" — not "your target is vague".
- "suggestion": a complete command line starting with "/target ", written in
  **their own language**, that they could paste as-is.

What makes a good suggestion:

- **Keep what they actually asked for.** If they said founding engineer at an
  early-stage startup, the suggestion is still that. You are adding precision,
  not changing the subject.
- **Add the things their CV can justify** — the stack they have actually shipped,
  the seniority their experience supports, the places they say they work. Two or
  three technologies at most: each one is a hard filter, and a posting that fails
  to name it is thrown away unread.
- **Add nothing the CV does not support and they did not say.** No invented pay
  floor, no invented contract type, no company they never mentioned.
- Keep it one readable sentence. This is something a person types, not a query
  language.

Write the diagnosis in their language too — match whatever their request was
written in.
`.trim(),
})

export const jobTargeterAgents = { [jobTargeterId]: targeter, [advisorId]: advisor }

/**
 * Asks for a tighter target. Returns null on any failure.
 *
 * Advice is a nicety on top of a command that has already succeeded, so it never
 * throws and never blocks the reply: a search is saved whether or not this
 * works.
 */
export async function suggestTighterTarget(
  mastra: Mastra,
  cv: string,
  parsed: ParsedTarget,
  request: string,
): Promise<z.infer<typeof adviceSchema> | null> {
  try {
    const agent = mastra.getAgent(advisorId)
    return await structured(
      agent,
      [
        '## Their CV',
        cv,
        '',
        '## What they typed',
        request,
        '',
        '## What it parsed to',
        JSON.stringify(parsed, null, 2),
      ].join('\n'),
      adviceSchema,
      { attempts: 1 },
    )
  } catch {
    return null
  }
}

/**
 * Parses a request into a search definition.
 *
 * Resolved through `mastra.getAgent` rather than by importing the agent, so the
 * call shows up in Studio like every other model call here.
 *
 * Throws when the model returns nothing parseable. The caller answers with the
 * usage line — "the model returned junk" and "you typed something unusable" look
 * identical to the reader and lead to the same next action, which is to say it
 * again.
 */
export async function parseTarget(mastra: Mastra, request: string): Promise<ParsedTarget> {
  const agent = mastra.getAgent(jobTargeterId)
  const object = await structured(agent, request.slice(0, jobCommands.requestMaxChars), targetSchema, {
    attempts: 1,
    orThrow: 'The targeter returned no parseable object',
  })

  // A domain the vocabulary does not know is dropped to null rather than stored.
  // Storing it would filter on a value nothing can ever match — which does not
  // error, it just quietly rejects every posting that names any field at all,
  // and the reader sees a search that found nothing rather than a broken one.
  const domain = isKnownDomain(object.domain) ? object.domain : null
  // The same discipline for seniority. The prompt used to offer "director",
  // which `SENIORITY` does not have: a band the filter cannot match drops every
  // posting whose title names a different level, silently.
  return { ...object, domain, seniority: knownSeniority(object.seniority) }
}
