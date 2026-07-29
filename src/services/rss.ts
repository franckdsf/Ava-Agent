import { createHash } from 'node:crypto'
import Parser from 'rss-parser'
import { pipeline } from '../config/pipeline.js'
import { getArticle } from '../db/articles.js'
import { getFeedState, saveFeedState } from '../db/feeds.js'
import type { Article, DiscoveredArticle } from '../db/types.js'
import { capText, htmlToText, toArticleText } from './article.js'

/**
 * `content:encoded` is where most feeds put the full article body, and
 * rss-parser drops unknown fields unless they are declared. Without this the
 * summarizer only ever sees a truncated excerpt.
 */
type MediaField = { $?: { url?: string } } | Array<{ $?: { url?: string } }>

type FeedEntryExtras = {
  'content:encoded'?: string
  'media:content'?: MediaField
  'media:thumbnail'?: MediaField
}

const parser = new Parser<Record<string, unknown>, FeedEntryExtras>({
  timeout: pipeline.feedTimeoutMs,
  customFields: { item: ['content:encoded', 'media:content', 'media:thumbnail'] },
})

function mediaUrl(field: MediaField | undefined): string | undefined {
  if (!field) return undefined
  return (Array.isArray(field) ? field[0] : field)?.$?.url
}

/**
 * Lead image, in descending order of how deliberate it is: an explicit
 * enclosure, then the media:* extensions, then the first inline image in the
 * body. Every source is a plain URL — Telegram fetches it at send time, so
 * nothing is downloaded here.
 *
 * Only three of the sixteen configured feeds publish one at all, so returning
 * null is the normal case, not a failure.
 */
function toImageUrl(entry: {
  enclosure?: { url?: string; type?: string }
  'media:content'?: MediaField
  'media:thumbnail'?: MediaField
  'content:encoded'?: string
  content?: string
}): string | null {
  const enclosure = entry.enclosure
  const candidate =
    (enclosure?.url && /^image\//i.test(enclosure.type ?? '') ? enclosure.url : undefined) ??
    mediaUrl(entry['media:content']) ??
    mediaUrl(entry['media:thumbnail']) ??
    /<img[^>]+src=["']([^"']+)["']/i.exec(entry['content:encoded'] ?? entry.content ?? '')?.[1]

  if (!candidate) return null
  // Telegram fetches this itself and rejects anything it can't reach.
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Tracking parameters that differ per referrer and would defeat dedupe. */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|ref_?$|source$)/i

/**
 * Canonicalizes a URL so the same article from different referrers hashes
 * identically. This is what makes the primary-key dedupe actually work.
 */
export function canonicalizeLink(link: string): string {
  try {
    const url = new URL(link.trim())
    url.hash = ''
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    url.protocol = 'https:'
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
    }
    return url.toString()
  } catch {
    return link.trim()
  }
}

export function articleId(link: string): string {
  return createHash('sha256').update(canonicalizeLink(link)).digest('hex').slice(0, 32)
}

/**
 * The stored article a URL points at — null if it was never ingested, or has
 * since been pruned.
 *
 * The inverse of `articleId`, and only possible because of it: the id *is* the
 * hash of the canonical link, so any URL for an article is already its primary
 * key. That is what lets a reader point at a delivered digest without anything
 * having recorded which message carried which article
 * ([ADR-0013](../../docs/decisions/0013-swipe-to-reply-as-article-context.md)).
 */
export function articleForLink(link: string): Promise<Article | null> {
  return getArticle(articleId(link))
}

function toExcerpt(raw: string | undefined): string | null {
  if (!raw) return null
  const text = htmlToText(raw).replace(/\s+/g, ' ').trim()
  return text ? capText(text, pipeline.excerptMaxChars) : null
}

/** The minimum a fetch needs to know about a feed: where it is, and what to call it. */
export interface FeedRef {
  url: string
  source: string
}

export interface FeedFetchResult {
  feedUrl: string
  articles: DiscoveredArticle[]
  /** Server answered 304 — nothing changed since our last fetch. */
  notModified: boolean
  error?: string
}

/**
 * Fetches one feed using conditional GET. A feed that fails is reported, never
 * thrown: one dead feed must not take down a whole run.
 *
 * Takes no beat. `feed_state` is keyed by URL globally, so a feed two beats both
 * subscribe to must be fetched exactly once per run — fetching it per beat gave
 * the second one a 304 and no articles at all. Which beats these articles belong
 * to is decided by the caller, from the subscriptions on the URL.
 */
export async function fetchFeed(feed: FeedRef): Promise<FeedFetchResult> {
  const previous = await getFeedState(feed.url)
  const headers: Record<string, string> = { 'User-Agent': pipeline.userAgent }
  if (previous?.etag) headers['If-None-Match'] = previous.etag
  if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified

  try {
    const response = await fetch(feed.url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(pipeline.feedTimeoutMs),
    })

    if (response.status === 304) {
      await saveFeedState({
        feedUrl: feed.url,
        etag: previous?.etag ?? null,
        lastModified: previous?.lastModified ?? null,
        lastStatus: '304',
        lastError: null,
      })
      return { feedUrl: feed.url, articles: [], notModified: true }
    }

    if (!response.ok) {
      const error = `HTTP ${response.status}`
      await saveFeedState({
        feedUrl: feed.url,
        etag: previous?.etag ?? null,
        lastModified: previous?.lastModified ?? null,
        lastStatus: String(response.status),
        lastError: error,
      })
      return { feedUrl: feed.url, articles: [], notModified: false, error }
    }

    const parsed = await parser.parseString(await response.text())
    const oldestAccepted = Date.now() - pipeline.maxItemAgeDays * 24 * 60 * 60 * 1000

    const found: DiscoveredArticle[] = []
    for (const entry of parsed.items ?? []) {
      const link = entry.link ?? entry.guid
      const title = entry.title?.trim()
      if (!link || !title) continue
      const published = entry.isoDate ?? entry.pubDate
      const publishedAt = published ? Date.parse(published) : Number.NaN
      // Undated entries are kept — they just showed up, so treat them as current.
      if (!Number.isNaN(publishedAt) && publishedAt < oldestAccepted) continue
      found.push({
        id: articleId(link),
        feedUrl: feed.url,
        source: feed.source,
        title,
        link: canonicalizeLink(link),
        excerpt: toExcerpt(entry.contentSnippet ?? entry.content ?? entry.summary),
        // Widest source wins: content:encoded carries the full body, content is
        // often the same or a teaser, contentSnippet is already stripped.
        content: toArticleText(
          entry['content:encoded'] ?? entry.content ?? entry.contentSnippet ?? entry.summary,
        ),
        imageUrl: toImageUrl(entry),
        publishedAt: Number.isNaN(publishedAt) ? null : publishedAt,
      })
    }

    await saveFeedState({
      feedUrl: feed.url,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      lastStatus: String(response.status),
      lastError: null,
    })

    return { feedUrl: feed.url, articles: found, notModified: false }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await saveFeedState({
      feedUrl: feed.url,
      etag: previous?.etag ?? null,
      lastModified: previous?.lastModified ?? null,
      lastStatus: 'error',
      lastError: error,
    })
    return { feedUrl: feed.url, articles: [], notModified: false, error }
  }
}

/**
 * Fetches a set of distinct feeds in parallel. Failures are reported, not thrown.
 *
 * The caller is responsible for the set being distinct — this is the only place
 * a feed is fetched, and fetching one twice in a run means the second call is a
 * guaranteed 304 with nothing in it. `dedupeFeeds` builds that set.
 */
export async function fetchFeeds(feeds: readonly FeedRef[]): Promise<FeedFetchResult[]> {
  return Promise.all(feeds.map(feed => fetchFeed(feed)))
}

/**
 * Collapses per-beat subscriptions into one entry per URL.
 *
 * Several beats may subscribe to the same feed, each with its own `source`
 * label and subtopic pin. Only one of them can describe the fetch, so the first
 * subscription's `source` wins — the label is an attribution shown under an
 * article, and two beats disagreeing about what to call Hacker News is not worth
 * a second HTTP request.
 */
export function dedupeFeeds(subscriptions: readonly FeedRef[]): FeedRef[] {
  const byUrl = new Map<string, FeedRef>()
  for (const subscription of subscriptions) {
    if (!byUrl.has(subscription.url)) byUrl.set(subscription.url, subscription)
  }
  return [...byUrl.values()]
}
