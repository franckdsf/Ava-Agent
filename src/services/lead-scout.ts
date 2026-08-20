import { leadPipeline, leadScout, type LeadSignalKind } from '../config/leads.js'
import type { ClientProfile } from '../db/schema.js'
import { htmlToText } from './article.js'
import { canonicalizeSourceUrl, normalizeCompanyName, normalizeHost } from './lead-identity.js'
import { isNotACompanyHost, type RawSignal } from './lead-signals.js'
import { fetchPage } from './page-fetch.js'
import type { ProposedProspect } from '../mastra/agents/lead-scout.js'

/**
 * The `sonar` lead source: companies from a model, evidence from the web
 * ([ADR-0039](../../docs/decisions/0039-a-lead-scout-with-its-own-budget.md)).
 *
 * The split is the same one
 * [ADR-0020](../../docs/decisions/0020-feed-discovery-from-a-subject.md) settled
 * for feeds and [ADR-0026](../../docs/decisions/0026-sonar-as-a-job-source.md)
 * repeated for careers pages. A model may say "Acme raised a seed round". It may
 * **not** say where Acme lives or where that was announced — those are facts
 * about servers, and the only way to know them is to ask.
 *
 * **Three gates, and a prospect that fails any of them is dropped rather than
 * stored with a fallback.** That rule is stricter here than anywhere else in the
 * repo, and deliberately so: *"is this company hiring"* can be checked against a
 * careers page, but *"does this company need better photography"* can be checked
 * against nothing at all. The only defence against an invented need is to be
 * ruthless about the parts that *are* checkable.
 *
 * 1. **The homepage answers with real text.** A parked domain, a 404 and a
 *    JavaScript shell all fail the floor.
 * 2. **The company's name appears on that page.** The gate a model cannot fake —
 *    see below.
 * 3. **The announcement it cited is real.** A funding claim with no reachable
 *    source is exactly the invented-need case.
 *
 * Nothing here writes. Every fetch is a plain GET with no conditional-request
 * state recorded, for the same reason `checkFeed()` does its own.
 */

/** What verification produced for one proposal. */
export interface ProspectResolution {
  signal: RawSignal | null
  /** Why it was dropped. Null on success. Counted, so a silent source is visible. */
  problem: string | null
}

/**
 * Verifies one proposal, or explains why it is not a lead.
 *
 * The name gate is the interesting one. A model that invents `acmeskincare.com`
 * will land on a parked domain, an SEO squat or an unrelated business often
 * enough to matter, and **every one of those answers 200 with plenty of text** —
 * so a length floor alone verifies nothing about identity. Requiring the company's
 * own name on its own homepage is cheap, has almost no false negatives (a company
 * that does not name itself on its front page is vanishingly rare), and turns
 * "this page belongs to that company" into a fact established by a server.
 *
 * Matched on the normalized name and on its first word, because a company writes
 * itself as "Acme" on the page and as "Acme Studio SAS" in a database — the same
 * looseness `normalizeCompany` applies on the job side, minus the suffix list
 * that ADR-0026 measured into the ground.
 */
export async function resolveProspect(prospect: ProposedProspect): Promise<ProspectResolution> {
  const host = normalizeHost(prospect.homepage)
  if (!host) return { signal: null, problem: 'homepage is not a usable URL' }
  if (isNotACompanyHost(host)) {
    return { signal: null, problem: `${host} is a board or a platform, not a company` }
  }

  const companyUrl = `https://${host}`
  const page = await fetchPage(companyUrl, {
    userAgent: leadPipeline.userAgent,
    timeoutMs: leadPipeline.pageTimeoutMs,
  })
  if (!page.ok || !page.html) return { signal: null, problem: `${host} did not answer` }

  const text = htmlToText(page.html)
  if (text.length < leadScout.minPageChars) {
    return { signal: null, problem: `${host} carried no readable text` }
  }

  if (leadScout.requireNameOnPage && !mentionsCompany(text, prospect.company)) {
    return { signal: null, problem: `${host} never names "${prospect.company}"` }
  }

  // The announcement. A signal is a claim about a dated public event, so a claim
  // with no reachable page behind it is the one most likely to have been
  // invented — dropped, never downgraded to the homepage.
  const sourceUrl = canonicalizeSourceUrl(prospect.sourceUrl)
  const source = await fetchPage(sourceUrl, {
    userAgent: leadPipeline.userAgent,
    timeoutMs: leadPipeline.pageTimeoutMs,
  })
  if (!source.ok || !source.html) {
    return { signal: null, problem: `the announcement for ${host} did not resolve` }
  }

  const occurredAt = parseEventDate(prospect.occurredOn)
  if (occurredAt === null) return { signal: null, problem: `unusable date for ${host}` }
  const age = Date.now() - occurredAt
  if (age > leadPipeline.signalWindowDays * 86_400_000) {
    return { signal: null, problem: `the event at ${host} is older than the window` }
  }
  // A date in the future is a model that guessed. Left as a drop rather than
  // clamped, because clamping would make a fabricated date look like a fresh one.
  if (age < -86_400_000) return { signal: null, problem: `${host} has a future-dated event` }

  return {
    signal: {
      leadId: host,
      company: cleanCompanyName(prospect.company),
      location: cleanScoutText(prospect.location, 60) || null,
      companyUrl,
      kind: prospect.signalKind as LeadSignalKind,
      sourceUrl,
      origin: 'sonar',
      occurredAt,
      // Cleaned rather than trusted: this string reaches the scorer's prompt and
      // the reader's screen, and the model puts its citation markers in it.
      summary: cleanScoutText(prospect.what, leadScout.maxSummaryChars),
    },
    problem: null,
  }
}

/**
 * Model prose, made safe to store and to show.
 *
 * **Measured on the first live run, not imagined.** `sonar-reasoning-pro` appends
 * its citation markers inline — a real summary came back ending
 * `…demand for additional product photography and ad assets.[24][23][29]` — and
 * that string is not a rendering artefact: it is written to
 * `lead_signals.summary`, put in front of the scorer, and printed in the message
 * the reader is meant to copy. The job scout never had to care because a posting's
 * description comes off a careers page rather than out of the model.
 *
 * The length cap is the same finding from the other end. One line was asked for
 * and a four-clause paragraph arrived; a summary is a message heading, and the
 * batch prompt carries one per candidate, so an unbounded field is both unreadable
 * and a per-run cost.
 *
 * Truncation is on a word boundary with an ellipsis, so a cut is visible as a cut
 * rather than as a sentence that happens to stop.
 */
export function cleanScoutText(value: string, maxChars: number): string {
  const stripped = value
    // `[24][23][29]`, `[1]`, and `[24, 25]` — citation markers, never content.
    //
    // **One to three digits, not `\d+`.** The first version stripped `[2019]`
    // too, which is a *year* and is content — "Founded [2019] in Lyon" came out
    // as "Founded in Lyon", quietly deleting a fact from a line the reader is
    // shown. A citation index is small by construction; a year is four digits.
    .replace(/\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (stripped.length <= maxChars) return stripped
  const cut = stripped.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * A company name as it should be displayed and keyed against.
 *
 * Live run again: the scout returned `Tome Skincare (Dermata Therapeutics)` and
 * `+PlusHLTH (CV Sciences)` — the brand with its parent appended. Harmless to the
 * name gate, which normalizes brackets away before matching, and wrong everywhere
 * a human reads it: the reader is writing to Tome Skincare, not to its holding
 * company.
 */
export function cleanCompanyName(value: string): string {
  const withoutParent = value.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim()
  return cleanScoutText(withoutParent || value, 80)
}

/** Whether a page plausibly belongs to the company named. */
function mentionsCompany(pageText: string, company: string): boolean {
  const haystack = normalizeCompanyName(pageText)
  const name = normalizeCompanyName(company)
  if (!name) return false
  if (haystack.includes(name)) return true

  // "Acme Studio SAS" against a page that only ever says "Acme". The first word
  // is required to be substantial, or "The Studio" would match everything.
  const first = name.split(' ')[0] ?? ''
  return first.length >= 4 && haystack.includes(first)
}

/**
 * `YYYY-MM-DD` as a timestamp, or null.
 *
 * Strict rather than forgiving. `new Date('last week')` is `Invalid Date` but
 * `new Date('2026')` is a valid January 1st — so a model answering with a year
 * would silently become a nine-month-old event that still cleared the window if
 * the window were wide. Requiring the full shape makes a vague answer a drop.
 */
export function parseEventDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const timestamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`)
  return Number.isNaN(timestamp) ? null : timestamp
}

/** What one scouting pass produced across the profiles it was given. */
export interface ScoutHarvest {
  signals: RawSignal[]
  /** Dropped proposals with their reasons, so a source that stops working is visible. */
  problems: string[]
  /** Profiles actually searched, which the cap may make fewer than were asked for. */
  searched: number
}

/**
 * Runs the scout for a bounded number of profiles and verifies everything it says.
 *
 * **`leadScout.maxProfilesPerRun` is the bound invariant 2 requires**, and it is
 * this pipeline's own — the whole reason ADR-0039 exists is that lead coverage
 * used to be a function of `jobScout.maxSearchesPerRun`, a number chosen for a
 * different pipeline's cost and silently governing this one.
 *
 * Profiles are taken in order, so with more profiles than the cap the same ones
 * are searched every run. That is a known limit rather than an oversight; the
 * rotation it wants is worth having only once a reader keeps more profiles than
 * the cap, and guessing at the policy now would be untested either way.
 */
export async function scoutProspects(
  profiles: ClientProfile[],
  propose: (profile: ClientProfile) => Promise<ProposedProspect[]>,
): Promise<ScoutHarvest> {
  const wanted = profiles.slice(0, leadScout.maxProfilesPerRun)
  const signals: RawSignal[] = []
  const problems: string[] = []
  const seen = new Set<string>()

  for (const profile of wanted) {
    let proposed: ProposedProspect[]
    try {
      proposed = await propose(profile)
    } catch (error) {
      problems.push(
        `${profile.slug}: scout failed — ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }

    for (let index = 0; index < proposed.length; index += leadScout.concurrency) {
      const slice = proposed.slice(index, index + leadScout.concurrency)
      const resolved = await Promise.all(slice.map(prospect => resolveProspect(prospect)))
      for (const outcome of resolved) {
        if (outcome.problem || !outcome.signal) {
          if (outcome.problem) problems.push(outcome.problem)
          continue
        }
        // One company per pass, even across profiles.
        if (seen.has(outcome.signal.leadId)) continue
        seen.add(outcome.signal.leadId)
        signals.push(outcome.signal)
      }
    }
  }

  return { signals, problems, searched: wanted.length }
}
