import Parser from 'rss-parser'
import { jobPipeline } from '../config/jobs.js'
import type { JobRemote, JobSource } from '../db/schema.js'
import { detectAtsBoard, fetchAtsBoard } from './ats.js'
import { htmlToText } from './article.js'

/**
 * Fetching job sources, and normalizing whatever comes back into one shape.
 *
 * One `fetchJobSource` over a `kind`/`adapter` discriminator, rather than a
 * fetcher per board wired in at a call site: sources are rows
 * ([ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)),
 * so adding one must not mean touching workflow code — the same rule that makes
 * a beat a row rather than a module.
 *
 * **Shapes here were read off the live endpoints, not from documentation.**
 * Probed 2026-08-03; the surprises are recorded on each adapter.
 */

/** One posting, before it is given an identity and stored. */
export interface RawPosting {
  company: string
  title: string
  location: string | null
  remote: JobRemote
  url: string
  description: string | null
  salaryText: string | null
  contractType: string | null
  tags: string[]
  postedAt: number | null
  /**
   * How this is keyed at ingest. Absent means `posting`, which is what every
   * board produces.
   *
   * Only the `sonar` source emits both, and the difference is not cosmetic. A
   * *lead* is a company plus a careers page, keyed on the URL alone because its
   * title is a model's phrasing and changes between runs
   * ([`job-identity.ts`](./job-identity.ts)). A posting expanded off that
   * company's ATS board is a real advert with the employer's own title, location
   * and URL — keying it like a lead would collapse an entire board into one row
   * and deliver the reader a link to the board instead of to the job.
   */
  keyedAs?: 'posting' | 'lead'
}

export interface JobFetchResult {
  sourceId: string
  postings: RawPosting[]
  status: string
  error?: string
  etag?: string | null
  lastModified?: string | null
  /**
   * Applicant-tracking boards this fetch discovered and that are worth keeping as
   * source rows of their own. Only `sonar` ever fills this — see
   * `recordAtsBoards` for why the pipeline has exactly one compounding step.
   */
  boards?: { id: string; adapter: string; url: string; label: string }[]
}

/**
 * `region` and `category` are **custom fields and must be declared**, or
 * rss-parser drops them silently — the same trap `content:encoded` set for the
 * news pipeline. We Work Remotely puts the only location information it has in
 * `<region>`, so without this every WWR posting looks location-less.
 */
const parser = new Parser({
  timeout: jobPipeline.sourceTimeoutMs,
  headers: { 'user-agent': jobPipeline.userAgent },
  customFields: { item: ['region', 'category'] },
})

const clean = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const truncate = (value: string | null): string | null =>
  value === null ? null : value.slice(0, jobPipeline.maxDescriptionChars)

/** Parses a date a board printed, in whatever form, to epoch ms or null. */
function parseDate(value: unknown): number | null {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Remotive — `https://remotive.com/api/remote-jobs`.
 *
 * Everything here is remote by construction, so `remote` is not inferred.
 *
 * **Its `tags` are not trustworthy and are stored but never filtered on.** A
 * single agency posting carried 40 tags covering every language the agency has
 * ever staffed — `.Net`, `android`, `C`, `C#`, `golang`, `php`, `rust`, `unity`
 * on one graphic-design role. Filtering `mustHave` against tags would match that
 * posting for any stack in existence, which is why the filter reads the title
 * and description instead.
 *
 * **It is small.** The free endpoint returned `total-job-count: 31` on probing,
 * of which 10 were Software Development. Its own legal notice asks for
 * attribution and a link back — both of which the delivered message does — and
 * asks for at most four calls a day, which a two-day cadence is far inside.
 */
function fromRemotive(payload: unknown): RawPosting[] {
  const jobs = (payload as { jobs?: unknown[] })?.jobs
  if (!Array.isArray(jobs)) return []

  return jobs.flatMap((raw): RawPosting[] => {
    const job = raw as Record<string, unknown>
    const title = clean(job.title)
    const company = clean(job.company_name)
    const url = clean(job.url)
    if (!title || !company || !url) return []

    return [{
      company,
      title,
      location: clean(job.candidate_required_location),
      remote: 'remote',
      url,
      description: truncate(clean(job.description) && htmlToText(String(job.description))),
      salaryText: clean(job.salary),
      // `job_type` is sometimes an empty string rather than absent.
      contractType: clean(job.job_type)?.replace(/_/g, ' ') ?? null,
      tags: Array.isArray(job.tags) ? job.tags.filter((t): t is string => typeof t === 'string') : [],
      postedAt: parseDate(job.publication_date),
    }]
  })
}

/**
 * Arbeitnow — `https://www.arbeitnow.com/api/job-board-api`.
 *
 * The only source here with a real `remote` boolean and a real `location`, which
 * makes it the one that exercises the non-remote path at all.
 *
 * **It is a German-market board and mostly not technical.** 175 postings on page
 * one when probed, opening with a private-banking adviser at a savings bank, and
 * most descriptions are in German. It is kept because it is the only free source
 * with on-site European roles, and because the deterministic filters are exactly
 * what removes the rest — but nobody should expect its volume to be signal.
 *
 * Its titles carry `(m/w/d)` almost universally. `normalizeForIdentity` strips
 * anything bracketed for that reason, so the same role posted with and without
 * the suffix is one job.
 */
function fromArbeitnow(payload: unknown): RawPosting[] {
  const data = (payload as { data?: unknown[] })?.data
  if (!Array.isArray(data)) return []

  return data.flatMap((raw): RawPosting[] => {
    const job = raw as Record<string, unknown>
    const title = clean(job.title)
    const company = clean(job.company_name)
    const url = clean(job.url)
    if (!title || !company || !url) return []

    const types = Array.isArray(job.job_types)
      ? job.job_types.filter((t): t is string => typeof t === 'string')
      : []

    return [{
      company,
      title,
      location: clean(job.location),
      remote: job.remote === true ? 'remote' : 'onsite',
      url,
      description: truncate(clean(job.description) && htmlToText(String(job.description))),
      salaryText: null,
      contractType: types[0]?.replace(/_/g, ' ') ?? null,
      tags: Array.isArray(job.tags) ? job.tags.filter((t): t is string => typeof t === 'string') : [],
      postedAt: parseDate(job.created_at),
    }]
  })
}

/**
 * Company names a board prints when it has none.
 *
 * Himalayas returns the literal string `"name"` as `companyName` for a run of
 * its most recent postings — twenty in a row when probed, real names from offset
 * 20 onward. Storing that would put "name" under a posting in Telegram, and
 * worse, every such posting shares a company for identity purposes. Postings
 * with a placeholder employer are dropped rather than guessed at.
 */
const PLACEHOLDER_COMPANIES = new Set(['name', 'company', 'company name', 'n/a', 'unknown', '-'])

const isRealCompany = (company: string | null): company is string =>
  company !== null && !PLACEHOLDER_COMPANIES.has(company.trim().toLowerCase())

/**
 * Himalayas — `https://himalayas.app/jobs/api`.
 *
 * **The richest source here by some distance**: real `seniority`, real
 * `employmentType`, and `minSalary`/`maxSalary`/`currency` as numbers rather
 * than as prose. Everything on it is remote.
 *
 * Two things about it. It reports a `totalCount` in the tens of thousands but
 * caps a page at **20 whatever `limit` says**, so this takes the twenty newest
 * per run; widening it means seeding additional rows at higher `offset` values,
 * which is what makes sources rows rather than code. And it emits the literal
 * placeholder `"name"` for a company — see above.
 */
function fromHimalayas(payload: unknown): RawPosting[] {
  const jobs = (payload as { jobs?: unknown[] })?.jobs
  if (!Array.isArray(jobs)) return []

  return jobs.flatMap((raw): RawPosting[] => {
    const job = raw as Record<string, unknown>
    const title = clean(job.title)
    const company = clean(job.companyName)
    const url = clean(job.applicationLink) ?? clean(job.guid)
    if (!title || !isRealCompany(company) || !url) return []

    const min = typeof job.minSalary === 'number' ? job.minSalary : null
    const max = typeof job.maxSalary === 'number' ? job.maxSalary : null
    const currency = clean(job.currency) ?? ''
    const salaryText =
      min || max
        ? `${min ? min.toLocaleString('en-US') : '?'}–${max ? max.toLocaleString('en-US') : '?'} ${currency}`.trim()
        : null

    const restrictions = Array.isArray(job.locationRestrictions)
      ? job.locationRestrictions.filter((r): r is string => typeof r === 'string')
      : []

    return [{
      company,
      title,
      location: restrictions.join(', ') || null,
      remote: 'remote',
      url,
      description: truncate(clean(job.description) && htmlToText(String(job.description))),
      salaryText,
      contractType: clean(job.employmentType),
      // Its `categories` are derived from the title by Himalayas itself and are
      // far saner than a board where employers tag freely — but they are still a
      // source's tags, and nothing filters on those.
      tags: Array.isArray(job.categories)
        ? job.categories.filter((c): c is string => typeof c === 'string')
        : [],
      // Seconds, not milliseconds.
      postedAt: parseDate(job.pubDate),
    }]
  })
}

/**
 * Jobicy — `https://jobicy.com/api/v2/remote-jobs`.
 *
 * Clean and structured: `jobLevel`, `jobGeo`, `jobType`. Its notice asks that
 * Jobicy be credited with a direct link to the source and that application links
 * point at the original URL — both of which the delivered message does.
 */
function fromJobicy(payload: unknown): RawPosting[] {
  const jobs = (payload as { jobs?: unknown[] })?.jobs
  if (!Array.isArray(jobs)) return []

  return jobs.flatMap((raw): RawPosting[] => {
    const job = raw as Record<string, unknown>
    const title = clean(job.jobTitle)
    const company = clean(job.companyName)
    const url = clean(job.url)
    if (!title || !isRealCompany(company) || !url) return []

    const types = Array.isArray(job.jobType)
      ? job.jobType.filter((t): t is string => typeof t === 'string')
      : []
    const min = typeof job.annualSalaryMin === 'number' ? job.annualSalaryMin : null
    const currency = clean(job.salaryCurrency) ?? ''

    return [{
      company,
      title,
      location: clean(job.jobGeo),
      remote: 'remote',
      url,
      description: truncate(
        (clean(job.jobDescription) && htmlToText(String(job.jobDescription))) ?? clean(job.jobExcerpt),
      ),
      salaryText: min ? `from ${min.toLocaleString('en-US')} ${currency}`.trim() : null,
      contractType: types[0] ?? null,
      tags: clean(job.jobIndustry) ? [String(job.jobIndustry)] : [],
      postedAt: parseDate(job.pubDate),
    }]
  })
}

/**
 * RemoteOK — `https://remoteok.com/api`.
 *
 * **The first element of the array is a legal notice, not a job**, and it is
 * dropped by requiring a title and a company rather than by index — a payload
 * that stops carrying it should not silently lose a real posting.
 *
 * Its terms ask for a followed link back and attribution; the delivered message
 * links the posting's own URL and names the source. **Its tags are the worst of
 * any source measured**: a construction estimator arrived tagged `golang`,
 * `infosec`, `dev`, `engineer` and `technical`. Stored, never filtered on.
 */
function fromRemoteOk(payload: unknown): RawPosting[] {
  if (!Array.isArray(payload)) return []

  return payload.flatMap((raw): RawPosting[] => {
    const job = raw as Record<string, unknown>
    const title = clean(job.position)
    const company = clean(job.company)
    const url = clean(job.url) ?? clean(job.apply_url)
    if (!title || !isRealCompany(company) || !url) return []

    const min = typeof job.salary_min === 'number' ? job.salary_min : null
    const max = typeof job.salary_max === 'number' ? job.salary_max : null

    return [{
      company,
      title,
      location: clean(job.location),
      remote: 'remote',
      url,
      description: truncate(clean(job.description) && htmlToText(String(job.description))),
      salaryText:
        min || max
          ? `${min ? min.toLocaleString('en-US') : '?'}–${max ? max.toLocaleString('en-US') : '?'} USD`
          : null,
      contractType: null,
      tags: Array.isArray(job.tags) ? job.tags.filter((t): t is string => typeof t === 'string') : [],
      postedAt: parseDate(job.date ?? job.epoch),
    }]
  })
}

const API_ADAPTERS: Record<string, (payload: unknown) => RawPosting[]> = {
  remotive: fromRemotive,
  arbeitnow: fromArbeitnow,
  himalayas: fromHimalayas,
  jobicy: fromJobicy,
  remoteok: fromRemoteOk,
}

/** An rss-parser item plus the custom fields declared above. */
type JobFeedItem = Parser.Item & { region?: string; category?: string }

/**
 * Generic RSS, calibrated on We Work Remotely.
 *
 * **The title carries the company**, in the form `Company: Job Title` —
 * `Cloudflare: Principal Partner Solutions Engineer` — and it is the only place
 * the company appears. Splitting on the first colon is what recovers it. A title
 * with no colon keeps the whole string and takes the feed's label as its
 * employer, which is wrong but visible, rather than silently empty.
 *
 * Location comes from `<region>`, which is a **custom field** — see the parser
 * above. WWR's values are coarse (`Anywhere in the World`), so anything
 * mentioning "anywhere" or "remote" is treated as remote and everything from
 * these feeds is remote in practice.
 */
function fromRss(items: JobFeedItem[], source: JobSource): RawPosting[] {
  return items.flatMap((item): RawPosting[] => {
    const rawTitle = clean(item.title)
    const url = clean(item.link)
    if (!rawTitle || !url) return []

    const separator = rawTitle.indexOf(':')
    const hasCompany = separator > 0 && separator < rawTitle.length - 1
    const company = hasCompany ? rawTitle.slice(0, separator).trim() : source.label
    const title = hasCompany ? rawTitle.slice(separator + 1).trim() : rawTitle

    const region = clean(item.region)
    const remote: JobRemote =
      region === null || /anywhere|remote|worldwide/i.test(region) ? 'remote' : 'unknown'

    return [{
      company,
      title,
      location: region,
      remote,
      url,
      description: truncate(clean(item.contentSnippet) ?? (clean(item.content) && htmlToText(String(item.content)))),
      salaryText: null,
      contractType: null,
      tags: clean(item.category) ? [String(item.category)] : [],
      postedAt: parseDate(item.isoDate ?? item.pubDate),
    }]
  })
}

/**
 * Fetches one source and normalizes it, never throwing.
 *
 * A failure is a *result* rather than an exception, for the reason
 * `fetchFeed` does the same: one dead board must not take down a run that four
 * other sources would have succeeded on, and the failure has to be recorded on
 * the row so a source that quietly stops returning anything is visible.
 *
 * Conditional GET is honoured for both kinds. A 304 is a success with zero
 * postings, which is the normal state for a board that has not changed.
 */
export async function fetchJobSource(source: JobSource): Promise<JobFetchResult> {
  try {
    if (source.kind === 'rss') return await fetchRssSource(source)
    if (source.kind === 'api') return await fetchApiSource(source)
    if (source.kind === 'ats') return await fetchAtsSource(source)
    // `sonar` is wired, but not here: it needs a model handle and the reader's
    // active searches, which a function taking only a row cannot have. `findJobs`
    // routes it to `fetchSonarSource` in `services/job-scout.ts`. Reaching this
    // line with a `sonar` row means a caller iterated sources without that
    // routing — which is a bug in the caller, not a source that does not work.
    if (source.kind === 'sonar') {
      return {
        sourceId: source.id,
        postings: [],
        status: 'skipped',
        error: 'sonar is fetched by findJobs, not by fetchJobSource',
      }
    }
    return {
      sourceId: source.id,
      postings: [],
      status: 'skipped',
      error: `The "${source.kind}" kind is not wired yet`,
    }
  } catch (error) {
    return {
      sourceId: source.id,
      postings: [],
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * One discovered applicant-tracking board.
 *
 * **The row stores the employer-facing board URL, not the API endpoint**, and
 * `detectAtsBoard` recovers the provider and token from it. Two reasons, both
 * practical: the stored URL is then something a human can open to check what the
 * row actually is, and the endpoint shape stays a private detail of `ats.ts`
 * rather than being frozen into hundreds of rows that would all need rewriting if
 * a provider changed its API path.
 *
 * No conditional-GET state, unlike the board kinds above. These APIs answer with
 * the employer's current openings and carry no useful validators; a 304 that
 * never comes is not worth a column.
 */
async function fetchAtsSource(source: JobSource): Promise<JobFetchResult> {
  const board = detectAtsBoard(source.url)
  if (!board) {
    return {
      sourceId: source.id,
      postings: [],
      status: 'error',
      error: `"${source.url}" is not a readable ATS board URL`,
    }
  }

  const { postings, problem } = await fetchAtsBoard(board)
  return {
    sourceId: source.id,
    postings: postings.map(posting => ({
      ...posting,
      company: employer(posting.company, board.token, source.label),
    })),
    status: problem ? 'error' : '200',
    error: problem ?? undefined,
  }
}

/**
 * Which name a board's postings are filed under — and therefore whether they
 * dedupe against the same advert seen anywhere else.
 *
 * **The provider's own name when it publishes one, the source label otherwise,
 * and the bare token never.** Lever and Ashby publish no company name anywhere in
 * their posting API, so `ats.ts` files their postings under the board token —
 * `3pillarglobal`, `owner`. The row already knows better: its label is the
 * employer name the `sonar` lead that discovered the board carried, which is the
 * name every aggregator prints too.
 *
 * **Falling back to the label only when the adapter returned *empty* was not
 * enough, and the gap shipped duplicates — measured 2026-08-09.** The token is
 * not empty, so it always won: the same Lever advert reached the reader once as
 * `3Pillar Global` (via `sonar`) and once as `3pillarglobal` (via the board),
 * because `normalizeCompany` has no way to see those as one employer. Comparing
 * against the token is exact rather than heuristic — `ats.ts` fills in
 * `board.token` verbatim, and only when it had nothing else.
 *
 * A published name still wins over the label where there is one, for the reason
 * `job-identity.ts` gives for keying a lead on its URL: the label came from a
 * model's phrasing, and the provider's came from the employer.
 */
function employer(company: string, token: string, label: string): string {
  if (company && company !== token) return company
  return label || company || token
}

async function fetchApiSource(source: JobSource): Promise<JobFetchResult> {
  const adapter = source.adapter ? API_ADAPTERS[source.adapter] : undefined
  if (!adapter) {
    return {
      sourceId: source.id,
      postings: [],
      status: 'error',
      error: `No adapter called "${source.adapter ?? 'none'}"`,
    }
  }

  const response = await fetch(source.url, {
    headers: {
      'user-agent': jobPipeline.userAgent,
      accept: 'application/json',
      ...(source.etag ? { 'if-none-match': source.etag } : {}),
      ...(source.lastModified ? { 'if-modified-since': source.lastModified } : {}),
    },
    signal: AbortSignal.timeout(jobPipeline.sourceTimeoutMs),
  })

  if (response.status === 304) {
    return { sourceId: source.id, postings: [], status: '304', etag: source.etag, lastModified: source.lastModified }
  }
  if (!response.ok) {
    return { sourceId: source.id, postings: [], status: String(response.status), error: `HTTP ${response.status}` }
  }

  return {
    sourceId: source.id,
    postings: adapter(await response.json()),
    status: '200',
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  }
}

/**
 * RSS goes through `fetch` first rather than straight to rss-parser, because
 * rss-parser has no way to send a conditional request or to read the response
 * headers back — and an unconditional fetch of a board that publishes its whole
 * history is the thing `feed_state` exists to avoid on the news side.
 */
async function fetchRssSource(source: JobSource): Promise<JobFetchResult> {
  const response = await fetch(source.url, {
    headers: {
      'user-agent': jobPipeline.userAgent,
      accept: 'application/rss+xml, application/xml, text/xml',
      ...(source.etag ? { 'if-none-match': source.etag } : {}),
      ...(source.lastModified ? { 'if-modified-since': source.lastModified } : {}),
    },
    signal: AbortSignal.timeout(jobPipeline.sourceTimeoutMs),
  })

  if (response.status === 304) {
    return { sourceId: source.id, postings: [], status: '304', etag: source.etag, lastModified: source.lastModified }
  }
  if (!response.ok) {
    return { sourceId: source.id, postings: [], status: String(response.status), error: `HTTP ${response.status}` }
  }

  const feed = await parser.parseString(await response.text())
  return {
    sourceId: source.id,
    postings: fromRss(feed.items as JobFeedItem[], source),
    status: '200',
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  }
}
