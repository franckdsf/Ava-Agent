import { jobPipeline, jobScout } from '../config/jobs.js'
import type { JobRemote } from '../db/schema.js'
import { htmlToText } from './article.js'
import type { RawPosting } from './job-fetch.js'
import { clean, parseDate, truncate } from './posting-fields.js'

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
 * body**. That last part is the selection rule, and it is the whole reason this
 * list is six providers rather than the fifty-odd trackers that exist. A second
 * sweep on 2026-08-06 added three and rejected five, all verified live:
 *
 * - **Workable** and **Recruitee** pass outright, and both publish the employer's
 *   own name in the list payload — so they get the `companyAgrees` check that
 *   ADR-0027 could only give Greenhouse, which makes four of six providers
 *   checkable instead of one of three.
 * - **Personio** passes, and it is the one ADR-0027 named as the largest remaining
 *   gap — *the* European SME tracker, and therefore the best route to the
 *   non-software employers this pipeline exists to reach. **It was never really a
 *   rate-limit problem.** The `429`s recorded then did not reproduce (six
 *   consecutive `200`s); the real blocker is that `<jobDescriptions>` comes back
 *   *present but empty* unless the request carries `?language=en`, which reads
 *   exactly like a board with no bodies. With the parameter: 3,300–5,700
 *   characters a position.
 * - **Breezy HR** and **Rippling** are keyless and answer fine, but neither puts a
 *   description in the list — the same N+1 that keeps **SmartRecruiters** out,
 *   re-confirmed unchanged. Add any of them when there is a reason to spend a
 *   request per posting.
 * - **Workday** fails twice over, which is worth recording because it is the
 *   biggest tracker here by headcount. Its list carries `title`, a path and
 *   `"Posted Today"` — not a description and not even a real date — *and* its URL
 *   needs a datacenter, a tenant and a site name
 *   (`nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite`),
 *   none of which is derivable from a domain label. See `probeAtsBoards` for why
 *   that second half is disqualifying on its own.
 * - **Teamtailor** has no keyless endpoint at all: `api.teamtailor.com/v1/jobs`
 *   answers `406` without an `X-Api-Key`, and per-tenant `jobs.json` / `jobs.rss`
 *   are `404`.
 *
 * **The domain generality is the point, not a side effect.** These boards are not
 * tech boards. Figure's Greenhouse board was 18 non-engineering roles out of 19 —
 * Chief Credit Officer, Account Administration Associate, Business Development
 * Manager — each a real advert of about 6,000 characters with a real location. A
 * dental group's board lists its hygienists exactly the way a startup's lists its
 * engineers, which is what a pipeline that must answer `/target dentist` needs and
 * what the four remaining remote-tech boards can never provide.
 */

/**
 * The trackers this module can read, in probe order — see `PROBE_ORDER`.
 */
export type AtsProvider =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workable'
  | 'recruitee'
  | 'personio'

export interface AtsBoard {
  provider: AtsProvider
  /** The employer's board slug, as it appears in the careers URL. */
  token: string
}

/**
 * The board a resolved careers URL belongs to, or null.
 *
 * **The token lives in one of two places and which one is per-provider.**
 * Greenhouse, Lever, Ashby and Workable put it in the first path segment; those
 * are matched on host *and* segment, never the host alone, because every one of
 * these providers serves its own marketing site from the same domain and
 * `greenhouse.io/customers` is not a board. A missing or reserved segment is a
 * null rather than a token — the alternative is requesting
 * `/v1/boards/customers/jobs` and recording a 404 as if an employer had no jobs.
 *
 * Recruitee and Personio put it in the *subdomain* instead, so for those the path
 * is irrelevant and `acme.recruitee.com/o/some-role` is the same board as
 * `acme.recruitee.com`.
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
  /** The leftmost label, for the providers that key on it. */
  const label = host.split('.')[0]

  if (host === 'greenhouse.io' || host.endsWith('.greenhouse.io')) {
    // `…/embed/job_board?for=acme` — the token is in the query, not the path.
    const embedded = parsed.searchParams.get('for')
    if (embedded) return board('greenhouse', embedded)
    return first === 'embed' ? null : board('greenhouse', first)
  }
  if (host === 'lever.co' || host.endsWith('.lever.co')) return board('lever', first)
  if (host === 'ashbyhq.com' || host.endsWith('.ashbyhq.com')) return board('ashby', first)

  // Workable serves every board from one host — `apply.workable.com/acme` — and
  // still answers the older per-tenant `acme.workable.com`.
  if (host === 'apply.workable.com') return board('workable', first)
  if (host.endsWith('.workable.com')) return board('workable', label)

  if (host.endsWith('.recruitee.com')) return board('recruitee', label)
  // Personio answers on both TLDs; `.de` is the canonical one and the one probed.
  if (host.endsWith('.jobs.personio.de') || host.endsWith('.jobs.personio.com')) {
    return board('personio', label)
  }

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
  // `apply.workable.com/j/186545F8C1` is a single advert, and it is the URL
  // Workable puts on every posting it returns — so unlike the rest of this set,
  // this one is certain to be met rather than merely plausible.
  'j',
  // Provider-owned *subdomains*, which matter now that Recruitee, Personio and
  // per-tenant Workable read the leftmost label as the token. `www` never
  // reaches here — it is stripped before matching — but the rest do.
  'help', 'support', 'app', 'api', 'assets', 'status', 'docs',
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
  workable: token => `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`,
  recruitee: token => `https://${token}.recruitee.com/api/offers/`,
  // `language` is load-bearing, not a preference. Without it every
  // `<jobDescriptions>` element comes back present and empty — see the module
  // doc; it is the entire reason Personio looked unusable until now.
  personio: token => `https://${token}.jobs.personio.de/xml?language=en`,
}

const BOARD_URLS: Record<AtsProvider, (token: string) => string> = {
  greenhouse: token => `https://job-boards.greenhouse.io/${token}`,
  lever: token => `https://jobs.lever.co/${token}`,
  ashby: token => `https://jobs.ashbyhq.com/${token}`,
  workable: token => `https://apply.workable.com/${token}`,
  recruitee: token => `https://${token}.recruitee.com`,
  personio: token => `https://${token}.jobs.personio.de`,
}

/** The employer-facing URL for a board — what an `ats` source row stores. */
export function atsBoardUrl(board: AtsBoard): string {
  return BOARD_URLS[board.provider](board.token)
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

/**
 * Whether a location string describes remote work.
 *
 * `unknown` rather than `onsite` when it says nothing, for the reason the whole
 * filter leans that way: `search.remote === 'required'` rejects only `onsite`, so
 * guessing "on-site" from a silent field would quietly discard real remote roles,
 * while `unknown` costs a scoring slot the model can judge properly.
 *
 * **A bare place is decided by the advert, not by the location.** This used to
 * answer `onsite` for any location without a remote word in it: Elastic posts each
 * remote role once per country — `Spain`, `Greece`, `Poland` — so 0 of its 136
 * postings read as remote, and its full-stack roles never reached a model. But
 * reading every bare place as `unknown` overshoots: measured on 2026-10-29, it
 * re-opened 2,065 stored postings, 1,462 of which would have reached the scorer
 * for one search alone. The advert separates them — an employer's own board is
 * where it says remote if the role is, and about 500 of those 2,065 mention it.
 * So a place with an advert that never says remote is on-site, and one that does
 * is `unknown`, for the model to judge the rest.
 *
 * Explicit words in the location win over the advert either way. `Hybrid` stays
 * `unknown`, for the reason Recruitee's flag does, and `Home Office` is not read
 * as remote because it is also how an American employer names its headquarters.
 */
export function remoteFrom(location: string | null, description: string | null, flag?: boolean): JobRemote {
  if (flag === true) return 'remote'
  if (!location) return 'unknown'
  if (/\b(remote|anywhere|distributed|work from home|home[- ]based)\b/i.test(location)) return 'remote'
  if (/\b(on[- ]?site|in[- ]office|office[- ]based|in[- ]person)\b/i.test(location)) return 'onsite'
  if (/\bhybrid\b/i.test(location)) return 'unknown'
  return description && /\bremote(ly)?\b|\bdistributed (team|company)\b|\bwork from (anywhere|home)\b/i.test(description)
    ? 'unknown'
    : 'onsite'
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
    const description = truncate(htmlToText(htmlToText(String(job.content ?? ''))))

    return [{
      company: clean(job.company_name) ?? board.token,
      title,
      location,
      remote: remoteFrom(location, description),
      url,
      description,
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
      remote: remoteFrom(location, body, clean(job.workplaceType)?.toLowerCase() === 'remote'),
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
    const description = truncate(
      clean(job.descriptionPlain) ?? (clean(job.descriptionHtml) && htmlToText(String(job.descriptionHtml))),
    )

    return [{
      company: board.token,
      title,
      location,
      remote: remoteFrom(location, description, job.isRemote === true),
      url,
      description,
      salaryText: null,
      contractType: clean(job.employmentType),
      tags: [clean(job.department), clean(job.team)].filter((tag): tag is string => tag !== null),
      postedAt: parseDate(job.publishedAt),
    }]
  })
}

/**
 * Workable — `apply.workable.com/api/v1/widget/accounts/{token}?details=true`.
 *
 * **`details=true` is the difference between a title list and an advert.** The
 * widget without it returns titles and locations; with it, `description` is the
 * full HTML body — 154KB over Blueground's 28 postings, measured 2026-08-06.
 *
 * The employer's name is on the *account*, not the posting, so it is read once
 * from the envelope and stamped on every row. That envelope name is what lets
 * `probeAtsBoards` check Workable for company agreement.
 */
function fromWorkable(payload: unknown, board: AtsBoard): RawPosting[] {
  const account = payload as { name?: unknown; jobs?: unknown[] }
  const jobs = account?.jobs
  if (!Array.isArray(jobs)) return []

  const company = clean(account.name) ?? board.token

  return jobs.flatMap((raw): RawPosting[] => {
    const job = raw as Record<string, unknown>
    const title = clean(job.title)
    const url = clean(job.url) ?? clean(job.shortlink) ?? clean(job.application_url)
    if (!title || !url) return []

    // City, state and country are three fields and any of them can be an empty
    // string rather than absent, so the location is joined from whichever are
    // really there instead of formatted from a fixed template.
    const location =
      [clean(job.city), clean(job.state), clean(job.country)].filter(Boolean).join(', ') || null
    const description = truncate(clean(htmlToText(String(job.description ?? ''))))

    return [{
      company,
      title,
      location,
      remote: remoteFrom(location, description, job.telecommuting === true),
      url,
      description,
      salaryText: null,
      contractType: clean(job.employment_type),
      tags: [clean(job.department), clean(job.function)].filter(
        (tag): tag is string => tag !== null,
      ),
      postedAt: parseDate(job.published_on ?? job.created_at),
    }]
  })
}

/**
 * Recruitee — `{token}.recruitee.com/api/offers/`.
 *
 * Three booleans instead of one — `remote`, `on_site` and `hybrid` — and
 * **`hybrid` maps to `unknown`, not `onsite`**. It is the only honest answer: a
 * hybrid role is neither, and `search.remote === 'required'` rejects `onsite`
 * outright, so calling it on-site would silently discard roles a reader asking
 * for remote might well accept. `unknown` costs a scoring slot and lets the model
 * decide, which is the same trade `remoteFrom` already makes for a silent field.
 *
 * `careers_url` is usually on the employer's *own* domain
 * (`werkenbij.vandebron.nl/o/…`) rather than Recruitee's, which is a better
 * identity signal than the provider-hosted URLs the other five produce.
 */
function fromRecruitee(payload: unknown, board: AtsBoard): RawPosting[] {
  const offers = (payload as { offers?: unknown[] })?.offers
  if (!Array.isArray(offers)) return []

  return offers.flatMap((raw): RawPosting[] => {
    const job = raw as Record<string, unknown>
    const title = clean(job.title)
    const url = clean(job.careers_url) ?? clean(job.careers_apply_url)
    if (!title || !url) return []

    const location =
      clean(job.location) ??
      ([clean(job.city), clean(job.country)].filter(Boolean).join(', ') || null)

    // `requirements` is frequently null and the whole advert sits in
    // `description`, but when it is filled it is the part naming a qualification
    // — the same split Lever has, and the same reason to keep both.
    const body = [clean(job.description), clean(job.requirements)].filter(Boolean).join('\n\n')

    const remote: JobRemote =
      job.remote === true ? 'remote'
      : job.hybrid === true ? 'unknown'
      : job.on_site === true ? 'onsite'
      : remoteFrom(location, body)

    return [{
      company: clean(job.company_name) ?? board.token,
      title,
      location,
      remote,
      url,
      description: truncate(clean(htmlToText(body))),
      salaryText: salaryFromRecruitee(job.salary),
      contractType: clean(job.employment_type_code),
      tags: [clean(job.department), ...(Array.isArray(job.tags) ? job.tags.map(clean) : [])].filter(
        (tag): tag is string => tag !== null,
      ),
      postedAt: parseDate(job.published_at ?? job.created_at),
    }]
  })
}

/**
 * Recruitee's salary object, or null when it is the empty shell it usually is.
 *
 * Every field arrives as `null` on a board that does not publish pay, so the
 * object is always present and almost always says nothing. Formatting it
 * unconditionally would write `"null–null null"` into every row.
 */
function salaryFromRecruitee(value: unknown): string | null {
  const salary = value as { min?: unknown; max?: unknown; currency?: unknown; period?: unknown } | null
  if (!salary) return null
  const min = clean(String(salary.min ?? '')) ?? null
  const max = clean(String(salary.max ?? '')) ?? null
  if (!min && !max) return null
  const range = min && max ? `${min}–${max}` : (min ?? max)
  return [range, clean(String(salary.currency ?? '')), clean(String(salary.period ?? ''))]
    .filter(Boolean)
    .join(' ')
}

/** The text of the first `<tag>` in a fragment, CDATA unwrapped and tags stripped. */
function xmlText(fragment: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(fragment)
  if (!match?.[1]) return null
  // CDATA markers must go *before* `htmlToText`, not after. `<![CDATA[` is not a
  // well-formed tag, so a tag-stripping pass starting there runs to the first
  // `>` it finds — which is inside the body's own `<br>` — and eats real text.
  return clean(htmlToText(match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')))
}

/**
 * Personio — `{token}.jobs.personio.de/xml?language=en`.
 *
 * The only non-JSON provider here, and the XML is why it is worth the exception:
 * flat `<position>` blocks whose one nested element is `<jobDescriptions>`, a
 * list of `<name>`/`<value>` section pairs. That is the same shape as Lever's
 * `lists[]` and it is read the same way — **the sections are the advert**, and
 * the one naming a qualification is never the first.
 *
 * Two traps, both structural rather than incidental:
 *
 * - **`<name>` means two different things in one document.** It is the position's
 *   title as a direct child, and a section heading inside `<jobDescriptions>`. So
 *   the description block is lifted out first and the flat fields are read from
 *   what remains, rather than trusting document order to keep them apart.
 * - **Personio publishes no per-posting URL at all**, so it is constructed from
 *   the id. Verified 2026-08-06: `…/job/{id}` answers 200.
 */
function fromPersonio(payload: unknown, board: AtsBoard): RawPosting[] {
  const xml = typeof payload === 'string' ? payload : ''

  return [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].flatMap(
    ([, block = '']): RawPosting[] => {
      const descriptions = /<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/.exec(block)?.[1] ?? ''
      const flat = block.replace(/<jobDescriptions>[\s\S]*?<\/jobDescriptions>/, '')

      const title = xmlText(flat, 'name')
      const id = xmlText(flat, 'id')
      if (!title || !id) return []

      const body = [...descriptions.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)]
        .map(([, section = '']) =>
          `${xmlText(section, 'name') ?? ''}\n${xmlText(section, 'value') ?? ''}`.trim(),
        )
        .filter(Boolean)
        .join('\n\n')

      const location = xmlText(flat, 'office')

      return [{
        // `<subcompany>` is the hiring legal entity — "Wandelbots GmbH" — which
        // is a real employer name and makes Personio checkable for agreement.
        company: xmlText(flat, 'subcompany') ?? board.token,
        title,
        location,
        remote: remoteFrom(location, body),
        url: `${atsBoardUrl(board)}/job/${id}`,
        description: truncate(clean(body)),
        salaryText: null,
        contractType: xmlText(flat, 'employmentType'),
        tags: [xmlText(flat, 'department'), xmlText(flat, 'recruitingCategory')].filter(
          (tag): tag is string => tag !== null,
        ),
        postedAt: parseDate(xmlText(flat, 'createdAt')),
      }]
    },
  )
}

const ADAPTERS: Record<AtsProvider, (payload: unknown, board: AtsBoard) => RawPosting[]> = {
  greenhouse: fromGreenhouse,
  lever: fromLever,
  ashby: fromAshby,
  workable: fromWorkable,
  recruitee: fromRecruitee,
  personio: fromPersonio,
}

/**
 * Providers that publish the employer's own name in the list payload.
 *
 * Only these can be checked for company agreement, and it is the difference
 * between a board resting on evidence and a board resting on a token match.
 * ADR-0027 recorded this as a cost when Greenhouse was the only one; Workable,
 * Recruitee and Personio each carry a name too, so it now covers four of six.
 */
export const PUBLISHES_COMPANY: ReadonlySet<AtsProvider> = new Set<AtsProvider>([
  'greenhouse',
  'workable',
  'recruitee',
  'personio',
])

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
  const pattern = new RegExp(
    [
      String.raw`(?:https?:\/\/)?(?:boards|job-boards)\.greenhouse\.io\/[^"'\s<>)]+`,
      String.raw`(?:https?:\/\/)?(?:www\.)?greenhouse\.io\/embed\/job_board(?:\/js)?\?for=[a-z0-9_-]+`,
      String.raw`(?:https?:\/\/)?jobs\.lever\.co\/[^"'\s<>)]+`,
      String.raw`(?:https?:\/\/)?jobs\.ashbyhq\.com\/[^"'\s<>)]+`,
      String.raw`(?:https?:\/\/)?api\.ashbyhq\.com\/posting-api\/job-board\/[a-z0-9_-]+`,
      // Workable is matched host-first so `apply.workable.com/acme` wins over the
      // per-tenant form; both resolve through `detectAtsBoard`.
      String.raw`(?:https?:\/\/)?apply\.workable\.com\/[^"'\s<>)]+`,
      String.raw`(?:https?:\/\/)?[a-z0-9-]+\.workable\.com[^"'\s<>)]*`,
      String.raw`(?:https?:\/\/)?[a-z0-9-]+\.recruitee\.com[^"'\s<>)]*`,
      String.raw`(?:https?:\/\/)?[a-z0-9-]+\.jobs\.personio\.(?:de|com)[^"'\s<>)]*`,
    ].join('|'),
    'gi',
  )

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
 * **Four of the six can be checked for company agreement, and two cannot.**
 * Greenhouse, Workable, Recruitee and Personio each publish the employer's own
 * name, so a token collision — some *other* Figure — is caught by comparing it to
 * the employer we were looking for. Lever and Ashby publish no company name
 * anywhere in their posting API, so a board found there still rests on the token
 * match alone. The exposure is bounded by what the reader is sent: every posting
 * carries the employer's own URL, so a mismatch is visible in one click.
 *
 * **A provider that cannot be reached from a domain label cannot be added here at
 * all**, however good its data. That is the disqualifying half of Workday: its
 * URL needs a datacenter, a tenant *and* a site name, so there is nothing to
 * derive and this function has no question to ask. Such a provider could only
 * ever arrive through `findAtsBoardInHtml` — the path ADR-0027 measured at 1 of 6
 * — which is not enough to carry a source on its own.
 *
 * **The probes run concurrently.** Sequentially they cost one `pageTimeoutMs`
 * each in the worst case, so six providers would be up to 90s of wall time per
 * employer and 45 minutes across a full run — the reason the provider count
 * looked like the binding constraint. It isn't: fanning out makes the wall time
 * one timeout regardless of how many providers there are. What concurrency does
 * cost is the early exit — a Greenhouse hit used to stop after one request and
 * now always spends six. At `leadsPerSearch × maxSearchesPerRun` that is 180
 * requests a day worst case, spread across six different hosts, which is not a
 * number worth optimising against. `PROBE_ORDER` still decides *which* hit wins
 * when more than one answers, so behaviour is unchanged where it matters.
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

  const probes = await Promise.all(
    PROBE_ORDER.map(async (provider): Promise<AtsBoard | null> => {
      const probe: AtsBoard = { provider, token: candidate.token }
      const { postings } = await fetchAtsBoard(probe)
      if (postings.length === 0) return null
      if (PUBLISHES_COMPANY.has(provider) && !companyAgrees(postings[0]?.company, company, token)) {
        return null
      }
      return probe
    }),
  )

  return probes.find((probe): probe is AtsBoard => probe !== null) ?? null
}

/**
 * Which provider wins when a token resolves on more than one.
 *
 * Ordered by measured hit rate, so the winner of a tie is the board most likely
 * to be the employer's real one rather than a slug collision. The three added on
 * 2026-08-06 go after the three ADR-0027 measured, because their hit rate is
 * genuinely unknown — the endpoints were verified, the frequency was not.
 */
const PROBE_ORDER: readonly AtsProvider[] = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'recruitee',
  'personio',
]

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
    // Personio is the one XML provider, so its payload reaches the adapter as a
    // string and `fromPersonio` is the only one that expects one.
    const isXml = board.provider === 'personio'

    const response = await fetch(API_URLS[board.provider](board.token), {
      headers: {
        'user-agent': jobPipeline.userAgent,
        accept: isXml ? 'application/xml' : 'application/json',
      },
      signal: AbortSignal.timeout(jobScout.pageTimeoutMs),
    })
    if (!response.ok) {
      return { postings: [], problem: `${board.provider} board answered HTTP ${response.status}` }
    }

    const payload = isXml ? await response.text() : await response.json()
    const postings = ADAPTERS[board.provider](payload, board)
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
