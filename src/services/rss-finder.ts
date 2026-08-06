import { rssFinder } from '../config/rss-finder.js'

/**
 * Asking rssfinder.app what feeds it knows about a subject, or about a site.
 *
 * One POST, no key, no dependency — the same shape as every other outbound call
 * here. The endpoint is the site's own, described in
 * [`src/config/rss-finder.ts`](../config/rss-finder.ts).
 *
 * **A result is a candidate, not a feed.** Nothing in this module fetches the
 * URLs it returns, and nothing here writes: an index can be stale, and a feed URL
 * that 404s is indistinguishable from a working one until something fetches it.
 * `checkFeed()` is that something, and it stays the only authority — see the note
 * on the config module.
 *
 * The site's two result sets are merged rather than reported apart. They are one
 * question asked two ways, the caller did not choose which branch it was taking,
 * and in practice a domain search comes back in `textResult` anyway — measured
 * 2026-08-06: `https://simonwillison.net` returned its two real Atom feeds under
 * `textResult` with `urlResult` empty. Merging means that lands wherever the
 * endpoint decides to put it.
 */

/** One feed the index knows about. Unverified — see the module note. */
export interface FinderFeed {
  url: string
  title: string | null
  description: string | null
  /** The site's favicon, when the index has one. Often null. */
  icon: string | null
}

export interface FinderSearch {
  /** What was actually sent, after URL normalization. */
  text: string
  feeds: FinderFeed[]
  /** The "Related Topics" chips — adjacent subjects, worth a second search. */
  related: string[]
}

export class RssFinderError extends Error {
  constructor(
    message: string,
    readonly reason: 'network' | 'http' | 'graphql' | 'shape',
  ) {
    super(message)
    this.name = 'RssFinderError'
  }
}

/** Whether the input looks like a site rather than a subject. */
function looksLikeUrl(input: string): boolean {
  if (/\s/.test(input)) return false
  if (/^https?:\/\//i.test(input)) return true
  // A bare hostname: at least one dot, and a TLD that isn't a file extension.
  return /^[^./\s]+(\.[^./\s]+)+(\/.*)?$/.test(input)
}

/**
 * What the site's own input would have sent.
 *
 * The page prefixes anything URL-shaped with `https://` before sending it, and
 * the endpoint answers a bare `bbc.com` differently from `https://bbc.com`. This
 * has to match, or the script and the site disagree about the same query.
 */
export function searchText(input: string): string {
  const trimmed = input.trim()
  if (!looksLikeUrl(trimmed)) return trimmed
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

interface FinderResultSet {
  feeds?: ({ url?: string | null } & Partial<FinderFeed>)[] | null
  related?: (string | null)[] | null
}

/**
 * Searches the index. Throws rather than returning an empty result on failure —
 * "the endpoint is gone" and "this subject has no feeds" are different answers,
 * and a caller that cannot tell them apart will report the first as the second.
 */
export async function searchRssFinder(input: string): Promise<FinderSearch> {
  const text = searchText(input)

  let response: Response
  try {
    response = await fetch(rssFinder.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        operationName: 'searchInFinder',
        variables: { text },
        query: rssFinder.query,
      }),
      signal: AbortSignal.timeout(rssFinder.timeoutMs),
    })
  } catch (error) {
    throw new RssFinderError(`could not reach ${rssFinder.endpoint}: ${String(error)}`, 'network')
  }

  if (!response.ok) {
    throw new RssFinderError(`${rssFinder.endpoint} answered ${response.status}`, 'http')
  }

  let payload: {
    data?: { searchInFinder?: { textResult?: FinderResultSet | null; urlResult?: FinderResultSet | null } | null }
    errors?: { message?: string }[]
  }
  try {
    payload = await response.json()
  } catch (error) {
    throw new RssFinderError(`answer was not JSON: ${String(error)}`, 'shape')
  }

  if (payload.errors?.length) {
    const messages = payload.errors.map(e => e.message ?? 'unknown').join('; ')
    throw new RssFinderError(`GraphQL error: ${messages}`, 'graphql')
  }

  const result = payload.data?.searchInFinder
  if (!result) {
    // A 200 with no `searchInFinder` means the operation the bundle used has
    // moved. Say so plainly — this is the failure to expect first.
    throw new RssFinderError('answer carried no searchInFinder — the query has probably changed', 'shape')
  }

  const feeds: FinderFeed[] = []
  const related: string[] = []
  const seen = new Set<string>()

  for (const set of [result.textResult, result.urlResult]) {
    for (const feed of set?.feeds ?? []) {
      const url = feed?.url?.trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      feeds.push({
        url,
        title: feed.title?.trim() || null,
        description: feed.description?.trim() || null,
        icon: feed.icon?.trim() || null,
      })
    }
    for (const topic of set?.related ?? []) {
      const trimmed = topic?.trim()
      if (trimmed && !related.includes(trimmed)) related.push(trimmed)
    }
  }

  return { text, feeds, related }
}
