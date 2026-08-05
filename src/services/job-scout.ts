import type { Mastra } from '@mastra/core'
import { jobPipeline, jobScout } from '../config/jobs.js'
import type { JobSearch, JobSource } from '../db/schema.js'
import {
  atsBoardAsSource,
  atsBoardUrl,
  detectAtsBoard,
  fetchAtsBoard,
  findAtsBoardInHtml,
  probeAtsBoards,
  PUBLISHES_COMPANY,
} from './ats.js'
import { htmlToText } from './article.js'
import type { JobFetchResult, RawPosting } from './job-fetch.js'
import { proposeCompanies, type JobLead } from '../mastra/agents/job-scout.js'

/**
 * The `sonar` source: companies from a model, careers pages from the web.
 *
 * The split is the whole design, and it is the one
 * [ADR-0020](../../docs/decisions/0020-feed-discovery-from-a-subject.md) already
 * settled for feeds. A model may say "Acme is hiring frontend engineers". It may
 * **not** say where Acme's careers page lives — that is a fact about a server, and
 * the only way to know it is to ask the server. This module asks, in two steps,
 * and a real 200 carrying real text is the sole authority:
 *
 * 1. What the homepage links to — an anchor matching `careersLinkHints`.
 * 2. Well-known paths (`/careers`, `/jobs`, …).
 *
 * **The page's own text becomes the lead's description, and that is not
 * incidental.** `filterJob` reads `mustHave` out of title + company + description
 * and it is already the largest rejection reason on live intake; a lead described
 * only by the model's one-line "why" would be rejected for never mentioning the
 * reader's stack, and the feature would deliver nothing while appearing to work.
 * Real page text is what gives that rule something true to read — and it is
 * evidence off a page rather than prose from a model, so a lead cannot pass a
 * hard filter on an invented technology.
 *
 * Nothing here writes. Every fetch is a plain GET with no conditional-request
 * state recorded, for the same reason `checkFeed()` does its own fetch.
 */

/** One resolved lead, or the reason it produced nothing. */
export interface LeadResolution {
  lead: JobLead
  /** The verified careers page. Null when none was found. */
  careersUrl: string | null
  /** Extracted page text, capped. Null when nothing was resolved. */
  pageText: string | null
  /**
   * The careers page's raw markup, kept only so `leadToPostings` can look for an
   * applicant-tracking board mounted on it — usually an embed script rather than
   * a link, which `pageText` has already thrown away. Never stored.
   */
  pageHtml: string | null
  /** How it was found, for the report. Null when nothing was. */
  via: 'linked' | 'well-known' | null
  /** Why nothing was found. Null on success. */
  problem: string | null
}

/**
 * Fetches a page as a browser would, never throwing.
 *
 * `jobPipeline.userAgent` is already a browser UA — job boards are more hostile
 * about honest bot agents than RSS publishers, and a company's marketing site
 * sits behind the same kind of CDN. An unreachable homepage is a result rather
 * than an exception, because the well-known paths are still worth trying against
 * a page that 403s.
 */
async function fetchPage(url: string): Promise<{ html: string; ok: boolean }> {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': jobPipeline.userAgent,
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(jobScout.pageTimeoutMs),
    })
    return response.ok ? { html: await response.text(), ok: true } : { html: '', ok: false }
  } catch {
    return { html: '', ok: false }
  }
}

/**
 * Links on a page that plausibly lead to its careers page.
 *
 * Both the anchor text and the href are tested, because companies split evenly
 * between `<a href="/careers">Join us</a>` and `<a href="/join-us">Careers</a>`.
 * Returns several candidates rather than one: the first match on a marketing site
 * is as often a footer link to a jobs *board* the company uses as it is their own
 * page, and both are worth trying in order.
 *
 * Off-host links are kept. Companies routinely put their listings on
 * `jobs.lever.co/acme` or `boards.greenhouse.io/acme`, and refusing those would
 * reject exactly the pages that carry the most usable text.
 */
export function careersLinks(html: string, pageUrl: string): string[] {
  const found: string[] = []
  for (const [tag, href] of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (!href || !jobScout.careersLinkHints.test(tag)) continue
    try {
      const resolved = new URL(href.replace(/&amp;/g, '&'), pageUrl)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
      resolved.hash = ''
      if (resolved.toString() === pageUrl) continue
      // The destination must look like a careers page too, not merely the markup
      // that pointed at it. See `looksLikeCareers` — this is what stopped a real
      // false positive, not a hypothetical one.
      if (!looksLikeCareers(resolved)) continue
      found.push(resolved.toString())
    } catch {
      // A relative href against a base we can't parse is not a candidate.
    }
  }
  return [...new Set(found)].slice(0, 4)
}

/**
 * Whether a resolved URL is plausibly a careers page, judged on the URL itself.
 *
 * **The hint pattern is matched against the anchor's opening tag**, which carries
 * `class`, `aria-label` and assorted `data-` attributes — so a link whose markup
 * merely contains one of those words is a candidate however unrelated its
 * destination. Measured, not imagined: Productboard resolved to
 * `productboard.com/product/spark/`, a **product page**, which fetched fine,
 * returned 16k characters, mentioned React and TypeScript often enough to pass
 * `mustHave`, and would have been delivered to the reader as a job.
 *
 * Host *and* path are tested together, and both halves earn their place:
 * `factor-eleven.com/careers` matches on the path, while
 * `archlet.jobs.personio.com/` — a real employer's real ATS page — has a path of
 * `/` and matches only on the host. Testing either alone rejects one of them.
 *
 * **An applicant-tracking host short-circuits the shape test**, because the shape
 * test is wrong about several of them: `boards.greenhouse.io/acme` and
 * `apply.workable.com/acme` contain no hint word anywhere, and they are the best
 * pages this resolver finds. Caught by a case rather than by reasoning — the
 * first version of this guard rejected Greenhouse.
 *
 * Well-known paths need no such check: they are built from `careersPaths` and
 * match by construction.
 */
function looksLikeCareers(url: URL): boolean {
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  if (jobScout.atsHosts.some(ats => host === ats || host.endsWith(`.${ats}`))) return true
  return jobScout.careersLinkHints.test(`${host}${url.pathname}`)
}

/**
 * Whether a fetched page is a usable careers page.
 *
 * The floor is what stops a JavaScript-rendered listing page counting. Those
 * fetch fine and answer 200, and yield a shell of nav and footer carrying no
 * evidence at all — a lead built on one reaches the scorer as a company name and
 * gets judged on the model's prior about the company rather than on anything
 * read. `minPageChars` is deliberately a *rejection*, not a warning: this is the
 * one place in the job pipeline where discarding is right, because the lead was
 * never evidence in the first place.
 */
function usableText(html: string): string | null {
  const text = htmlToText(html).replace(/\s+/g, ' ').trim()
  if (text.length < jobScout.minPageChars) return null
  return text.slice(0, jobScout.maxPageChars)
}

/** The first candidate that answers with usable text, or null. */
async function firstUsable(
  candidates: readonly string[],
): Promise<{ url: string; text: string; html: string } | null> {
  for (const candidate of candidates) {
    const { html } = await fetchPage(candidate)
    if (!html) continue
    const text = usableText(html)
    if (text) return { url: candidate, text, html }
  }
  return null
}

/**
 * Resolves one lead's careers page, or reports that it has none.
 *
 * A lead that resolves nothing is **dropped**, not stored with the homepage as a
 * fallback. That is the opposite of the filter's keep-on-ambiguity bias and
 * deliberately so: the homepage is not a careers page, sending the reader to a
 * company's marketing site as if it were a job is a broken message, and ADR-0024
 * already records that a made-up company is the risk this source carries. A lead
 * we could not verify is exactly the one most likely to be invented.
 */
export async function resolveLead(lead: JobLead): Promise<LeadResolution> {
  let homepage: string
  try {
    homepage = new URL(lead.homepage).toString()
  } catch {
    return {
      lead,
      careersUrl: null,
      pageText: null,
      pageHtml: null,
      via: null,
      problem: 'not a valid http(s) URL',
    }
  }

  const { html, ok } = await fetchPage(homepage)

  const linked = await firstUsable(careersLinks(html, homepage))
  if (linked) {
    return {
      lead,
      careersUrl: linked.url,
      pageText: linked.text,
      pageHtml: linked.html,
      via: 'linked',
      problem: null,
    }
  }

  const guesses = jobScout.careersPaths
    .map(path => {
      try {
        return new URL(path, homepage).toString()
      } catch {
        return null
      }
    })
    .filter((url): url is string => url !== null)
  const guessed = await firstUsable(guesses)
  if (guessed) {
    return {
      lead,
      careersUrl: guessed.url,
      pageText: guessed.text,
      pageHtml: guessed.html,
      via: 'well-known',
      problem: null,
    }
  }

  return {
    lead,
    careersUrl: null,
    pageText: null,
    pageHtml: null,
    via: null,
    problem: ok ? 'no careers page found on the site' : 'the site could not be fetched',
  }
}

/** Runs `resolveLead` over every lead, a few at a time. */
export async function resolveLeads(leads: readonly JobLead[]): Promise<LeadResolution[]> {
  const results: LeadResolution[] = []
  for (let index = 0; index < leads.length; index += jobScout.pageConcurrency) {
    const batch = leads.slice(index, index + jobScout.pageConcurrency)
    results.push(...(await Promise.all(batch.map(resolveLead))))
  }
  return results
}

/**
 * A resolved lead as the common posting shape.
 *
 * `postedAt` is **null**, and that is honest rather than lazy: a careers page
 * carries no posting date, and inventing one would put a lead inside the ingest
 * window on evidence that does not exist. Sonar is the first source here to
 * produce undated postings — AGENTS.md records that `undated` was zero across
 * every other source — which is precisely the case `job_deliveries` was built for.
 *
 * `remote` is `unknown` rather than guessed from the search's own criteria.
 * Copying the search's `remote` onto the lead would make a filter that reads
 * `job.remote` compare the search against itself and always agree.
 */
export function leadToPosting(resolution: LeadResolution): RawPosting | null {
  if (!resolution.careersUrl || !resolution.pageText) return null
  return {
    keyedAs: 'lead',
    company: resolution.lead.company,
    title: resolution.lead.role,
    location: null,
    remote: 'unknown',
    url: resolution.careersUrl,
    // The model's own line first, then the page. The "why" is the only part that
    // speaks to *this* role, and the scorer truncates hard — putting it in front
    // means it survives `scorerDescriptionChars` where the page text may not.
    description: `${resolution.lead.why}\n\n${resolution.pageText}`.slice(
      0,
      jobScout.maxPageChars,
    ),
    salaryText: null,
    contractType: null,
    tags: [],
    postedAt: null,
  }
}

/**
 * One resolved lead as postings — the employer's real adverts where possible.
 *
 * **The landing page is the fallback now, not the product.** When resolution
 * lands on an applicant-tracking board, that board has a public API listing the
 * employer's actual openings with actual descriptions, and reading it replaces a
 * single row of marketing copy with N real adverts. That is the difference
 * between a lead the filter rejects for naming no stack and a set of postings the
 * filter can judge on their own words — see the head of `services/ats.ts` for the
 * measurement that motivated this.
 *
 * A board that answers nothing usable degrades to `leadToPosting` rather than to
 * nothing at all. An employer whose board is genuinely empty is still a company
 * that was proposed and verified, and the careers page is still a real page; it
 * is simply worth much less, and the filter will treat it accordingly.
 *
 * **Three ways to a board, cheapest first, and the order is what makes it work.**
 * Measured over the six employers of a live run: resolution landed directly on an
 * ATS host **zero** times, the careers-page markup referenced one, and probing the
 * domain label found four of the remaining five. Shipping only the first two
 * would have been a feature that never fired — which is exactly how the landing
 * page problem it replaces went unnoticed.
 */
export async function leadToPostings(resolution: LeadResolution): Promise<LeadExpansion> {
  if (!resolution.careersUrl || !resolution.pageText) {
    return { postings: [], board: null, problem: null }
  }

  const board =
    detectAtsBoard(resolution.careersUrl) ??
    (resolution.pageHtml ? findAtsBoardInHtml(resolution.pageHtml) : null) ??
    (await probeAtsBoards(resolution.lead.homepage, resolution.lead.company))
  if (board) {
    const { postings, problem } = await fetchAtsBoard(board)
    if (postings.length > 0) {
      return {
        // The employer's own name from their board where they publish one —
        // `PUBLISHES_COMPANY` is the four that do. Lever and Ashby carry only the
        // slug, so the model's company name is the better label there. Either way
        // it is never the model that decides the *URL*, the part that must be true.
        postings: postings.map(posting => ({
          ...posting,
          company: PUBLISHES_COMPANY.has(board.provider)
            ? posting.company
            : resolution.lead.company,
        })),
        // Handed up rather than written here — this module does not touch the
        // database, and `findJobs` is where a run's writes belong.
        board: atsBoardAsSource(board, resolution.lead.company),
        problem: null,
      }
    }
    const fallback = leadToPosting(resolution)
    return {
      postings: fallback ? [fallback] : [],
      // **Not remembered.** A board that lists nothing today is not evidence of a
      // source worth polling forever, and storing it would fill the table with
      // employers who are not hiring.
      board: null,
      problem: problem ?? `${atsBoardUrl(board)} listed no open postings`,
    }
  }

  const posting = leadToPosting(resolution)
  return { postings: posting ? [posting] : [], board: null, problem: null }
}

/** One lead, expanded — plus the board worth remembering, when there is one. */
export interface LeadExpansion {
  postings: RawPosting[]
  /** The ATS board to store as a source row. Null when there is nothing to keep. */
  board: { id: string; adapter: string; url: string; label: string } | null
  problem: string | null
}

/**
 * The `sonar` source's fetch, over every search that gets a turn this run.
 *
 * **Its signature differs from `fetchJobSource` on purpose**, which is why it
 * lives here rather than as another branch in `job-fetch.ts`. Every other source
 * is a URL and a normalizer; this one needs a model handle and the reader's
 * active searches, and hiding that behind a lowest-common-denominator interface
 * would make the one source with real dependencies look like the eight without
 * any. `findJobs` routes `kind === 'sonar'` here and records the result on the
 * source row identically, so the row still behaves like a source — archive it and
 * the feature is off.
 *
 * Bounded by `jobScout.maxSearchesPerRun`, taken oldest-first from the order
 * `activeSearches()` already returns. That bound is what keeps a scheduled model
 * call legal under invariant 2: the control flow is fixed and cannot grow with
 * whatever the reader accumulates in `job_searches`.
 *
 * Never throws. One search's failed search call must not cost the other searches'
 * leads, nor the nine boards that already succeeded.
 */
export async function fetchSonarSource(
  source: JobSource,
  mastra: Mastra,
  searches: readonly JobSearch[],
  /** Employers already polled as `ats` rows, so the scout looks past them. */
  knownCompanies: readonly string[] = [],
): Promise<JobFetchResult> {
  const wanted = searches.slice(0, jobScout.maxSearchesPerRun)
  if (wanted.length === 0) {
    return { sourceId: source.id, postings: [], status: 'skipped', error: undefined }
  }

  const postings: RawPosting[] = []
  const problems: string[] = []
  const boards: LeadExpansion['board'][] = []
  // Companies already resolved this run, so two searches that overlap don't both
  // spend fetches on the same employer. Names, because that is what the prompt
  // can be told to skip; the real dedupe is `leadIdentity` at ingest.
  //
  // **Seeded with every employer already polled as an `ats` row.** The model has
  // no memory between runs, so without this each run spends its proposals
  // re-finding the boards the pipeline is already reading — the scout's whole
  // value is finding employers it has *not* found before.
  const seenCompanies = new Set(knownCompanies.map(company => company.toLowerCase()))

  for (const search of wanted) {
    try {
      const leads = await proposeCompanies(mastra, search, [...seenCompanies])
      const fresh = leads.filter(lead => !seenCompanies.has(lead.company.toLowerCase()))
      for (const lead of fresh) seenCompanies.add(lead.company.toLowerCase())

      for (const resolution of await resolveLeads(fresh)) {
        const expanded = await leadToPostings(resolution)
        postings.push(...expanded.postings)
        if (expanded.board) boards.push(expanded.board)
        // A board that resolved but listed nothing is worth recording on the row:
        // it is the difference between "sonar found no one" and "sonar found six
        // employers who are not currently hiring", which look identical in a count.
        if (expanded.problem) problems.push(`${search.slug}: ${expanded.problem}`)
      }
    } catch (error) {
      problems.push(
        `${search.slug}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return {
    sourceId: source.id,
    postings,
    boards: boards.filter((board): board is NonNullable<typeof board> => board !== null),
    // A source that resolved nothing at all is worth seeing on the row, because
    // it is indistinguishable from a healthy quiet run otherwise.
    status: problems.length > 0 ? 'partial' : '200',
    error: problems.length > 0 ? problems.join('; ') : undefined,
  }
}
