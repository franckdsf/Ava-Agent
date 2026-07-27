/**
 * Pipeline tunables. These are the knobs worth turning while calibrating the
 * curators; nothing here should be duplicated as a literal elsewhere.
 */
export const pipeline = {
  /** Sent with every feed request so operators can identify the crawler. */
  userAgent: 'ava-agent/0.1 (+https://github.com/) personal news curator',

  /** Per-feed HTTP timeout. Feeds are fetched in parallel, so this bounds a run. */
  feedTimeoutMs: 20_000,

  /**
   * Excerpt length handed to the ranker. arXiv abstracts run long and the
   * ranker sees hundreds of items per run — this is the main cost lever.
   */
  excerptMaxChars: 400,

  /**
   * Article body stored per item and handed to the summarizer. Only the few
   * items that survive ranking are ever summarized, so this buys quality
   * cheaply — but it is capped because some feeds inline an entire newsletter.
   */
  articleMaxChars: 8_000,

  /**
   * Per-article HTTP timeout for the fetch fallback, used only when a feed
   * ships no body. Tighter than the feed timeout: a slow article should not
   * hold up a digest that is otherwise ready to send.
   */
  articleTimeoutMs: 10_000,

  /** Ceiling on items scored in one ranking pass, so a burst can't blow up a run. */
  maxItemsPerRankingRun: 250,

  /**
   * Items older than this are dropped at ingest. Many feeds (Figma, OpenAI)
   * serve their entire history — hundreds of entries — so without this the
   * first run pays to rank years-old news.
   */
  maxItemAgeDays: 7,

  /**
   * Jaccard similarity over normalized title tokens above which two headlines
   * are treated as the same story. Raise it if unrelated items get merged.
   */
  clusterSimilarityThreshold: 0.55,

  /** Recent 👍/👎 injected into the ranker to shape the interest profile. */
  feedbackWindow: 40,

  /** Telegram hard-caps messages at 4096 characters. */
  telegramMaxMessageChars: 3900,

  /** Local-time hours (AVA_TIMEZONE) at which each category's digest fires. */
  digestHours: [8, 13, 19],
} as const
