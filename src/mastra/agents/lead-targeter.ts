import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { LEAD_SIGNAL_KINDS, leadPipeline } from '../../config/leads.js'
import { withRetry } from '../../services/structured-output.js'

/**
 * The one model call behind `/client`
 * ([ADR-0038](../../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
 *
 * It turns a sentence about who the reader wants to work with into the
 * `client_profiles` row a run reads. The job-side twin is `job-targeter.ts`, and
 * the mitigation for letting a model write configuration is the same one: the
 * command echoes every field straight back, so a wrong parse is visible in the
 * reply and saying it again more precisely overwrites the row.
 *
 * **What it does not do is as deliberate as what it does.** It never invents an
 * industry the reader did not name, and it never infers a service from the
 * portfolio — the same asymmetry ADR-0024 drew when it kept the CV out of the
 * job targeter. The portfolio may decide what is read first and how a lead
 * scores; it may not turn something the reader never said into a hard filter, or
 * a photographer who once shot a restaurant would find their prospecting
 * permanently narrowed to hospitality.
 *
 * **Everything it returns is English except `label`**, which is the one string a
 * human reads in a footer. Same rule, same reason: the rest is matched against
 * English pages and rendered into prompts.
 */

export const leadTargeterId = 'lead-targeter'

/**
 * Flat and small on purpose — smaller than `targetSchema`, because a client
 * profile has fewer things that can be a filter. Every field is either applied
 * in SQL or is prose that reaches the scoring prompt.
 */
export const clientSchema = z.object({
  slug: z.string(),
  label: z.string(),
  /** What the reader sells, in one line. English. */
  offer: z.string(),
  /** Buyer industries the reader named. Empty means any — the common answer. */
  industries: z.array(z.string()),
  /** Places, as the reader said them. Empty means anywhere. */
  locations: z.array(z.string()),
  /** A subset of `LEAD_SIGNAL_KINDS`. Empty means all of them. */
  signalKinds: z.array(z.string()),
  /** Terms that reject a company outright. */
  dealbreakers: z.array(z.string()),
  /** Smallest engagement worth the reader's time. Null when unstated. */
  minDealSize: z.number().nullable(),
  /** ISO code for `minDealSize`. Null when that is null. */
  currency: z.string().nullable(),
  /** Everything a filter cannot express, in the reader's own language. */
  notes: z.string(),
})

export type ParsedClient = z.infer<typeof clientSchema>

const targeter = new Agent({
  id: leadTargeterId,
  name: 'Lead Targeter',
  model: env.AVA_MODEL_LEAD_TARGETER,
  instructions: `
You turn one sentence about the clients a freelancer wants into a structured
profile used to find them.

The reader sells a service — visuals, photography, ad creative, copy, code,
consulting — and wants companies that might buy it. They will describe who they
want in their own words, in any language.

"slug" is short, lowercase, hyphenated, and describes the profile:
"dtc-skincare-brands", "seed-stage-saas", "local-restaurants". Two to four words.

"label" is a short human name for it, **in the reader's own language**, shown in
the footer of every lead it wins.

"offer" is what the reader sells, in one line, in English. Take it from what they
said. If they described only who they want and never what they do, write what
their request implies and keep it general — "product photography", "brand and ad
creative". Never guess a specialism they did not mention.

"industries" are the buyer sectors they named — "skincare", "fintech",
"restaurants". **Return an empty array unless they actually named one.** Most
people who sell a service sell it to everyone, and an industry they never said is
a filter that silently throws away most of their market.

"locations" are places they named, as they said them. Empty means anywhere, which
is the right answer for anyone working remotely.

"signalKinds" is which kinds of event should make a company surface, from exactly
this list: ${LEAD_SIGNAL_KINDS.join(', ')}.
- "funding" — the company raised money.
- "launch" — it shipped a product, opened a store, or announced something new.
- "hiring" — it is hiring for a role that implies it needs this kind of work.
- "rebrand" — it changed its identity or redesigned.
**Return an empty array unless the reader was specific**, which means all of
them. Only narrow when they clearly asked to: "only companies that just raised".

"dealbreakers" are things that rule a company out entirely — "agencies", "crypto",
"anything with under five employees". Short terms, English. Empty is normal.

"minDealSize" is a number only if they named a budget floor, with "currency" as
its ISO code. Both null otherwise. Never invent a floor: most people do not have
one, and a made-up number silently deletes their whole market.

"notes" is everything that matters but cannot be a filter — tone, the kind of
company they enjoy, what they are trying to move away from. The reader's own
language. This is read by the scoring model, so it is where nuance belongs.

Return valid values even when the request is vague. A short, honest profile with
empty arrays is far better than a confidently invented one: an empty array widens
the search, and a wrong entry deletes companies the reader never learns existed.
`.trim(),
})

export const leadTargeterAgents = { [leadTargeterId]: targeter }

/**
 * Parses one `/client` sentence into a row.
 *
 * Throws when every attempt fails, unlike the scorer — a command the reader is
 * waiting on must say it did not work rather than quietly writing a row built
 * from defaults. `signalKinds` is filtered to the known set here rather than
 * trusted, because it is the one field the model could return a plausible
 * invention for ("expansion", "layoffs") that would silently match nothing.
 */
export async function parseClient(mastra: Mastra, request: string): Promise<ParsedClient> {
  const agent = mastra.getAgent(leadTargeterId)
  const parsed = await withRetry<ParsedClient>(
    leadPipeline.modelAttempts,
    () => agent.generate(request, { structuredOutput: { schema: clientSchema } }),
    (attempt, error) =>
      mastra
        .getLogger()
        ?.warn(`Lead targeter attempt ${attempt}/${leadPipeline.modelAttempts} failed`, error),
  )

  if (!parsed) throw new Error('Could not parse that into a client profile')

  const known: readonly string[] = LEAD_SIGNAL_KINDS
  return {
    ...parsed,
    slug: slugify(parsed.slug),
    signalKinds: parsed.signalKinds.filter(kind => known.includes(kind)),
  }
}

/**
 * The slug, made safe for a primary key.
 *
 * The model is asked for this shape and usually produces it; this is what makes
 * it true. A slug with a space or a slash in it is a row nobody can `/unclient`.
 */
export function slugify(value: string): string {
  const cleaned = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned || 'clients'
}
