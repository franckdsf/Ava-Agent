import Parser from 'rss-parser'
import { feedFinder, RACE_STOPWORDS } from '../config/feed-finder.js'
import { pipeline } from '../config/pipeline.js'
import { hostOf } from '../lib/url.js'

/**
 * Which sources **break** a story, and which repeat it days later.
 *
 * This is the measurement the rest of discovery could not make. `checkFeed()`
 * establishes that a feed is reachable, parses, and has recent entries — and a
 * blog that writes about a model release four days after everyone else passes
 * every one of those tests with a `publishedAt` from this morning. It is a
 * healthy feed and a late one, and no field on it says so.
 *
 * The only way to know is to compare sources against each other, so that is what
 * this does. Fetch every candidate, find the stories that several of them
 * covered, and for each story take the earliest publication as `t0`. A source's
 * lag on that story is its own first mention minus `t0`. Median those.
 *
 * **A story is a bursty token, not a topic.** Titles are reduced to tokens; a
 * token that several feeds used, inside a short window, is a story — `minimax`,
 * `flux`, `qwen`. A token that appears constantly is vocabulary and is dropped
 * by document frequency (`model`, `release`) and by `RACE_STOPWORDS`. Both
 * filters are needed: frequency alone fails on a small pool where a common word
 * looks rare, and the list alone cannot know what this month's filler word is.
 *
 * **Known limits, because this is a heuristic and reads like a fact.**
 * A shared token is not always a shared story — measured against the reader's
 * own database on 2026-08-06, `kimi` matched both Kimi K-series model coverage
 * and Kimi Räikkönen on an F1 feed. Splitting on `storyGapDays` handles the
 * common case (the same name months apart) and nothing handles a genuine
 * homonym inside one window. So `minStoriesToRank` exists, and a source is shown
 * unranked rather than scored on one coincidence.
 *
 * Nothing here writes, and it deliberately does its own fetching rather than
 * going through `rss.ts` — recording a conditional-GET etag for a feed that may
 * never be subscribed is the trap `0011_reset_feed_state.sql` exists to undo.
 */

const parser = new Parser({ timeout: pipeline.feedTimeoutMs })

/** One feed's entries, as the race needs them. */
interface RacedEntry {
  title: string
  at: number
}

export interface Timeliness {
  feedUrl: string
  /** Fetched and parsed. False means it took no part in the race. */
  ok: boolean
  problem: string | null
  entries: number
  /** Stories this feed appeared in at all. */
  stories: number
  /** Stories it published first. */
  broke: number
  /**
   * Median hours behind the first publisher, across the stories it covered.
   * Null when it covered fewer than `minStoriesToRank` — shown, never ranked.
   */
  medianLagHours: number | null
  /** Posts per week over the window, computed here rather than taken from a search. */
  postsPerWeek: number
  newestAt: number | null
}

/** A story the race found: a bursty token several feeds used. */
export interface Story {
  token: string
  /** Epoch ms of the earliest mention. */
  startedAt: number
  /** Feed URLs that covered it, earliest first. */
  coveredBy: { feedUrl: string; at: number }[]
}

export interface RaceResult {
  feeds: Timeliness[]
  stories: Story[]
}

/**
 * Titles → the tokens that could name a thing.
 *
 * Hyphens and dots are kept inside a token because the names that matter carry
 * them — `gpt-5`, `v4.1`, `minimax-h3`. Splitting on them would turn every model
 * name into the generic half (`gpt`, `minimax`) plus a number, and the number is
 * exactly what distinguishes one release from the last.
 *
 * **Only name-shaped tokens survive**, and that filter is doing more work than
 * the stopword list. Two live runs raced on `three`, `one`, `money`, `job` and
 * `development` — ordinary words that several blogs happened to use in the same
 * fortnight. A story is named after a *thing*, so a token qualifies when it
 * carries a digit (`gpt-5`, `h3`, `v4`) or appears capitalised mid-title
 * (`Grok`, `Qwen`, `Gemini`).
 *
 * Mid-title, because the first word of any sentence is capitalised and would
 * make every title's opening word a name. And capitalisation is ignored
 * entirely for a Title-Cased headline, where it says nothing at all — that
 * check is why `Best Ways To Save Money` contributes no candidates while
 * `Google ships Gemini 3` contributes two.
 */
export function tokenize(title: string): string[] {
  const words = title.split(/\s+/).filter(Boolean)

  // A headline where most substantial words are capitalised is Title Case, and
  // capitalisation there carries no information about what is a name.
  const substantial = words.filter(word => word.replace(/[^A-Za-z]/g, '').length >= 4)
  const capitalised = substantial.filter(word => /^[^A-Za-z]*[A-Z]/.test(word)).length
  const titleCased =
    substantial.length >= feedFinder.race.titleCaseMinWords &&
    capitalised / substantial.length >= feedFinder.race.titleCaseRatio

  const found = new Set<string>()
  for (const [index, word] of words.entries()) {
    const cleaned = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.\-]+$/g, '')
    const token = cleaned.toLowerCase().replace(/^[.\-]+|[.\-]+$/g, '')

    if (token.length < feedFinder.race.minTokenLength) continue
    if (RACE_STOPWORDS.has(token)) continue
    // A bare number is a year or a count, never a name on its own.
    if (/^[0-9.]+$/.test(token)) continue

    const hasDigit = /[0-9]/.test(token)
    const namedByCase = !titleCased && index > 0 && /^[A-Z]/.test(cleaned)
    if (!hasDigit && !namedByCase) continue

    found.add(token)
  }
  return [...found]
}

/** Fetches one candidate's recent entries. Never throws — a dead feed is a result. */
async function fetchEntries(url: string): Promise<{ entries: RacedEntry[]; problem: string | null }> {
  let body: string
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': pipeline.userAgent },
      redirect: 'follow',
      signal: AbortSignal.timeout(pipeline.feedTimeoutMs),
    })
    if (!response.ok) return { entries: [], problem: `the server answered HTTP ${response.status}` }
    body = await response.text()
  } catch (error) {
    return { entries: [], problem: error instanceof Error ? error.message : String(error) }
  }

  try {
    const parsed = await parser.parseString(body)
    const cutoff = Date.now() - feedFinder.race.windowDays * 86_400_000
    const entries = (parsed.items ?? [])
      .map(item => ({
        title: (item.title ?? '').trim(),
        at: Date.parse(item.isoDate ?? item.pubDate ?? ''),
      }))
      .filter(entry => entry.title.length > 0 && !Number.isNaN(entry.at) && entry.at >= cutoff)
      .slice(0, feedFinder.race.entriesPerFeed)
    return { entries, problem: entries.length === 0 ? 'no dated entries inside the window' : null }
  } catch {
    return {
      entries: [],
      problem: /<html/i.test(body.slice(0, 500))
        ? 'that is a web page, not an RSS or Atom feed'
        : 'it did not parse as RSS or Atom',
    }
  }
}

/**
 * Runs the race over a set of candidate feed URLs.
 *
 * The existing subscriptions are worth passing in alongside the candidates: they
 * are the baseline the reader already lives with, and a candidate is only
 * interesting if it beats them. It also thickens the pool, which is what makes
 * stories findable at all — two feeds is the minimum for a race and a handful of
 * candidates on a narrow subject often do not overlap on their own.
 */
export async function raceFeeds(feedUrls: readonly string[]): Promise<RaceResult> {
  const urls = [...new Set(feedUrls)]
  const fetched = new Map<string, { entries: RacedEntry[]; problem: string | null }>()

  for (let index = 0; index < urls.length; index += feedFinder.race.concurrency) {
    const batch = urls.slice(index, index + feedFinder.race.concurrency)
    const results = await Promise.all(batch.map(async url => [url, await fetchEntries(url)] as const))
    for (const [url, result] of results) fetched.set(url, result)
  }

  const live = [...fetched.entries()].filter(([, result]) => result.entries.length > 0)

  // Document frequency over every title in the pool, so "vocabulary" is defined
  // by this subject's own corpus rather than by a list written in advance.
  const totalTitles = live.reduce((sum, [, result]) => sum + result.entries.length, 0)
  const tokenTitleCount = new Map<string, number>()
  for (const [, result] of live) {
    for (const entry of result.entries) {
      for (const token of tokenize(entry.title)) {
        tokenTitleCount.set(token, (tokenTitleCount.get(token) ?? 0) + 1)
      }
    }
  }

  /** token → every mention of it, across every feed. */
  const mentions = new Map<string, { feedUrl: string; at: number }[]>()
  for (const [feedUrl, result] of live) {
    for (const entry of result.entries) {
      for (const token of tokenize(entry.title)) {
        const df = (tokenTitleCount.get(token) ?? 0) / Math.max(1, totalTitles)
        if (df > feedFinder.race.maxDocFrequency) continue
        if (!mentions.has(token)) mentions.set(token, [])
        mentions.get(token)!.push({ feedUrl, at: entry.at })
      }
    }
  }

  const stories: Story[] = []
  for (const [token, all] of mentions) {
    const sorted = [...all].sort((a, b) => a.at - b.at)
    const head = sorted[0]
    if (!head) continue

    // Split into episodes on a long gap: one name can carry several releases,
    // and measuring them as one story puts t0 weeks before half the mentions.
    let episode: typeof sorted = [head]
    const episodes: (typeof sorted)[] = []
    for (const mention of sorted.slice(1)) {
      const previous = episode[episode.length - 1]
      if (previous && mention.at - previous.at > feedFinder.race.storyGapDays * 86_400_000) {
        episodes.push(episode)
        episode = [mention]
      } else episode.push(mention)
    }
    episodes.push(episode)

    for (const ep of episodes) {
      const start = ep[0]
      const end = ep[ep.length - 1]
      if (!start || !end) continue
      // A token mentioned every few days chains into one story spanning the
      // whole window, whose t0 means nothing. News propagates in days.
      if (end.at - start.at > feedFinder.race.maxStorySpanDays * 86_400_000) continue
      // One mention per feed — the first. A feed that wrote three follow-ups is
      // not three data points, and counting it as such would let a prolific
      // source dominate its own lag figure.
      const firstByFeed = new Map<string, number>()
      for (const mention of ep) {
        if (!firstByFeed.has(mention.feedUrl)) firstByFeed.set(mention.feedUrl, mention.at)
      }
      if (firstByFeed.size < feedFinder.race.minFeedsPerStory) continue

      // **Distinct publishers, not distinct feeds.** A site's section feeds
      // overlap heavily — `blog.google/rss` and
      // `blog.google/technology/google-deepmind/rss` carry the same posts — so
      // without this a publisher races itself, wins every time, and its "broke
      // it" count is manufactured. Seen on the first run with both Google feeds
      // in the pool: six invented stories, all won by Google.
      const hosts = new Set(
        [...firstByFeed.keys()].map(hostOf).filter((host): host is string => host !== null),
      )
      if (hosts.size < feedFinder.race.minFeedsPerStory) continue

      stories.push({
        token,
        startedAt: start.at,
        coveredBy: [...firstByFeed.entries()]
          .map(([feedUrl, at]) => ({ feedUrl, at }))
          .sort((a, b) => a.at - b.at),
      })
    }
  }

  const lags = new Map<string, number[]>()
  const breaks = new Map<string, number>()
  for (const story of stories) {
    const t0 = story.startedAt
    for (const { feedUrl, at } of story.coveredBy) {
      if (!lags.has(feedUrl)) lags.set(feedUrl, [])
      lags.get(feedUrl)!.push((at - t0) / 3_600_000)
      if (at === t0) breaks.set(feedUrl, (breaks.get(feedUrl) ?? 0) + 1)
    }
  }

  const feeds: Timeliness[] = urls.map(feedUrl => {
    const result = fetched.get(feedUrl)
    const entries = result?.entries ?? []
    const own = lags.get(feedUrl) ?? []
    const sorted = [...own].sort((a, b) => a - b)
    const dates = entries.map(entry => entry.at)

    return {
      feedUrl,
      ok: entries.length > 0,
      problem: result?.problem ?? 'not fetched',
      entries: entries.length,
      stories: own.length,
      broke: breaks.get(feedUrl) ?? 0,
      medianLagHours:
        own.length >= feedFinder.race.minStoriesToRank
          ? (sorted[Math.floor(sorted.length / 2)] ?? null)
          : null,
      postsPerWeek: entries.length / (feedFinder.race.windowDays / 7),
      newestAt: dates.length > 0 ? Math.max(...dates) : null,
    }
  })

  return { feeds, stories: stories.sort((a, b) => b.coveredBy.length - a.coveredBy.length) }
}

/**
 * Ranked best-first: ranked feeds by median lag, then unranked ones.
 *
 * A feed with too few stories to judge sorts below every judged feed rather than
 * at the top or the bottom of them — it is an unknown, and an unknown outranking
 * a source measured at two hours behind would be the report lying.
 */
export function byTimeliness(a: Timeliness, b: Timeliness): number {
  if (a.medianLagHours === null && b.medianLagHours === null) return b.stories - a.stories
  if (a.medianLagHours === null) return 1
  if (b.medianLagHours === null) return -1
  return a.medianLagHours - b.medianLagHours || b.broke - a.broke
}
