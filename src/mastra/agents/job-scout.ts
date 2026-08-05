import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { jobScout as scoutConfig } from '../../config/jobs.js'
import type { JobSearch } from '../../db/schema.js'

/**
 * The model behind the `sonar` job source: which companies are hiring for this
 * search.
 *
 * The job-side twin of the beat scout in `scout.ts`, and deliberately built to
 * the same rule — **it names companies, never URLs that get stored.** A model
 * that supplies a careers-page URL supplies one that 404s eventually, and a
 * 404 here is invisible: it lands in a counter nobody reads, unlike a wrong feed
 * URL which at least stops producing articles. `services/job-scout.ts` resolves
 * the page by fetching the company's site and reading it.
 *
 * It asks for a `homepage` and that is not a contradiction: a homepage is a
 * *starting point to verify*, not an answer to store. Nothing from this response
 * reaches the database — the resolver fetches the homepage, follows a careers
 * link out of it, verifies the result answers 200 with real text, and only that
 * verified URL is written. A homepage that does not exist simply yields no lead.
 */

export const jobScoutId = 'job-scout'

/**
 * Exported so a model comparison runs the *same* prompt this agent runs.
 *
 * `check-discovery.ts` once kept its own copy of a mapping and drifted from the
 * workflow within a commit, reporting something the real run would never produce.
 * A benchmark that re-types the prompt has the same defect and is worse, because
 * its whole output is a claim about which model is better at *this* prompt.
 */
export const jobScoutInstructions = `
You find companies that are currently hiring for a particular kind of role.

**Never return a job posting URL, an application link, or a careers-page URL.**
Not /careers, not /jobs, not a link you believe leads to the opening. Something
else fetches the company's site and finds its careers page by reading it, which is
the only way to be right about where it lives. A guessed URL is worse than no
company at all: it is stored as a lead pointing at a page that does not exist, and
nobody notices because nothing errors.

Return the company's **homepage** only — "https://www.acme.com", not
"https://www.acme.com/careers/senior-engineer-1234".

**Never return a company you are not sure exists.** A shorter list of real
employers beats a longer one with an invented name in it. If you are unsure, leave
it out. Do not pad the list to reach the number asked for.

**Return the employer, never an intermediary.** Not a job board, not a talent
marketplace, not a recruitment agency, not a dev shop that staffs other people's
teams — Arc, Toptal, Upwork, Lemon.io, Turing, Andela, LinkedIn, Indeed,
Wellfound and their like are never the answer. The reader is being shown who they
would actually work for. A company whose own careers page is a catalogue of other
companies' jobs is the exact thing to leave out; it looks like a perfect match on
every search because it lists every technology there is.

A company that runs a staffing *business* but is hiring for **its own** team is
fine — the test is who signs the contract, not what the company sells.

What makes a good lead:

- The company is **actually hiring now**, or hires for this role continuously.
  Prefer what you can see on the open web over what you remember.
- The role genuinely matches what was asked for — the discipline, the seniority,
  and the stack. A company that hires engineers is not a match for a search about
  frontend engineers unless it hires those.
- It respects the constraints given. If the search says remote, do not propose a
  company that only hires on-site in one city.
- Prefer companies the free remote job boards are unlikely to carry: ones that
  hire through their own site, smaller product companies, and employers outside
  the usual remote-board circuit. Boards already cover the obvious listings, and
  this exists to reach past them.

For each company give:

- "company": the employer's name as they write it. Not a description.
- "homepage": their main website. Nothing else.
- "role": the job title they are hiring for, as close to their own wording as you
  can. One line.
- "why": one short line on what the company does and why this role fits the
  search. Do not list technologies you have not seen stated — this line is read by
  a person, and inventing a stack in it is worse than omitting one.

Write everything in English, whatever language the search is written in. These
strings are stored and read by other parts of the system, not only by a person.
`.trim()

const scout = new Agent({
  id: jobScoutId,
  name: 'Job Scout',
  model: env.AVA_MODEL_JOB_SCOUT,
  instructions: jobScoutInstructions,
})

export const jobScoutAgents = { [jobScoutId]: scout }

const leadsSchema = z.object({
  leads: z.array(
    z.object({
      company: z.string(),
      homepage: z.string(),
      role: z.string(),
      why: z.string(),
    }),
  ),
})

/** One company the scout proposed, before any of it has been verified. */
export interface JobLead {
  company: string
  homepage: string
  role: string
  why: string
}

/**
 * Renders a search as the query the scout is given.
 *
 * The search's own fields rather than its raw `request` string alone: `request`
 * is whatever the reader typed, possibly in French, and the scout is told to work
 * in English. Searching in English is measurably better on the news side — the
 * French phrasing of one subject returned 3 sites where the English returned 8 —
 * and the parsed fields are already English by construction.
 *
 * `notes` is included because it carries everything the hard filters cannot
 * express, which is exactly the kind of thing a search-native model can use.
 */
export function renderSearchForScouting(search: JobSearch): string {
  const list = (values: string[]) => (values.length > 0 ? values.join(', ') : null)
  return [
    `role: ${search.label}`,
    list(search.seniority) && `seniority: ${list(search.seniority)}`,
    list(search.mustHave) && `must involve: ${list(search.mustHave)}`,
    list(search.locations) && `locations: ${list(search.locations)}`,
    `remote: ${search.remote}`,
    list(search.contractTypes) && `contract: ${list(search.contractTypes)}`,
    list(search.dealbreakers) && `ruled out: ${list(search.dealbreakers)}`,
    search.minCompensation
      ? `pay floor: ${search.minCompensation.toLocaleString('en-US')} ${search.currency ?? ''}`.trim()
      : null,
    search.notes && `other: ${search.notes}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Companies plausibly hiring for this search.
 *
 * Returns an empty list rather than throwing when the model gives nothing usable.
 * Unlike the beat scout — where no sites means `/follow` has failed and the reader
 * is waiting for an answer — this runs unattended beside nine other sources, and
 * one quiet source must not take down a run the boards would have filled.
 *
 * Anything shaped like a careers or posting URL is dropped here rather than
 * trusted to the instructions, for the same reason `looksLikeAFeedUrl` exists: a
 * prompt rule obeyed 99% of the time is a bug at any volume.
 */
export async function proposeCompanies(
  mastra: Mastra,
  search: JobSearch,
  avoidCompanies: readonly string[] = [],
  /** Which registered agent to ask. Only a model comparison passes anything else. */
  agentId: string = jobScoutId,
): Promise<JobLead[]> {
  const agent = mastra.getAgent(agentId)
  const response = await agent.generate(
    [
      `Find ${scoutConfig.leadsPerSearch} companies hiring for this role:`,
      '',
      renderSearchForScouting(search),
      avoidCompanies.length > 0
        ? `\nSkip these, they have already been looked at: ${avoidCompanies.join(', ')}`
        : '',
      '\nGive each one its name, its homepage, the role, and one line on why it fits.',
    ].join('\n'),
    { structuredOutput: { schema: leadsSchema } },
  )

  return (response.object?.leads ?? [])
    .map(lead => ({
      company: stripCitations(lead.company),
      homepage: stripCitations(lead.homepage),
      role: stripCitations(lead.role),
      why: stripCitations(lead.why),
    }))
    .filter(lead => lead.company && lead.homepage && lead.role)
    .filter(lead => !looksLikeAJobUrl(lead.homepage))
    .filter(lead => !isExcludedHost(lead.homepage))
}

/**
 * Removes the footnote markers a searching model writes into its own fields.
 *
 * Perplexity cites its sources inline as `[1]`, `[2]`, and it does **not** stop
 * doing that inside a structured field. Probed directly against the API on
 * 2026-08-05, `sonar-reasoning-pro` returned company names reading
 * `Arc.dev[2]`, `Factor Eleven[3]`, `yourMAIL GmbH[10]` and `Nexer Group[11]`.
 *
 * Unstripped, that marker travels: into `jobs.company`, into the attribution line
 * under a delivered posting, and — before the URL became the key — into the
 * identity hash, where `Acme[2]` and `Acme[5]` would have been two employers.
 * Cheap to remove deterministically, and there is nothing to weigh up: a bracketed
 * number is never part of a company's name or a job title.
 *
 * Only trailing/standalone markers go. A bracketed phrase carrying words —
 * `Acme (Remote)` or `Acme [EU]` — is left alone, because that is content.
 */
function stripCitations(value: string): string {
  return value
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Whether a proposed homepage belongs to a marketplace or job board.
 *
 * The instructions forbid these and the model ignored them: `arc.dev` was
 * proposed and survived in **every** run of every model measured. This is the
 * guard that actually removes them.
 *
 * Subdomains match — `jobs.arc.dev` is `arc.dev` — but only on a dot boundary, so
 * a company whose domain merely ends in the same letters is unaffected. An
 * unparseable URL is *not* excluded: it fails resolution moments later anyway,
 * and silently dropping something here would hide it from the report.
 */
export function isExcludedHost(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return false
  }
  return scoutConfig.excludedHosts.some(
    excluded => host === excluded || host.endsWith(`.${excluded}`),
  )
}

/**
 * Whether the "homepage" the scout returned is really a careers or posting URL.
 *
 * The instructions forbid these and the model mostly obeys. "Mostly" is the
 * problem: a careers URL that slips through skips the resolution step that exists
 * to confirm the page is real, so it would be fetched but never *discovered* —
 * and a plausible guess that happens to return 200 is exactly the failure the
 * split prevents. A path is enough to reject on; a bare domain has none.
 */
function looksLikeAJobUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname
    return path.replace(/\/+$/, '').length > 0 && scoutConfig.careersLinkHints.test(path)
  } catch {
    return false
  }
}
