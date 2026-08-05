import { jobPipeline, jobScout } from '../config/jobs.js'
import type { JobRemote } from '../db/schema.js'
import { htmlToText } from './article.js'
import type { RawPosting } from './job-fetch.js'

/**
 * Applicant-tracking boards, read through their own public APIs.
 *
 * **This is what turns a sonar lead from one blob into real adverts.** Resolution
 * already lands on `boards.greenhouse.io/acme` or `jobs.lever.co/acme` — those
 * hosts are in `jobScout.atsHosts` precisely because they are the best pages it
 * finds — and until now the result was stored as a single posting whose
 * description was the *landing page*. A landing page is marketing copy: measured
 * 2026-08-06, all six leads of a live run were rejected by `mustHave` because
 * "Build the Future with Us… Our core values… Global exposure" names no stack,
 * and the one search with no `mustHave` scored the same six at 40/100 or less.
 * Raising `maxPageChars` could not fix that, because the problem is the *kind* of
 * text, not the amount of it.
 *
 * Every board here answers **without a key, in one request, with the full advert
 * body**. That last part is the selection rule and it excluded two obvious
 * candidates, both verified live on 2026-08-06:
 *
 * - **SmartRecruiters** works and is free, but its list endpoint carries no
 *   description at all — the body needs a second fetch per posting. An N+1 against
 *   a stranger's API, for text that then has to clear the same filter, is a worse
 *   deal than it looks. Add it when there is a reason to spend those requests.
 * - **Personio** answered `429` on every request but one, which matters because it
 *   is *the* European SME tracker and therefore the single best route to the
 *   non-software employers this pipeline is meant to reach. Worth revisiting with
 *   a backoff; not worth shipping as a source that mostly rate-limits.
 *
 * **The domain generality is the point, not a side effect.** These boards are not
 * tech boards. Figure's Greenhouse board was 18 non-engineering roles out of 19 —
 * Chief Credit Officer, Account Administration Associate, Business Development
 * Manager — each a real advert of about 6,000 characters with a real location. A
 * dental group's board lists its hygienists exactly the way a startup's lists its
 * engineers, which is what a pipeline that must answer `/target dentist` needs and
 * what the four remaining remote-tech boards can never provide.
 */

/** The trackers this module can read. */
export type AtsProvider = 'greenhouse' | 'lever' | 'ashby'

export interface AtsBoard {
  provider: AtsProvider
  /** The employer's board slug, as it appears in the careers URL. */
  token: string
}

/**
 * The board a resolved careers URL belongs to, or null.
 *
 * Matched on host *and* first path segment, never on the host alone: every one of
 * these providers serves its own marketing site from the same domain, and
 * `greenhouse.io/customers` is not a board. A missing or reserved first segment
 * is therefore a null rather than a token — the alternative is requesting
 * `/v1/boards/customers/jobs` and recording a 404 as if an employer had no jobs.
 *
 * Greenhouse has three published shapes for the same board and all three are in
 * the wild: `boards.greenhouse.io/acme`, the newer `job-boards.greenhouse.io/acme`
 * that its own `absolute_url` now returns, and the embed form
 * `boards.greenhouse.io/embed/job_board?for=acme`. The embed one is why the query
 * string is read at all.
 */
export function detectAtsBoard(url: string): AtsBoard | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
  const segments = parsed.pathname.split('/').filter(Boolean)
  const first = segments[0]?.toLowerCase()

  if (host === 'greenhouse.io' || host.endsWith('.greenhouse.io')) {
    // `…/embed/job_board?for=acme` — the token is in the query, not the path.
    const embedded = parsed.searchParams.get('for')
    if (embedded) return board('greenhouse', embedded)
    return first === 'embed' ? null : board('greenhouse', first)
  }
  if (host === 'lever.co' || host.endsWith('.lever.co')) return board('lever', first)
  if (host === 'ashbyhq.com' || host.endsWith('.ashbyhq.com')) return board('ashby', first)

  return null
}

/**
 * Path segments that are the provider's own site rather than an employer.
 *
 * Short and deliberately not exhaustive: a wrong token costs one 404 that is
 * recorded and moved past, while a missing entry here costs nothing at all. The
 * expensive mistake would be the other direction — rejecting a real employer
 * whose slug happens to look generic — so nothing is added on suspicion.
 */
const RESERVED_SEGMENTS = new Set([
  'customers', 'pricing', 'about', 'blog', 'legal', 'privacy', 'terms',
  'products', 'solutions', 'login', 'signup', 'demo', 'contact', 'jobs',
])

function board(provider: AtsProvider, token: string | undefined): AtsBoard | null {
  if (!token) return null
  const clean = token.trim().toLowerCase()
  if (!clean || RESERVED_SEGMENTS.has(clean)) return null
  // A slug is a slug. Anything with a dot or a space is a path fragment we
  // mis-split, not an employer.
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(clean)) return null
  return { provider, token: clean }
}

const API_URLS: Record<AtsProvider, (token: string) => string> = {
  greenhouse: token => `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
  lever: token => `https://api.lever.co/v0/postings/${token}?mode=json`,
  ashby: token => `https://api.ashbyhq.com/posting-api/job-board/${token}`,
}

/** The employer-facing URL for a board — what an `ats` source row stores. */
export function atsBoardUrl(board: AtsBoard): string {
  if (board.provider === 'greenhouse') return `https://job-boards.greenhouse.io/${board.token}`
  if (board.provider === 'lever') return `https://jobs.lever.co/${board.token}`
  return `https://jobs.ashbyhq.com/${board.token}`
}

/**
 * A board as a source row.
 *
 * The id is derived from the provider and token rather than random, so the same
 * employer discovered on a later run collides with the row that already exists
 * instead of creating a second one. That is what makes re-discovery free and
 * archiving stick.
 */
export function atsBoardAsSource(
  board: AtsBoard,
  label: string,
): { id: string; adapter: string; url: string; label: string } {
  return {
    id: `ats-${board.provider}-${board.token}`,
    adapter: board.provider,
    url: atsBoardUrl(board),
    label,
  }
}

const clean = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const truncate = (value: string | null): string | null =>
  value === null ? null : value.slice(0, jobPipeline.maxDescriptionChars)

function parseDate(value: unknown): number | null {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Whether a location string describes remote work.
 *
 * `unknown` rather than `onsite` when it says nothing, for the reason the whole
 * filter leans that way: `search.remote === 'required'` rejects only `onsite`, so
 * guessing "on-site" from a silent field would quietly discard real remote roles,
 * while `unknown` costs a scoring slot the model can judge properly.
 */
function remoteFrom(location: string | null, flag?: boolean): JobRemote {
  if (flag === true) return 'remote'
  if (!location) return 'unknown'
  return /\b(remote|anywhere|distributed|work from home)\b/i.test(location) ? 'remote' : 'onsite'
}

/**
 * Greenhouse — `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`.
 *
 * **`content` is HTML that has been entity-escaped**, so it arrives as
 * `&lt;p&gt;&lt;strong&gt;About…` rather than as markup. `htmlToText` strips tags
 * *before* it decodes entities, which on this input strips nothing and then hands
 * back raw `<p>` tags — so it is applied twice, decoding on the first pass and
 * stripping on the second. Measured on Figure's board: one pass leaves the tag
 * names as prose ("p strong About Figure"), which the tagger then reads as words.
 */
function fromGreenhouse(payload: unknown, board: AtsBoard): RawPosting[] {
  const jobs = (payload as { jobs?: unknown[] })?.jobs
  if (!Array.isArray(jobs)) return []

  return jobs.flatMap((raw): RawPosting[] => {
    const job = raw as Record<string, unknown>
    const title = clean(job.title)
    const url = clean(job.absolute_url)
    if (!title || !url) return []

    const location = clean((job.location as { name?: string } | undefined)?.name)
    const departments = Array.isArray(job.departments)
      ? job.departments
          .map(entry => clean((entry as { name?: string }).name))
          .filter((name): name is string => name !== null)
      : []

    return [{
      company: clean(job.company_name) ?? board.token,
      title,
      location,
      remote: remoteFrom(location),
      url,
      description: truncate(htmlToText(htmlToText(String(job.content ?? '')))),
      salaryText: null,
      contractType: null,
      // The board's own departments — "Engineering", "Clinical", "Field
      // Operations". Stored, never filtered on, exactly like every other source's
      // tags: they describe the employer's org chart, not the role's requirements.
      tags: departments,
      postedAt: parseDate(job.first_published ?? job.updated_at),
    }]
  })
}

/**
 * Lever — `api.lever.co/v0/postings/{token}?mode=json`.
 *
 * **The advert is in four fields, not one.** `descriptionPlain` is only the
 * opening paragraphs; the requirements — the part that names a stack, a licence
 * or a qualification, and therefore the part `mustHave` exists to read — live in
 * `lists[].content` as separate HTML blocks, with `additionalPlain` after them.
 * Taking `descriptionPlain` alone drops precisely the text worth filtering on.
 */
function fromLever(payload: unknown, board: AtsBoard): RawPosting[] {
  if (!Array.isArray(payload)) return []

  return payload.flatMap((raw): RawPosting[] => {
    const job = raw as Record<string, unknown>
    const title = clean(job.text)
    const url = clean(job.hostedUrl) ?? clean(job.applyUrl)
    if (!title || !url) return []

    const categories = (job.categories ?? {}) as Record<string, unknown>
    const location = clean(categories.location)

    const lists = Array.isArray(job.lists)
      ? job.lists
          .map(entry => {
            const list = entry as { text?: unknown; content?: unknown }
            return `${clean(list.text) ?? ''}\n${htmlToText(String(list.content ?? ''))}`.trim()
          })
          .filter(Boolean)
      : []

    const body = [clean(job.descriptionPlain), ...lists, clean(job.additionalPlain)]
      .filter(Boolean)
      .join('\n\n')

    return [{
      company: board.token,
      title,
      location,
      remote: remoteFrom(location, clean(job.workplaceType)?.toLowerCase() === 'remote'),
      url,
      description: truncate(clean(body)),
      salaryText: null,
      contractType: clean(categories.commitment),
      tags: [clean(categories.department), clean(categories.team)].filter(
        (tag): tag is string => tag !== null,
      ),
      postedAt: parseDate(job.createdAt),
    }]
  })
}

/**
 * Ashby — `api.ashbyhq.com/posting-api/job-board/{token}`.
 *
 * The cleanest of the three: a real `isRemote` boolean, a real `employmentType`,
 * and `descriptionPlain` already flattened — 16,000 characters on the sample
 * measured, which is a whole advert rather than a summary of one.
 */
function fromAshby(payload: unknown, board: AtsBoard): RawPosting[] {
  const jobs = (payload as { jobs?: unknown[] })?.jobs
  if (!Array.isArray(jobs)) return []

  return jobs.flatMap((raw): RawPosting[] => {
    const job = raw as Record<string, unknown>
    const title = clean(job.title)
    const url = clean(job.jobUrl) ?? clean(job.applyUrl)
    if (!title || !url) return []
    // `isListed: false` is a posting the employer has unpublished but the API
    // still returns. Sending one would link the reader to a dead page.
    if (job.isListed === false) return []

    const location = clean(job.location)

    return [{
      company: board.token,
      title,
      location,
      remote: remoteFrom(location, job.isRemote === true),
      url,
      description: truncate(
        clean(job.descriptionPlain) ?? (clean(job.descriptionHtml) && htmlToText(String(job.descriptionHtml))),
      ),
      salaryText: null,
      contractType: clean(job.employmentType),
      tags: [clean(job.department), clean(job.team)].filter((tag): tag is string => tag !== null),
      postedAt: parseDate(job.publishedAt),
    }]
  })
}

const ADAPTERS: Record<AtsProvider, (payload: unknown, board: AtsBoard) => RawPosting[]> = {
  greenhouse: fromGreenhouse,
  lever: fromLever,
  ashby: fromAshby,
}

/**
 * An ATS board referenced anywhere in a page's markup.
 *
 * Scans the **raw HTML rather than its anchors**, because the most common way a
 * company mounts its board is not a link at all: Greenhouse's documented
 * integration is a `<script src="…/embed/job_board/js?for=acme">`, and Lever and
 * Ashby are routinely dropped into an `<iframe>`. An anchor-only scan misses
 * every one of those and finds only the minority that link out in a footer.
 *
 * Measured on the six employers a live run proposed: exactly one — BitGo —
 * referenced its board in the careers-page HTML at all. So this is worth doing
 * and is nowhere near sufficient on its own; `probeAtsBoards` is what actually
 * carries the resolution.
 */
export function findAtsBoardInHtml(html: string): AtsBoard | null {
  const pattern =
    /(?:https?:\/\/)?(?:boards|job-boards)\.greenhouse\.io\/[^"'\s<>)]+|(?:https?:\/\/)?(?:www\.)?greenhouse\.io\/embed\/job_board(?:\/js)?\?for=[a-z0-9_-]+|(?:https?:\/\/)?jobs\.lever\.co\/[^"'\s<>)]+|(?:https?:\/\/)?jobs\.ashbyhq\.com\/[^"'\s<>)]+|(?:https?:\/\/)?api\.ashbyhq\.com\/posting-api\/job-board\/[a-z0-9_-]+/gi

  for (const match of html.matchAll(pattern)) {
    const raw = match[0].startsWith('http') ? match[0] : `https://${match[0]}`
    // Ashby's own API path carries the token one segment deeper than its board
    // URL, so it is rewritten to the board shape rather than given its own case.
    const normalized = raw.replace(
      /api\.ashbyhq\.com\/posting-api\/job-board\//i,
      'jobs.ashbyhq.com/',
    )
    const board = detectAtsBoard(normalized)
    if (board) return board
  }
  return null
}

/**
 * The board an employer's domain implies, confirmed by asking the provider.
 *
 * **This is the step that makes the whole feature fire, and it is a guess that
 * code verifies rather than a fact a model supplied** — the same bargain
 * `careersPaths` already makes when it tries `/careers` on a site that linked to
 * nothing. A token is derived from the domain label, the three providers are
 * asked whether they host a board under it, and **a real 200 carrying real
 * postings is the only thing that counts as an answer**. Nothing is stored on a
 * guess alone.
 *
 * It works because ATS tokens are overwhelmingly the company's own domain label.
 * Measured 2026-08-06 over the six employers of a live run plus two controls:
 * OKX (335 postings), Blockchain.com (36), BitGo (34), Figure (19), Stripe (548)
 * and Ramp (120) all resolved from the domain label alone — **six of seven**. Only
 * ASBIS, an Eastern European distributor on none of the three, did not.
 *
 * **Greenhouse is checked for company agreement, the other two cannot be.**
 * Greenhouse returns `company_name` on every posting, so a token collision — some
 * *other* Figure — is caught by comparing it to the employer we were looking for.
 * Lever and Ashby publish no company name anywhere in their posting API, so a
 * board found there rests on the token match alone. The exposure is bounded by
 * what the reader is sent: every posting carries the employer's own URL on the
 * provider's domain, so a mismatch is visible in one click rather than hidden.
 */
export async function probeAtsBoards(
  homepage: string,
  company: string,
): Promise<AtsBoard | null> {
  let token: string
  try {
    const host = new URL(homepage).hostname.replace(/^www\./, '').toLowerCase()
    token = host.split('.')[0] ?? ''
  } catch {
    return null
  }

  const candidate = board('greenhouse', token)
  if (!candidate) return null

  for (const provider of ['greenhouse', 'lever', 'ashby'] as const) {
    const probe: AtsBoard = { provider, token: candidate.token }
    const { postings } = await fetchAtsBoard(probe)
    if (postings.length === 0) continue
    if (provider === 'greenhouse' && !companyAgrees(postings[0]?.company, company, token)) continue
    return probe
  }
  return null
}

/**
 * Whether a board's own company name is plausibly the employer we were after.
 *
 * Deliberately loose — containment either way, over `normalizeCompany`'s output.
 * A board says `Figure Technology Solutions` where the model said `Figure`, and
 * `Blockchain.com` where the model said `Blockchain`. Requiring equality would
 * reject nearly every true match; the check exists to catch a *different*
 * employer, not to audit phrasing. The domain label counts too, since that is
 * what produced the token.
 */
function companyAgrees(
  boardCompany: string | undefined,
  leadCompany: string,
  token: string,
): boolean {
  if (!boardCompany) return true
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const board = normalize(boardCompany)
  if (!board) return true
  for (const known of [normalize(leadCompany), normalize(token)]) {
    if (known && (board.includes(known) || known.includes(board))) return true
  }
  return false
}

export interface AtsFetchResult {
  postings: RawPosting[]
  /** Why nothing came back. Null on success, including a legitimately empty board. */
  problem: string | null
}

/**
 * Every currently-listed posting on one board, normalized.
 *
 * Never throws, for the reason every other fetch here doesn't: one employer whose
 * board 404s must not cost the other seventeen leads of the run.
 *
 * **Capped at `atsMaxPostingsPerBoard`.** Lever's own demo board returns 388
 * postings, and one employer is not allowed to become the run — the cap keeps a
 * single lead's contribution comparable to a whole job board's. Newest first, so
 * the cap takes the current openings rather than an arbitrary slice.
 */
export async function fetchAtsBoard(board: AtsBoard): Promise<AtsFetchResult> {
  try {
    const response = await fetch(API_URLS[board.provider](board.token), {
      headers: { 'user-agent': jobPipeline.userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(jobScout.pageTimeoutMs),
    })
    if (!response.ok) {
      return { postings: [], problem: `${board.provider} board answered HTTP ${response.status}` }
    }

    const postings = ADAPTERS[board.provider](await response.json(), board)
      .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))
      .slice(0, jobScout.atsMaxPostingsPerBoard)

    return { postings, problem: null }
  } catch (error) {
    return {
      postings: [],
      problem: `${board.provider} board: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
