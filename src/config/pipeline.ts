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

  /**
   * bm25 column weights for article search, in the column order `items_fts`
   * declares: title, excerpt, body. Unweighted, bm25 treats a term buried in an
   * 8k-character body as worth the same as one in the headline, which sorts the
   * obvious answer below three passing mentions.
   */
  searchColumnWeights: { title: 10, excerpt: 5, content: 1 },

  /** Telegram hard-caps messages at 4096 characters. */
  telegramMaxMessageChars: 3900,

  /**
   * How much of a replied-to message is quoted back to Ava as context. A digest
   * runs to about a thousand characters, so this fits one whole — but a reply to
   * a long message shouldn't push the reader's actual question out of the model's
   * attention, which is what quoting all 4096 would do.
   */
  quotedMessageMaxChars: 1_200,

  /**
   * Links from a quoted message looked up against `items`, in the order they
   * appear. A digest carries exactly one — the article's — and Ava's own replies
   * carry a handful; this only bounds the pathological case, since each lookup
   * is a primary-key read.
   */
  quotedLinkLookups: 5,

  /**
   * How long a stored item survives before the prune job deletes it, measured
   * from `discoveredAt`.
   *
   * **This must stay comfortably above `maxItemAgeDays`.** Deleting a row frees
   * its id, and the id *is* the global dedupe ([invariant 5](../../AGENTS.md#invariants)) —
   * so an item that is still being served by its feed would be re-ingested and
   * re-delivered as if it were new. The ingest window is what prevents that: at
   * 30 days against a 7-day window there is a 4× margin, and every one of the
   * 288 items measured on 2026-07-28 carried a publication date, so every one of
   * them is subject to that window.
   */
  retentionDays: 30,

  /**
   * Rows deleted per statement by the prune job. Each delete fires the
   * `items_fts` delete trigger, so this bounds how long one write lock is held
   * rather than how much work is done — the job loops until nothing is left.
   */
  pruneBatchSize: 500,

  /** Local-time hours (AVA_TIMEZONE) at which each category's digest fires. */
  digestHours: [8, 13, 19],

  /**
   * Local-time hour at which retention runs. Deliberately between the 19:00 and
   * 08:00 digests: pruning holds a write lock the ingest step would contend for.
   */
  pruneHour: 4,
} as const
