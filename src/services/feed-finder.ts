import { feedFinder } from '../config/feed-finder.js'
import { hostOf } from '../lib/url.js'
import { searchRssFinder } from './rss-finder.js'

/**
 * Candidate sources for a subject, from a search that already knows about feeds.
 *
 * `finder.wprssaggregator.com/api/topic-search` is Brave-backed, so unlike
 * rssfinder.app it is a real search rather than a fixed taxonomy — and unlike a
 * general web search it answers with **feed URLs**, plus two fields worth having:
 * `velocity` and `lastUpdated`. Measured 2026-08-06, `flux image model` returned
 * `blog.fal.ai` ("Generative AI Model Releases & Tutorials. FLUX updates"),
 * `blogs.nvidia.com` and `openrouter.ai/blog` — the source class this repo's own
 * discovery had never found, because the scout proposes *sites* it can name and
 * these are blogs nobody would think to name.
 *
 * **It returns few results and good ones.** Between 1 and 5 per query, against
 * rssfinder's flat 7 of mixed quality; `limit` is accepted and ignored. Breadth
 * comes from `searchTopics()` asking several phrasings and merging.
 *
 * Nothing here is trusted. Every URL still goes through `checkFeed()`, and then
 * through the race in `feed-timeliness.ts` — which is the part that decides
 * whether a source is early or late, since no metadata field can say that.
 */

/** One candidate, as the search describes it. Unverified and unraced. */
export interface FoundFeed {
  feedUrl: string
  title: string | null
  description: string | null
  /** The page the feed belongs to, when the search knows it. */
  website: string | null
  /**
   * Posts per **week** — verified against `openrouter.ai/blog`, which the API
   * reports as `3.24` and which publishes roughly three times a week. Null when
   * the search did not compute one.
   */
  velocity: number | null
  /** Newest entry the search saw, epoch ms. Null when unknown. */
  lastUpdated: number | null
  /** Which search produced it, so a report can say where a candidate came from. */
  via: 'topic-search' | 'rssfinder'
}

export class FeedFinderError extends Error {
  constructor(
    message: string,
    readonly reason: 'network' | 'http' | 'shape',
  ) {
    super(message)
    this.name = 'FeedFinderError'
  }
}

interface TopicSearchRow {
  feedUrl?: string | null
  title?: string | null
  description?: string | null
  website?: string | null
  velocity?: number | null
  lastUpdated?: number | null
}

/** One topic search. Throws on a dead endpoint, for the reason `searchRssFinder` does. */
export async function searchTopic(query: string): Promise<FoundFeed[]> {
  const text = query.trim()
  if (!text) return []

  let response: Response
  try {
    response = await fetch(feedFinder.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ q: text }),
      signal: AbortSignal.timeout(feedFinder.timeoutMs),
    })
  } catch (error) {
    throw new FeedFinderError(`could not reach ${feedFinder.endpoint}: ${String(error)}`, 'network')
  }

  // A 400 here is the endpoint rejecting the query rather than being broken —
  // an empty `q` answers `{"error": "Provide a topic to search for."}`. Treated
  // as "no results" so one bad phrasing cannot fail a whole multi-query run.
  if (response.status === 400) return []
  if (!response.ok) {
    throw new FeedFinderError(`${feedFinder.endpoint} answered ${response.status}`, 'http')
  }

  let payload: { results?: TopicSearchRow[] | null }
  try {
    payload = await response.json()
  } catch (error) {
    throw new FeedFinderError(`answer was not JSON: ${String(error)}`, 'shape')
  }

  const rows = payload.results
  if (!Array.isArray(rows)) {
    throw new FeedFinderError('answer carried no results array — the API has probably changed', 'shape')
  }

  return rows
    .filter((row): row is TopicSearchRow & { feedUrl: string } => Boolean(row?.feedUrl?.trim()))
    .map(row => ({
      feedUrl: row.feedUrl.trim(),
      title: row.title?.trim() || null,
      description: row.description?.trim() || null,
      website: row.website?.trim() || null,
      velocity: typeof row.velocity === 'number' ? row.velocity : null,
      lastUpdated: typeof row.lastUpdated === 'number' ? row.lastUpdated : null,
      via: 'topic-search' as const,
    }))
}

/**
 * Several phrasings, merged and deduped by feed URL.
 *
 * One query is not enough breadth here — the endpoint is precise rather than
 * generous, and two phrasings of the same subject return almost disjoint sets
 * (`ai model releases` → fal.ai, digitalapplied; `open weights model launch` →
 * thinkingmachines, openrouter, kingy). Bounded by `maxQueries` because this is
 * the search shape invariant 2 asks to have a bound on.
 *
 * A failing query is skipped rather than fatal: one phrasing is not worth losing
 * the other five over. If *every* query fails, the error is rethrown — otherwise
 * a dead endpoint would look exactly like a subject nobody writes about.
 */
export async function searchTopics(queries: readonly string[]): Promise<FoundFeed[]> {
  const asked = queries.map(query => query.trim()).filter(Boolean).slice(0, feedFinder.maxQueries)
  if (asked.length === 0) return []

  const merged = new Map<string, FoundFeed>()
  const failures: Error[] = []

  for (const query of asked) {
    try {
      for (const feed of await searchTopic(query)) {
        // First writer wins: an earlier query is a closer phrasing of the
        // subject, and the rows are otherwise identical.
        if (!merged.has(feed.feedUrl)) merged.set(feed.feedUrl, feed)
      }
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  if (failures.length === asked.length) throw failures[0]
  return [...merged.values()]
}

/**
 * What a site publishes, when the search knows the site but not its feed.
 *
 * rssfinder.app's one strong axis — measured 2 of 2 on `simonwillison.net`,
 * `autosport.com` and `f1technical.net`, the last of which this repo's own
 * discovery cannot resolve because a CDN refuses the homepage fetch while the
 * feed server answers fine.
 *
 * **Filtered to the host asked about.** `formula1.com` returns BBC Sport's F1
 * feed, so an unfiltered lookup silently attributes a stranger's feed to the
 * site — the one behaviour that would make this dangerous rather than merely
 * imprecise.
 */
export async function findFeedsForDomain(domain: string): Promise<FoundFeed[]> {
  const wanted = hostOf(withScheme(domain))
  const search = await searchRssFinder(domain)

  return search.feeds
    .filter(feed => {
      if (wanted === null) return true
      const host = hostOf(withScheme(feed.url))
      return host !== null && (host === wanted || host.endsWith(`.${wanted}`) || wanted.endsWith(`.${host}`))
    })
    .map(feed => ({
      feedUrl: feed.url,
      title: feed.title,
      description: feed.description,
      website: null,
      velocity: null,
      lastUpdated: null,
      via: 'rssfinder' as const,
    }))
}

/**
 * Drops the obviously dormant before anything is fetched.
 *
 * Weak on purpose — see `feedFinder.gates`. A candidate the search reported no
 * numbers for **passes**: absent metadata is not evidence of anything, and the
 * race will judge it properly in a moment.
 */
export function passesGates(feed: FoundFeed, now = Date.now()): boolean {
  if (feed.velocity !== null && feed.velocity < feedFinder.gates.minVelocity) return false
  if (feed.lastUpdated !== null) {
    const staleDays = (now - feed.lastUpdated) / 86_400_000
    if (staleDays > feedFinder.gates.maxStaleDays) return false
  }
  return true
}

/**
 * A bare `formula1.com` as a URL, so the strict `hostOf` can read it. The reader
 * types a domain, and rss-finder's answers arrive either way.
 */
function withScheme(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}
