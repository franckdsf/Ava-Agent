import { jobScout } from '../config/jobs.js'
import { NOT_AN_EMPLOYER_HOSTS, leadPipeline, type LeadSignalKind } from '../config/leads.js'
import { recentPostings } from '../db/jobs.js'
import { htmlToText } from './article.js'
import { canonicalizeSourceUrl, isPlatformHost, normalizeHost, signalId } from './lead-identity.js'
import { fetchPage } from './page-fetch.js'

/**
 * Where leads come from
 * ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
 *
 * The first source costs nothing: the `jobs` table the other pipeline already
 * fills. A company advertising a role adjacent to what the reader sells is a
 * company with a budget and an unmet need, and it has already been fetched,
 * deduped and stripped by a run that happened anyway.
 *
 * **This module reads `jobs` and writes nothing to it.** That is the boundary
 * ADR-0038 draws: the leads pipeline may treat the job pipeline as a source and
 * may not change how it behaves.
 */

/** One signal before it has been stored — a company, an event, and where it was seen. */
export interface RawSignal {
  leadId: string
  company: string
  location: string | null
  /** The company's own site, canonical https form of the host. */
  companyUrl: string
  /**
   * Widened from `'hiring'` when the sonar scout landed
   * ([ADR-0039](../../docs/decisions/0039-a-lead-scout-with-its-own-budget.md)):
   * the `jobs` table can only ever evidence a hire, but a scout that searches the
   * open web reports funding, launches and rebrands too.
   */
  kind: LeadSignalKind
  sourceUrl: string
  origin: string
  occurredAt: number
  summary: string
}

/** What one extraction pass produced, and what it had to throw away. */
export interface SignalHarvest {
  signals: RawSignal[]
  /**
   * Postings dropped because their URL identifies a board rather than an
   * employer. Counted rather than ignored — see below.
   */
  noCompanyDomain: number
}

/**
 * Hosts that are never a company: job boards, talent marketplaces,
 * applicant-tracking systems, store platforms, and communities.
 *
 * The first two lists are **read** from the job pipeline's own configuration
 * rather than copied, because they are the same hosts for the same reason and a
 * second copy would drift. Reading them changes nothing about how the job
 * pipeline behaves; the third list is the leads pipeline's own, so nothing here
 * can reach back into the job scout's idea of who it may propose.
 */
export function isNotACompanyHost(host: string): boolean {
  const lists: readonly (readonly string[])[] = [
    jobScout.excludedHosts,
    jobScout.atsHosts,
    // Communities and aggregators, which the job pipeline's lists do not cover
    // because it has no reason to — measured against the live table, this is
    // what stopped 211 Hacker News postings becoming one lead. See the note on
    // `NOT_AN_EMPLOYER_HOSTS`.
    NOT_AN_EMPLOYER_HOSTS,
  ]
  return (
    lists.some(list => list.some(bad => host === bad || host.endsWith(`.${bad}`))) ||
    isPlatformHost(host)
  )
}

/**
 * Turns recent job postings into hiring signals about the companies behind them.
 *
 * **Most postings are dropped, and the reason is structural rather than a bug.**
 * A lead is keyed on the company's own host, and a job posting's URL is almost
 * always a *board's*: `weworkremotely.com/jobs/123`, `boards.greenhouse.io/acme`.
 * Keying on those would produce one lead called "We Work Remotely" that every
 * unrelated employer's signals pile into — the same failure the platform-host
 * list exists to prevent, arriving from a different direction.
 *
 * Nothing here guesses a company's domain from its name. That is the rule
 * [ADR-0026](../../docs/decisions/0026-sonar-as-a-job-source.md) settled: a model
 * may say a company exists, it may not say where it lives, because a wrong URL
 * never errors. So a posting whose host is a board is **dropped and counted**,
 * and `noCompanyDomain` is reported on the run — a large number there is the
 * measurement that says the sonar lead scout is now worth building, rather than
 * a silence nobody can interpret.
 *
 * The `jobs` table is also genuinely bounded — a 30-day ingest window and a
 * 60-day prune — so unlike the open web this source cannot flood a run.
 */
export async function hiringSignalsFromJobs(limit: number): Promise<SignalHarvest> {
  const cutoff = Date.now() - leadPipeline.signalWindowDays * 86_400_000
  const rows = await recentPostings(cutoff, limit)

  const signals: RawSignal[] = []
  const seen = new Set<string>()
  let noCompanyDomain = 0

  for (const row of rows) {
    const host = normalizeHost(row.url)
    if (!host || isNotACompanyHost(host)) {
      noCompanyDomain += 1
      continue
    }
    // One signal per company per pass: five open roles at one employer is one
    // reason to write to them, not five.
    if (seen.has(host)) continue
    seen.add(host)

    const occurredAt = row.postedAt ?? row.discoveredAt
    signals.push({
      leadId: host,
      company: row.company,
      location: row.location,
      companyUrl: `https://${host}`,
      kind: 'hiring',
      sourceUrl: canonicalizeSourceUrl(row.url),
      origin: `jobs:${row.sourceId}`,
      occurredAt,
      summary: `Hiring: ${row.title}`,
    })
  }

  return { signals, noCompanyDomain }
}

/** The stored id for a raw signal. Thin, so callers never rebuild the key by hand. */
export function idOf(signal: RawSignal): string {
  return signalId(signal.leadId, signal.kind, signal.sourceUrl)
}

/** What reading a company's own page produced. */
export interface ResolvedPage {
  text: string
  /** Candidate images, absolute, in document order. Empty is normal and fine. */
  images: string[]
  problem: string | null
}

/**
 * Reads a company's own page — the evidence the filter and the scorer judge on.
 *
 * The floor is the part that matters. A site rendering from JavaScript answers
 * 200 with a shell of nav and footer, and a lead judged on one is judged on the
 * model's prior about the company rather than on anything read
 * ([ADR-0026](../../docs/decisions/0026-sonar-as-a-job-source.md) measured that,
 * and this is the one place discarding on ambiguity is right).
 */
export async function resolveLeadPage(url: string): Promise<ResolvedPage> {
  const { html, ok } = await fetchPage(url, {
    userAgent: leadPipeline.userAgent,
    timeoutMs: leadPipeline.pageTimeoutMs,
  })
  if (!ok || !html) return { text: '', images: [], problem: 'page did not answer' }

  const text = htmlToText(html).slice(0, leadPipeline.maxPageChars)
  if (text.length < leadPipeline.minPageChars) {
    return { text: '', images: [], problem: 'page carried no readable text' }
  }
  return { text, images: imageUrlsFrom(html, url), problem: null }
}

/**
 * Candidate images from a page, absolute and in document order.
 *
 * Document order is the selection: the first handful are the hero and the
 * product or feature shots, which is what a judgement about visual quality is
 * actually about. The tail is icons, payment badges and tracking pixels.
 *
 * The `og:image` is put first when present, because it is the one image a
 * company deliberately chose to represent itself.
 *
 * Excluded by extension rather than by size, because the size is not knowable
 * without fetching each one and this runs before any decision to spend a vision
 * call. SVGs go because they are logos and icons; data URIs go because they are
 * inline sprites and would be sent as bytes rather than a URL.
 */
export function imageUrlsFrom(html: string, pageUrl: string): string[] {
  const found: string[] = []

  const ogMatch = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  )
  if (ogMatch?.[1]) found.push(ogMatch[1])

  for (const match of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    if (match[1]) found.push(match[1])
  }

  const absolute: string[] = []
  const seen = new Set<string>()
  for (const candidate of found) {
    if (candidate.startsWith('data:')) continue
    let resolved: string
    try {
      resolved = new URL(candidate, pageUrl).toString()
    } catch {
      continue
    }
    const path = resolved.split('?')[0]?.toLowerCase() ?? ''
    if (path.endsWith('.svg') || path.endsWith('.gif')) continue
    // Sprites, spacers and tracking pixels announce themselves in the filename
    // far more reliably than in their dimensions, which are usually set in CSS.
    if (/\b(sprite|icon|logo|favicon|pixel|spacer|badge|avatar)\b/i.test(path)) continue
    if (seen.has(resolved)) continue
    seen.add(resolved)
    absolute.push(resolved)
    if (absolute.length >= leadPipeline.maxImagesPerLead) break
  }

  return absolute
}
