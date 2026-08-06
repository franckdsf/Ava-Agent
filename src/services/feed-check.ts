import Parser from 'rss-parser'
import { pipeline } from '../config/pipeline.js'

/**
 * Is this URL a feed, and is it a feed worth having?
 *
 * Two callers, present and future, and they need the same answer. `/addfeed`
 * runs this before writing a subscription, so a typo is refused rather than
 * stored as a source that silently returns nothing forever. The discovery
 * workflow will run it over every candidate it finds, which is what stops a
 * model-proposed URL reaching the database — the model may *suggest* a feed, but
 * only a real fetch may confirm one.
 *
 * It reports rather than judging, mostly. `ok` is the one hard verdict —
 * reachable, parseable, and carrying at least one entry — and everything else is
 * evidence the reader decides on. Whether 3 entries a year is "enough" is not
 * this function's call.
 *
 * Deliberately its own fetch rather than a call through `rss.ts`. That path
 * writes `feed_state`, and recording a conditional-GET etag for a URL we may not
 * subscribe to would make the *first real ingest* of that feed answer 304 and
 * return nothing — the same trap `0011_reset_feed_state.sql` exists to undo.
 * Checking a feed must leave no trace.
 */

const parser = new Parser({
  timeout: pipeline.feedTimeoutMs,
  customFields: { item: ['content:encoded'] },
})

export interface FeedCheck {
  url: string
  /** Reachable, parseable, and carrying at least one entry. */
  ok: boolean
  /** Why not, when `ok` is false. Null when it is. */
  problem: string | null
  /** The feed's own title, which is the best default for a source label. */
  title: string | null
  entries: number
  /** Most recent entry date, so a long-dead feed is visible before it is adopted. */
  newestAt: number | null
  /** Whether entries carry a full body. Feeds without one summarize far worse. */
  hasBodies: boolean
  /** Whether the server supports a conditional GET — polite polling, not a blocker. */
  conditionalGet: 'etag' | 'last-modified' | 'none'
}

function failed(url: string, problem: string): FeedCheck {
  return {
    url,
    ok: false,
    problem,
    title: null,
    entries: 0,
    newestAt: null,
    hasBodies: false,
    conditionalGet: 'none',
  }
}

/**
 * The attribution shown under every article a feed delivers.
 *
 * A feed's own `<title>` is the best *starting point* for this and is routinely
 * not a name. Two shapes come up constantly and both are handled here:
 *
 * - **A title that is really a sentence.** PlanetF1 ships 200 characters of
 *   marketing copy as its title. Anything still over `sourceMaxChars` after
 *   trimming falls back to the hostname, which is always a name.
 * - **A title with a section suffix.** `Autosport.com - All - Stories` and
 *   `F1Technical.net . Motorsport news` are the site name plus a feed
 *   description. The first segment is the part a reader recognises.
 *
 * Shared by `/addfeed` and by discovery so the label a feed gets does not depend
 * on which added it.
 */
export function sourceLabel(title: string | null, url: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  })()

  // A feed whose title is really its own query. arXiv's API names the feed after
  // the search — `arXiv Query: search_query=cat:cs.AI AND (abs:"large language
  // model" OR abs:"LLM")&id_list=&start=0&max_results=40`, 113 characters — so
  // the length fallback below reduces every such feed to `export.arxiv.org`, and
  // two different queries become one indistinguishable name under every article
  // they deliver, in `/beat`, and in the weekly review's report.
  //
  // The category is the honest attribution and it is already in the URL, so no
  // one has to type a name. Two queries over the *same* category still collide;
  // that is the case where a hand-written label would be worth having.
  // Decoded first: a hand-typed URL carries a literal `cat:` and a generated one
  // carries `cat%3A`, and matching only the raw form silently reduced every
  // *generated* feed to `export.arxiv.org` — the exact bug this branch exists to
  // prevent, reintroduced by the encoder.
  const decoded = (() => {
    try {
      return decodeURIComponent(url)
    } catch {
      return url
    }
  })()
  const category = decoded.match(/cat:([a-z-]+(?:\.[A-Za-z-]+)?)/)?.[1]
  if (category && /arxiv\.org$/i.test(host)) return `arXiv ${category}`

  const trimmed = title?.trim()
  if (!trimmed) return host

  // Only split when the first segment is substantial — "The Race" must survive,
  // and a title beginning with a stray dash must not become an empty string.
  // En-dash and em-dash both appear here; a class holding only one of them left
  // `Contexte – Politiques françaises et européennes` unsplit.
  const [first] = trimmed.split(/\s+[-–—|·:]{1,2}\s+|\s+\.\s+/)
  const candidate = (first ?? '').trim().length >= 3 ? (first ?? '').trim() : trimmed

  return candidate.length <= pipeline.sourceMaxChars ? candidate : host
}

/** Rejects anything that isn't an absolute http(s) URL, before a request is made. */
export function normalizeFeedUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

/** Fetches and parses one candidate feed. Never throws — a bad URL is a result. */
export async function checkFeed(rawUrl: string): Promise<FeedCheck> {
  const url = normalizeFeedUrl(rawUrl)
  if (!url) return failed(rawUrl, 'not a valid http(s) URL')

  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': pipeline.userAgent },
      redirect: 'follow',
      signal: AbortSignal.timeout(pipeline.feedTimeoutMs),
    })
  } catch (error) {
    return failed(url, error instanceof Error ? error.message : String(error))
  }

  if (!response.ok) return failed(url, `the server answered HTTP ${response.status}`)

  const body = await response.text()
  let parsed: Awaited<ReturnType<typeof parser.parseString>>
  try {
    parsed = await parser.parseString(body)
  } catch {
    // The overwhelmingly common case is a page rather than a feed, and saying so
    // is more useful than the parser's own message about an unexpected token.
    return failed(
      url,
      /<html/i.test(body.slice(0, 500))
        ? 'that is a web page, not an RSS or Atom feed'
        : 'it did not parse as RSS or Atom',
    )
  }

  const entries = parsed.items ?? []
  if (entries.length === 0) return failed(url, 'it parsed but contained no entries')

  const dates = entries
    .map(entry => Date.parse(entry.isoDate ?? entry.pubDate ?? ''))
    .filter(value => !Number.isNaN(value))

  return {
    url,
    ok: true,
    problem: null,
    title: parsed.title?.trim() || null,
    entries: entries.length,
    newestAt: dates.length > 0 ? Math.max(...dates) : null,
    // Sampled over the first few rather than all of them: feeds are consistent
    // about this, and Figma serves 437 entries.
    hasBodies: entries
      .slice(0, 5)
      .some(entry => Boolean((entry as { 'content:encoded'?: string })['content:encoded'])),
    conditionalGet: response.headers.get('etag')
      ? 'etag'
      : response.headers.get('last-modified')
        ? 'last-modified'
        : 'none',
  }
}
