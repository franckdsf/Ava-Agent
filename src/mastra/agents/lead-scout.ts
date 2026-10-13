import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { LEAD_SIGNAL_KINDS, leadPipeline, leadScout } from '../../config/leads.js'
import type { ClientProfile } from '../../db/schema.js'
import { structured } from './structured.js'

/**
 * The model behind the `sonar` lead source: which companies just did something
 * that means they need what the reader sells
 * ([ADR-0039](../../../docs/decisions/0039-a-lead-scout-with-its-own-budget.md)).
 *
 * A separate agent from `job-scout.ts` rather than a flag on it, and the reason
 * is not tidiness — **one whole paragraph of that prompt inverts here.** The job
 * scout spends it refusing agencies, staffing firms and dev shops, because "the
 * reader is being shown who they would actually work for". For someone selling a
 * service, agencies are among the best clients there are: they subcontract
 * constantly and they buy on a schedule. A prompt whose central exclusion becomes
 * an inclusion is a different prompt.
 *
 * **It names companies and events. It never supplies a URL that gets stored.**
 * Same rule as every other scout in this repo
 * ([ADR-0020](../../../docs/decisions/0020-feed-discovery-from-a-subject.md),
 * [ADR-0026](../../../docs/decisions/0026-sonar-as-a-job-source.md)): a homepage
 * and an announcement link are *starting points to verify*, and
 * `services/lead-scout.ts` fetches both. A guessed URL never errors — it becomes
 * a lead pointing at a page that does not exist, and nobody notices.
 *
 * The stakes are higher here than on the job side, and worth stating plainly:
 * *"is this company hiring"* is checkable against a careers page, while *"does
 * this company need better photography"* is checkable against nothing. So the
 * verifiable part — the company exists, at this domain, and this announcement is
 * real — is the only part allowed to be load-bearing.
 */

export const leadScoutId = 'lead-scout'

/** One proposed company, before anything about it has been checked. */
export const prospectSchema = z.object({
  prospects: z.array(
    z.object({
      /** The company's name, as it writes it. */
      company: z.string(),
      /** Homepage only — a starting point to verify, never stored as given. */
      homepage: z.string(),
      /** One of `LEAD_SIGNAL_KINDS`. */
      signalKind: z.string(),
      /** What happened, in one line. English. */
      what: z.string(),
      /** Where it was announced. Verified by code; the lead is dropped if it is not real. */
      sourceUrl: z.string(),
      /** Roughly when, as `YYYY-MM-DD`. Used for recency, so precision matters. */
      occurredOn: z.string(),
      /** Where they are, if it is knowable. Empty string when not. */
      location: z.string(),
    }),
  ),
})

export type ProposedProspect = z.infer<typeof prospectSchema>['prospects'][number]

const scout = new Agent({
  id: leadScoutId,
  name: 'Lead Scout',
  model: env.AVA_MODEL_LEAD_SCOUT,
  instructions: `
You find companies that have recently done something which means they now need a
particular service — so that a freelancer or a small studio can approach them
while the need is fresh.

**Search the open web for each answer.** Prefer what you can see published in the
last few weeks over what you remember. A company that raised in 2023 is not news,
and a stale lead is worse than no lead: the reader will write to them saying
"congratulations on the round" months late.

**Never return a URL you are not sure exists.** Something else fetches the
company's site and the announcement you cite, and requires both to answer with
real content, so a guessed link produces nothing. Return the company's
**homepage** — "https://www.acme.com", not a deep link — and the announcement's
own page as "sourceUrl".

**Never return a company you are not sure exists.** A shorter list of real
companies beats a longer one with an invented name in it. Do not pad to reach the
number asked for.

**Agencies, studios and consultancies ARE valid prospects.** This is the opposite
of what you may assume. The reader sells a service, and agencies subcontract
constantly — a growing agency is often a better client than a brand, because they
buy repeatedly and they already understand the work. Only exclude a company when
it plainly *sells the same service the reader sells* and would be a competitor
rather than a customer.

What makes a good prospect:

- **The event is real, recent and public**, and you can name where it was
  announced. Funding rounds, product launches, store openings, rebrands, market
  entries, and hiring that implies the need.
- **The event plausibly creates the need.** A skincare brand that just raised
  needs product photography; a B2B database company that just raised probably
  does not need a food photographer. Say the connection in "what" — if you cannot
  state it, this is not a lead.
- **The company is the right size to buy from an independent.** A company of five
  has no budget; a company of fifty thousand has a procurement process and an
  in-house team. Prefer the middle.
- **They can be reached.** A company with a real website and a public presence,
  not a stealth startup with a landing page.

"signalKind" must be exactly one of: ${LEAD_SIGNAL_KINDS.join(', ')}.
- "funding" — raised money.
- "launch" — shipped a product, opened a store, entered a market.
- "hiring" — hiring for a role that implies they need this work.
- "rebrand" — changed identity, redesigned, repositioned.

"occurredOn" is the date of the *event*, not of the article, as YYYY-MM-DD. If you
only know the month, use the first of it. Do not guess a date to make something
look recent — recency is scored, and a wrong date is worse than an honest old one.

"what" is one line, concrete and specific, naming the event and the amount or the
product where you know it. "Raised a $4M seed led by Redalpine to expand its DTC
skincare range" is useful. "Growing fast in a competitive space" is not.

Return every field in English, whatever language the sources are in.
`.trim(),
})

export const leadScoutAgents = { [leadScoutId]: scout }

/**
 * Asks for companies worth approaching for one client profile.
 *
 * Returns an empty list rather than throwing: this is one source among several
 * on a scheduled run, and a scout failure must not cost the run its other
 * signals.
 *
 * The prompt carries what the reader sells and who they want, and **not** the
 * portfolio. Same asymmetry the job targeter observes: the portfolio decides how
 * a lead scores once found, not which companies are allowed to be looked for —
 * putting it here would quietly narrow the search to the industries the reader
 * has already worked in, which is the opposite of prospecting.
 */
export async function proposeProspects(
  mastra: Mastra,
  profile: ClientProfile,
): Promise<ProposedProspect[]> {
  const agent = mastra.getAgent(leadScoutId)

  const kinds = profile.signalKinds.length > 0 ? profile.signalKinds : [...LEAD_SIGNAL_KINDS]
  const prompt = [
    `The reader sells: ${profile.offer}`,
    `In their words: ${profile.request}`,
    `Buyer industries: ${profile.industries.join(', ') || 'any — do not narrow to one'}`,
    `Where: ${profile.locations.join(', ') || 'anywhere'}`,
    `Events that count: ${kinds.join(', ')}`,
    `Avoid entirely: ${profile.dealbreakers.join(', ') || 'nothing named'}`,
    profile.notes ? `Also worth knowing: ${profile.notes}` : '',
    '',
    `Name up to ${leadScout.prospectsPerProfile} companies, each with the event that makes them worth approaching in the next few weeks.`,
    `Only events from the last ${leadPipeline.signalWindowDays} days.`,
  ]
    .filter(Boolean)
    .join('\n')

  const object = await structured(agent, prompt, prospectSchema, {
    attempts: leadPipeline.modelAttempts,
    onAttemptFailed: (attempt, error) =>
      mastra
        .getLogger()
        ?.warn(`Lead scout attempt ${attempt}/${leadPipeline.modelAttempts} failed`, error),
  })

  const known: readonly string[] = LEAD_SIGNAL_KINDS
  return (object?.prospects ?? []).filter(prospect => known.includes(prospect.signalKind))
}
