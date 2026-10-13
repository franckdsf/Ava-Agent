import { discovery } from '../config/discovery.js'
import { hostOf } from '../lib/url.js'
import { checkFeed, normalizeFeedUrl, type FeedCheck } from './feed-check.js'
import { fetchPage as fetchWebPage } from './page-fetch.js'

/**
 * Site → feed, deterministically. The half of `/follow` that no model touches.
 *
 * A model may say "RaceFans publishes about Formula 1". It may **not** say where
 * RaceFans' feed lives — that is a fact about a server, and the only way to know
 * it is to ask the server. This module asks, in three escalating steps, and
 * `checkFeed()` is the sole authority on whether the answer is a feed:
 *
 * 1. What the page declares — `<link rel="alternate" type="application/rss+xml">`.
 * 2. Well-known paths (`/feed`, `/rss.xml`, …).
 * 3. One hop to a page that looks like it lists the site's feeds.
 *
 * **Measured, 2026-07-29**, against the sites `sonar` proposed for three
 * subjects: 18 of 24 sites yielded a feed. The failures are honest —
 * `formula1.com` publishes none, `wtf1.com` 404s, `f1technical.net` sits behind
 * a CDN that refuses everything. Institutional sites are the weak spot and the
 * reason step 3 exists.
 *
 * Nothing here writes. `checkFeed()` is deliberately its own fetch rather than a
 * call through `rss.ts`, so probing a URL we may not subscribe to cannot record
 * a conditional-GET etag and make the first real ingest answer 304.
 */

/** One site's outcome — the feed it yielded, or why it yielded none. */
export interface SiteDiscovery {
  /** The homepage the scout proposed, normalized. */
  homepage: string
  /** The verified feed, or null when the site produced none. */
  feed: FeedCheck | null
  /** How it was found, for the report. Null when nothing was found. */
  via: 'declared' | 'well-known' | 'feed-page' | null
  /** Why nothing was found. Null on success. */
  problem: string | null
}

/**
 * Fetches a page as a browser would.
 *
 * `discovery.browserUserAgent` rather than `pipeline.userAgent`, and only here —
 * see the note on that field. Never throws: an unreachable homepage is a result,
 * because the well-known paths are still worth trying against a page that 403s.
 */
async function fetchPage(url: string): Promise<string> {
  const page = await fetchWebPage(url, {
    userAgent: discovery.browserUserAgent,
    timeoutMs: discovery.pageTimeoutMs,
  })
  return page.html
}

/**
 * Feed URLs a page declares in its `<head>`.
 *
 * Attribute order is not fixed — `rel` before `type` and the reverse both occur
 * in the wild — so each attribute is tested independently rather than with one
 * pattern that assumes an order.
 *
 * **Comment feeds are dropped here, and that matters.** Every WordPress site
 * declares `…/comments/feed/` immediately beside its real feed, and the first
 * candidate that parses wins — so without this filter a beat would end up
 * subscribed to a comment stream, which parses perfectly and is worthless.
 */
export function declaredFeeds(html: string, pageUrl: string): string[] {
  const found: string[] = []
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?[^"'>]*\balternate\b/i.test(tag)) continue
    if (!/\btype\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue
    if (/comment/i.test(tag)) continue
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
    if (!href) continue
    try {
      // An href inside HTML is entity-encoded; `&amp;` in a query string is the
      // common one and it produces a URL that 404s if left as written.
      found.push(new URL(href.replace(/&amp;/g, '&'), pageUrl).toString())
    } catch {
      // A relative href against a base we can't parse is not a candidate.
    }
  }
  return [...new Set(found)]
}

/**
 * One link that plausibly leads to a page listing the site's feeds.
 *
 * Deliberately returns at most one. This is a fallback for institutional sites
 * that keep their feeds on a dedicated page, not the beginning of a crawler —
 * following every match would turn one reader's command into a site-wide sweep.
 */
export function feedPageLink(html: string, pageUrl: string): string | null {
  for (const [tag, href] of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (!href || !discovery.feedPageHints.test(tag)) continue
    try {
      const resolved = new URL(href.replace(/&amp;/g, '&'), pageUrl)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
      // A link straight back to the page we are already on buys nothing.
      if (resolved.toString() === pageUrl) continue
      return resolved.toString()
    } catch {
      continue
    }
  }
  return null
}

/** The first candidate that `checkFeed()` accepts, or null. */
async function firstWorking(candidates: readonly string[]): Promise<FeedCheck | null> {
  for (const candidate of candidates) {
    const check = await checkFeed(candidate)
    if (check.ok) return check
  }
  return null
}

/**
 * Finds one site's feed, or reports that it has none.
 *
 * One feed per site, not all of them: a site publishing a dozen section feeds
 * would otherwise fill a beat on its own, and the main feed is what "follow this
 * site" means. A reader who wants the section feed adds it with `/addfeed`.
 */
export async function discoverSiteFeed(rawHomepage: string): Promise<SiteDiscovery> {
  const homepage = normalizeFeedUrl(rawHomepage)
  if (!homepage) {
    return { homepage: rawHomepage, feed: null, via: null, problem: 'not a valid http(s) URL' }
  }

  const html = await fetchPage(homepage)

  const declared = declaredFeeds(html, homepage)
  const fromDeclared = await firstWorking(declared)
  if (fromDeclared) return { homepage, feed: fromDeclared, via: 'declared', problem: null }

  const guesses = discovery.wellKnownPaths
    .map(path => {
      try {
        return new URL(path, homepage).toString()
      } catch {
        return null
      }
    })
    .filter((url): url is string => url !== null && !declared.includes(url))
  const fromGuess = await firstWorking(guesses)
  if (fromGuess) return { homepage, feed: fromGuess, via: 'well-known', problem: null }

  if (discovery.followFeedPageLink && html) {
    const link = feedPageLink(html, homepage)
    if (link) {
      const page = await fetchPage(link)
      const fromPage = await firstWorking(declaredFeeds(page, link))
      if (fromPage) return { homepage, feed: fromPage, via: 'feed-page', problem: null }
    }
  }

  return {
    homepage,
    feed: null,
    via: null,
    problem: html ? 'no feed found on the site' : 'the site could not be fetched',
  }
}

/**
 * Runs `discoverSiteFeed` over every site, a few at a time, and keeps the
 * distinct working feeds.
 *
 * Deduped by resolved feed URL rather than by proposed homepage, because two
 * proposals genuinely collapse: `racefans.net` and `www.racefans.net` are one
 * site, and `japan.recipetineats.com` and `recipetineats.com` were proposed
 * separately by two different models for the same subject.
 *
 * `exclude` is the beat's existing subscriptions. Filtering by **hostname**, not
 * by URL, because the scout proposes homepages — and it is checked here rather
 * than trusted to the prompt. The prompt is told too, but only so it does not
 * waste its eight slots; a negative instruction is a hint, never a guard.
 */
export async function discoverFeeds(
  homepages: readonly string[],
  exclude: readonly string[] = [],
): Promise<SiteDiscovery[]> {
  const excludedHosts = new Set(
    exclude.map(url => hostOf(url)).filter((host): host is string => host !== null),
  )

  const pending = homepages.filter(homepage => {
    const host = hostOf(homepage)
    return host === null || !excludedHosts.has(host)
  })

  const results: SiteDiscovery[] = []
  for (let index = 0; index < pending.length; index += discovery.siteConcurrency) {
    const batch = pending.slice(index, index + discovery.siteConcurrency)
    results.push(...(await Promise.all(batch.map(discoverSiteFeed))))
  }

  const seen = new Set<string>()
  return results.filter(result => {
    if (!result.feed) return true
    const host = hostOf(result.feed.url)
    if (host !== null && excludedHosts.has(host)) return false
    if (seen.has(result.feed.url)) return false
    seen.add(result.feed.url)
    return true
  })
}
