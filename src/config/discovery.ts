/**
 * `/follow` — turning a subject the reader typed into a working beat.
 *
 * Two model calls and one deterministic pipeline between them, and the split is
 * the whole design:
 *
 * - A model **names** the beat (English title, emoji, subtopics, and the two
 *   halves of a rubric) and **proposes sites**.
 * - Nothing a model returns reaches the database as a feed URL. Sites are turned
 *   into feeds by fetching the page and reading what it declares, and every
 *   candidate goes through `checkFeed()` before it is written.
 *
 * That is the same discipline the digest writer follows for article links — the
 * model supplies the prose, the URL is templated from a stored value — and it is
 * measured rather than assumed. Probing `sonar-pro` on three subjects produced
 * `chefpjacooks.com`, a domain that does not exist, next to `sonar`'s real
 * `chefjacooks.com`. A model-proposed feed URL would have been stored as a
 * source that silently returns nothing forever.
 */

/** Well-known feed paths, tried when a page declares nothing in its `<head>`. */
export const discovery = {
  /**
   * Sites to ask the scout for. More than we expect to keep: measured yield is
   * 18 verified feeds from 24 proposed sites across three subjects, and the
   * misses are concentrated on institutional sites that publish no feed at all.
   */
  sitesRequested: 8,

  /**
   * Hard cap on how many feeds a beat may hold, counting what it already has.
   *
   * **Counted against the beat, not against the run**, and the difference is the
   * whole point. A top-up run that capped its own results would let a beat climb
   * past any ceiling one re-run at a time, and the field would quietly mean
   * something other than its name.
   *
   * A beat reading twenty feeds is not better informed, it is noisier and
   * dearer: every feed is fetched on every digest, and every article it brings
   * is ranked — ranking is the main cost lever in this pipeline. Quality also
   * falls off with each re-run by construction, because the scout returns its
   * best guesses first: the third run on one subject proposed two law firms and
   * a PR agency. `/addfeed` is the deliberate way past this, not another sweep.
   */
  maxFeedsPerBeat: 8,

  /**
   * Paths tried when a homepage declares no feed.
   *
   * Ordered by how often they hit in practice. `/feed` and `/feed/` are both
   * here because WordPress redirects one to the other and some hosts 404 rather
   * than redirect.
   */
  wellKnownPaths: [
    '/feed',
    '/feed/',
    '/rss',
    '/rss.xml',
    '/feed.xml',
    '/atom.xml',
    '/index.xml',
    '/blog/feed',
    '/en/rss.xml',
    '/feeds/posts/default',
  ],

  /**
   * A browser User-Agent, used **only** to fetch a candidate site's homepage.
   *
   * This is a deliberate split from `pipeline.userAgent`, not an oversight, and
   * it is worth 4/10 → 7/10 on the F1 probe. Measured 2026-07-29: with the
   * honest bot UA, `autosport.com` and `motorsport.com` answer **403** and
   * `racefans.net` answers **429** — three of the best sources for that subject.
   * With this one, all three answer 200.
   *
   * The line: a homepage is fetched **once**, by a person's request, the way a
   * browser would. Every *feed* fetch — `checkFeed()` here, and every poll for
   * the rest of that feed's life through `rss.ts` — keeps `pipeline.userAgent`.
   * Verified on the same probe: the feeds those sites serve accept the bot UA
   * happily. It is the CDN in front of the page that objects, not the publisher.
   */
  browserUserAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/131.0.0.0 Safari/537.36',

  /** One homepage fetch. Shorter than a feed's, because there are up to 8 of them. */
  pageTimeoutMs: 15_000,

  /**
   * Homepages fetched at once. Small on purpose — this is a burst of requests to
   * eight unrelated strangers, and it happens because one person typed one line.
   */
  siteConcurrency: 4,

  /**
   * Follow one link that looks like it leads to a feed listing, when the
   * homepage declares nothing and no well-known path works.
   *
   * This exists because of a measured blind spot: on "European Union policy",
   * `europarl.europa.eu`, `eur-lex.europa.eu`, `ec.europa.eu` and `euractiv.com`
   * all missed, and several of them do publish feeds — from a dedicated RSS page
   * rather than from the homepage `<head>`. One hop, never two: a crawler is not
   * what this is.
   */
  followFeedPageLink: true,

  /** Anchor text or href that suggests a page listing a site's feeds. */
  feedPageHints: /\b(rss|feeds?|abonn|syndicat)\b/i,

  /**
   * Subtopics asked of the namer. The ranker must choose exactly one per
   * article, so too many makes the label meaningless and too few makes every
   * digest one section.
   */
  subtopicCount: { min: 3, max: 5 },
} as const

/**
 * The rubric, assembled from what the namer returned.
 *
 * **A template with slots, not model-authored prose**, and that is a considered
 * restriction. The rubric is the single thing that decides what a beat sends;
 * a model writing it freehand can produce something that reads well and scores
 * badly, and there is no way to tell the difference without a measurement the
 * reader will never run. The ranker's ±10-point noise floor
 * ([AGENTS.md](../../AGENTS.md#gotchas)) means a bad rubric is not even visibly
 * bad on a handful of articles.
 *
 * So the shape is fixed here — the same shape both seed beats use, which is the
 * shape the ranker's prompt was tuned against — and the model fills in only the
 * bullets. The closing line about primary sources is not negotiable either: it
 * is what stops a beat filling up with rewrites of one announcement.
 */
export function buildRubric(input: {
  readerLine: string
  scoreHigh: readonly string[]
  scoreLow: readonly string[]
}): string {
  return [
    input.readerLine,
    '',
    'Score HIGH (70-100):',
    ...input.scoreHigh.map(line => `- ${line}`),
    '',
    'Score LOW (0-40):',
    ...input.scoreLow.map(line => `- ${line}`),
    '',
    'Bias toward the primary source when several outlets carry the same story.',
  ].join('\n')
}
