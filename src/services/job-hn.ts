import { jobPipeline, jobHiringThread } from '../config/jobs.js'
import { htmlToText } from './article.js'
import type { JobRemote } from '../db/schema.js'
import type { RawPosting } from './job-fetch.js'

/**
 * Hacker News's monthly "Ask HN: Who is hiring?" thread, as a job source.
 *
 * **Why this is worth a source kind of its own.** Every free board this pipeline
 * reads is an aggregator, and aggregators skew the same way: they carry the
 * companies that pay to be listed, or that have an HR function large enough to
 * syndicate. The hiring thread is the opposite population — founders posting
 * their own roles, in their own words, for free. Measured 2026-08-17 the August
 * thread carried **375 top-level postings** with founding and early-stage roles
 * throughout, which is the exact population `founding-engineer-worldwide` exists
 * to find and the one every board in the table under-serves.
 *
 * **It cannot be an `api` row, and the reason is structural rather than fiddly.**
 * `API_ADAPTERS` maps a URL to a pure `(payload) => RawPosting[]`, which assumes
 * the URL is stable. This thread's id changes every month, so reading it is two
 * requests — find the current story, then page its comments — and a resolution
 * step is exactly what `kind` discriminates on. `sonar` set the precedent.
 *
 * **The parse is deliberately strict and drops what it cannot read.** The thread
 * has a stated convention — `Company | Role | Location | REMOTE | salary` on the
 * first line — which most posters follow and some ignore. A lenient parse of a
 * free-text comment produces a posting whose "company" is half a sentence, and
 * that is worse than nothing: it reaches the scorer, costs a slot, and pollutes
 * the dedupe with a key that will never match anything again. A comment that does
 * not carry at least a company and a role is skipped, and the count of skips is
 * reported so a month where the convention shifts is visible rather than silent.
 *
 * **The one defect left, stated rather than hidden.** A poster who omits the
 * company and opens with the role — `Senior Software Engineer | New York, NY` —
 * parses as company "Senior Software Engineer", title "New York, NY". Measured
 * on the August 2026 thread that is a handful of the 210 postings, and it is left
 * alone on purpose: every rule that would catch it ("does field one look like a
 * job title?") also misfires on the real employers whose names contain one, and
 * the damage is bounded. `filterJob` scans title, company *and* description
 * together, so the posting is still filtered correctly and still scored
 * correctly — what suffers is the employer name in the delivered message and the
 * dedupe key, which is a cosmetic loss against a silent rejection.
 */

interface AlgoliaStory {
  objectID?: unknown
  title?: unknown
  created_at_i?: unknown
}

interface AlgoliaComment {
  objectID?: unknown
  comment_text?: unknown
  created_at_i?: unknown
  author?: unknown
}

/** What one fetch of the thread came to. */
export interface HnFetchResult {
  postings: RawPosting[]
  /** The thread actually read, for the run log. */
  thread: string | null
  /** Comments that carried no readable role. Expected to be a minority. */
  unparsed: number
  error?: string
}

const clean = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { 'user-agent': jobPipeline.userAgent, accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

/**
 * The most recent "Who is hiring?" thread.
 *
 * **Matched on the author, never on the title.** `search_by_date` with
 * `author_whoishiring` returns exactly the threads that account posts, which is
 * a fact about who wrote them rather than about how they were worded — the same
 * reason `checkFeed()` decides what a feed is instead of trusting a search
 * result. Titles get edited and translated; the account does not change.
 *
 * The account posts three threads a month — hiring, wants-to-be-hired and
 * freelancer — so the title still has to be checked to pick the right one of the
 * three. That is a *disambiguation* among known-good candidates, not the
 * identification itself.
 */
async function latestHiringThread(signal: AbortSignal): Promise<AlgoliaStory | null> {
  const payload = await getJson(
    'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10',
    signal,
  )
  const hits = (payload as { hits?: unknown })?.hits
  if (!Array.isArray(hits)) return null
  return (
    (hits as AlgoliaStory[]).find(hit => {
      const title = clean(hit.title)?.toLowerCase() ?? ''
      return title.includes('who is hiring') || title.includes('who’s hiring') || title.includes("who's hiring")
    }) ?? null
  )
}

/**
 * Splits one comment into a posting.
 *
 * The first line is the header the thread asks for. Everything after it is the
 * advert, which is stored as the description and is what `filterJob` reads
 * `mustHave` out of — so a posting whose body says "TypeScript, React, Postgres"
 * is found by a stack search exactly as a board posting would be.
 *
 * **`REMOTE` is read as a word, not as a substring.** "REMOTE" and "Remote OK"
 * mean remote; "NO REMOTE" and "ONSITE" mean the opposite, and a naive
 * `includes('remote')` reads the first of those two as remote — which would send
 * on-site roles to a reader who asked for remote only, the one filter mistake
 * that is invisible until they have opened the advert.
 */
function parseComment(comment: AlgoliaComment): RawPosting | null {
  const raw = clean(comment.comment_text)
  const id = clean(comment.objectID)
  if (!raw || !id) return null

  // **Split the raw HTML, not the rendered text, and this is not a nicety.**
  // Hacker News separates paragraphs with a bare opening `<p>` and never closes
  // it, while `htmlToText` breaks on `</p>` — calibrated for real articles, where
  // the tag is closed. Rendering first therefore collapses the whole comment onto
  // one line, and measured against the live August thread that put the advert
  // body inside the header: 141 of 206 postings came out with **no description at
  // all** and salary fields read `$160–180kWe are a fast growing…`. A posting
  // with no description fails every `mustHave` there is, so the source would have
  // looked like it was working while quietly failing the one filter that matters.
  //
  // Fixed here rather than in `htmlToText` deliberately. That function is shared
  // with the news pipeline and its `</p>` rule is right for the HTML articles
  // ship; teaching it about unclosed tags to suit one job board is how a shared
  // helper acquires a caller's quirks.
  const [rawHeader = '', ...rawBody] = raw.split(/<p>/i)
  const header = htmlToText(rawHeader)
  const rest = rawBody.length > 0 ? [htmlToText(rawBody.join('<p>'))] : []
  const fields = header
    .split('|')
    .map(part => part.trim())
    .filter(part => part.length > 0)

  // Two fields is the floor: something to call the employer and something to
  // call the role. Below that the comment is a reply, a meta-discussion or a
  // free-text post, none of which is an advert.
  if (fields.length < 2) return null

  const [company, title, ...tail] = fields
  if (!company || !title || company.length > jobHiringThread.maxFieldChars) return null
  if (title.length > jobHiringThread.maxFieldChars) return null

  const remainder = tail.join(' | ')
  const haystack = `${remainder} ${header}`.toUpperCase()
  const remote: JobRemote = /\bNO\s+REMOTE\b|\bONSITE\b|\bON-SITE\b/.test(haystack)
    ? 'onsite'
    : /\bREMOTE\b/.test(haystack)
      ? 'remote'
      : 'unknown'

  // A field that names money rather than a place. Kept as text because that is
  // what the scorer reads; nothing here tries to parse a number out of "$160-180k
  // + equity", and a wrong number would be worse than the sentence.
  const salaryText = tail.find(part => /[$€£]|\bk\b|\bsalary\b/i.test(part)) ?? null

  // The location is the first trailing field that is neither the remote marker
  // nor the money — the convention puts it there, and the fields after it vary.
  const location =
    tail.find(
      part =>
        part !== salaryText &&
        !/^\s*(remote|onsite|on-site|no remote|hybrid)\s*$/i.test(part) &&
        part.length <= jobHiringThread.maxFieldChars,
    ) ?? null

  return {
    company,
    title,
    location,
    remote,
    // The comment's own permalink. Stable, and the thing `job-identity.ts` keys
    // on — two months of the same employer posting the same role are two adverts
    // with two ids, which is right: a repost is a signal the role is still open.
    url: `https://news.ycombinator.com/item?id=${id}`,
    description: rest.join('\n').trim().slice(0, jobPipeline.maxDescriptionChars) || null,
    salaryText,
    contractType: null,
    tags: [],
    // The comment's own timestamp, not the thread's. A thread stays open all
    // month and the postings in it are spread across that month, so taking the
    // story date would make every posting look like it appeared on the 1st — and
    // `ingestWindowDays` would then expire a whole month at once.
    postedAt: typeof comment.created_at_i === 'number' ? comment.created_at_i * 1000 : null,
  }
}

/**
 * Reads the current hiring thread.
 *
 * Never throws, for the reason `fetchJobSource` does not: one unreachable source
 * must not take down a run the other forty would have succeeded on.
 */
export async function fetchHiringThread(): Promise<HnFetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), jobPipeline.sourceTimeoutMs)
  try {
    const story = await latestHiringThread(controller.signal)
    const threadId = clean(story?.objectID)
    if (!threadId) {
      return { postings: [], thread: null, unparsed: 0, error: 'No "Who is hiring?" thread found' }
    }

    const payload = await getJson(
      `https://hn.algolia.com/api/v1/search?tags=comment,story_${threadId}` +
        `&hitsPerPage=${jobHiringThread.maxPostingsPerThread}`,
      controller.signal,
    )
    const hits = (payload as { hits?: unknown })?.hits
    if (!Array.isArray(hits)) {
      return { postings: [], thread: threadId, unparsed: 0, error: 'Thread returned no comments' }
    }

    const postings: RawPosting[] = []
    let unparsed = 0
    for (const hit of hits as AlgoliaComment[]) {
      // Replies are not adverts. The thread's own convention is that a top-level
      // comment is a job and everything below it is discussion, and Algolia gives
      // `parent_id` for free — without this check a thread's arguments about
      // salary transparency arrive as postings.
      if ((hit as { parent_id?: unknown }).parent_id !== Number(threadId)) continue
      const posting = parseComment(hit)
      if (posting) postings.push(posting)
      else unparsed += 1
    }

    return { postings, thread: threadId, unparsed }
  } catch (error) {
    return {
      postings: [],
      thread: null,
      unparsed: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}
