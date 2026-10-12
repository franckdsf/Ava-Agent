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
   * Longest source label taken from a feed's own `<title>`.
   *
   * A feed title is not always a name. PlanetF1's is 200 characters of marketing
   * copy — *"PlanetF1 - news articles, features, everything - we're only giving
   * away a teaser, we want to promote everything we've got…"* — and that string
   * is the attribution printed under every article the feed ever delivers.
   * Past this, the hostname is used instead, which is always a name.
   */
  sourceMaxChars: 40,

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

  /**
   * How many times a structured model call is attempted before giving up.
   *
   * Mastra's own `maxRetries` retries a failed *request*; this retries a
   * malformed *answer*, and both failures measured here are per-call rather than
   * permanent. The jobs pipeline hit a truncated JSON body; the ranker hit an
   * answer wrapped under the wrong key — `{"scores":[…]}` for a schema that asks
   * for `rankings`, from `deepseek-v4-flash` on 2026-08-07. OpenRouter routes to
   * whichever provider is cheapest, and not all of them enforce a JSON schema,
   * so the envelope is named in the prompt as well and this catches the rest.
   *
   * Two, matching `jobPipeline.modelAttempts`: a ranking call reads a whole
   * beat's batch, so a third attempt costs more than the run is worth waiting
   * for. Failing leaves the batch unranked for the next run rather than scoring
   * it at zero.
   */
  modelAttempts: 2,

  /** Ceiling on items scored in one ranking pass, so a burst can't blow up a run. */
  maxItemsPerRankingRun: 250,

  /**
   * What a beat scores against when it has expressed no opinion of its own.
   *
   * `beats.digest_threshold` and `beats.max_items_per_digest` are nullable, and
   * null reads as these numbers rather than being copied into the row at
   * creation. That is deliberate: tuning here retunes every beat that never
   * overrode it, which is what you want when a reader-created beat has no
   * business having a hand-picked threshold.
   */
  defaultDigestThreshold: 62,

  /**
   * **8, raised from 6 on 2026-08-06, as insurance against downtime rather than
   * to send more.**
   *
   * The cap only binds when a beat has more articles over its threshold than
   * slots, which at a healthy cadence it does not: measured demand is ~6.4
   * articles a day clearing 62 against 16 slots a day at two fires. It binds
   * hard when the machine has been *off* — the real gap between digest runs
   * measured 27.8h median (67.2h at worst), and six items to cover twenty-eight
   * hours of news is a backlog that never drains. Eighteen articles were sitting
   * over the bar when this was measured.
   *
   * Raising it costs nothing on a quiet day: nothing below the threshold is ever
   * sent to fill a slot.
   */
  defaultMaxItemsPerDigest: 8,

  /**
   * How many beats curate at once inside one run.
   *
   * Each one is a ranker call over its own batch plus a handful of writer calls,
   * so this is a concurrency limit on the model provider more than on this
   * process. Kept low: the beats share a database connection, and a burst of
   * parallel ranking runs would contend on the same write lock the ingest step
   * just finished with.
   */
  beatConcurrency: 2,

  /**
   * Items older than this are dropped at ingest. Many feeds (Figma, OpenAI)
   * serve their entire history — hundreds of entries — so without this the
   * first run pays to rank years-old news.
   */
  maxItemAgeDays: 7,

  /**
   * Newest items one feed may contribute in one run, applied **after** the age
   * window.
   *
   * The age window was the only bound until 2026-08-06, and it is the wrong tool
   * for a feed that is genuinely prolific rather than merely historical. Figma's
   * 437 entries and OpenAI's 1051 are *old*, so the window handles them. arXiv
   * `cs.AI` publishes **258–693 papers a day, every one of them hours old** —
   * measured, 693 on 2026-08-04 — so every single one passes the window and the
   * ranker is paid to read all of them. That was 88% of intake and ~92% of
   * ranking input tokens, for a 2% hit rate.
   *
   * Scoping the feed URL is the better fix where a feed supports it — arXiv's
   * API takes `max_results` — but that is one vendor's query parameter and
   * nothing else honours it. This is the bound that works on any feed from any
   * domain, which is why both exist.
   *
   * **Dropping here is permanent, and that is the cost.** `saveFeedState`
   * records the etag on the same fetch, so the next request answers 304 and the
   * items that did not make the cut are never offered again. The cap is
   * therefore set well above any honest publisher's daily output: it is a
   * circuit breaker for a firehose, not a per-run reading quota.
   */
  maxItemsPerFeedRun: 200,

  /**
   * Jaccard similarity over normalized title tokens above which two headlines
   * are treated as the same story. Raise it if unrelated items get merged.
   */
  clusterSimilarityThreshold: 0.55,

  /** Recent 👍/👎 injected into the ranker to shape the interest profile. */
  feedbackWindow: 40,

  /**
   * bm25 column weights for article search, in the column order `articles_fts`
   * declares: title, excerpt, body. Unweighted, bm25 treats a term buried in an
   * 8k-character body as worth the same as one in the headline, which sorts the
   * obvious answer below three passing mentions.
   */
  searchColumnWeights: { title: 10, excerpt: 5, content: 1 },

  /** Telegram hard-caps messages at 4096 characters. */
  telegramMaxMessageChars: 3900,

  /**
   * How much of a replied-to message is quoted back to Newy as context. A digest
   * runs to about a thousand characters, so this fits one whole — but a reply to
   * a long message shouldn't push the reader's actual question out of the model's
   * attention, which is what quoting all 4096 would do.
   */
  quotedMessageMaxChars: 1_200,

  /**
   * Links from a quoted message looked up against `items`, in the order they
   * appear. A digest carries exactly one — the article's — and Newy's own replies
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
   * `articles_fts` delete trigger, so this bounds how long one write lock is held
   * rather than how much work is done — the job loops until nothing is left.
   */
  pruneBatchSize: 500,

  /**
   * Local-time hours (AGENT_TIMEZONE) at which each category's digest fires.
   *
   * **Two a day, not three** — 10:00 and 20:00, set 2026-08-06 at the reader's
   * request. Nothing is lost by dropping a fire: `defaultMaxItemsPerDigest`
   * gives 12 slots a day here, and the measured demand is ~6.4 articles a day
   * clearing `defaultDigestThreshold` on the busiest beat. The slots were slack
   * at three fires and are still slack at two.
   *
   * Read dynamically by the schedule, by `/start` and by `/beat`, so this array
   * is the only place the cadence lives. `NEWS` in `src/mastra/pipelines.ts`
   * derives its gate from it, and `definePipeline` refuses to load a
   * `catchup.newsStaleAfterDays` at or under the ceiling it implies;
   * `pnpm catchup:check` shows the live verdict.
   */
  digestHours: [10, 20],

  /**
   * Local-time hour at which retention runs. Deliberately between the last and
   * first digests: pruning holds a write lock the ingest step would contend for.
   */
  pruneHour: 4,
} as const

/**
 * The tightest gap between two consecutive digest fires, in hours, wrap-around
 * included.
 *
 * `[10, 20]` is 10 hours, not the 12 that "twice a day" suggests — the fires are
 * unevenly spaced and the *smallest* gap is the only one that matters to
 * anything guarding against a second run.
 */
export function minDigestGapHours(hours: readonly number[] = pipeline.digestHours): number {
  const sorted = [...hours].sort((a, b) => a - b)
  if (sorted.length < 2) return 24
  const gaps = sorted.map((hour, index) =>
    index === 0 ? sorted[0]! + 24 - sorted[sorted.length - 1]! : hour - sorted[index - 1]!,
  )
  return Math.min(...gaps)
}

/** The limits on the beat commands, and on the scout that names a beat. */
export const beatCommands = {
  /**
   * How far back `/beats` and `/beat` count when reporting what a beat has done.
   *
   * A week, so the answer covers a normal reading rhythm and a quiet weekend
   * doesn't read as a broken beat.
   */
  statsDays: 7,

  /** Feeds listed inline by `/beat` before it stops and says how many are left. */
  maxFeedsShown: 20,

  /**
   * A slug, as the reader may type it. Same shape the seeds use — lowercase,
   * hyphenated — checked here so a typo is answered rather than looked up.
   */
  slugPattern: /^[a-z0-9][a-z0-9-]{0,47}$/,

  /**
   * Longest subject `/follow` accepts.
   *
   * Generous enough for a sentence in any language, short enough that a pasted
   * article does not become a search query. The namer is cheap, but the *scout*
   * searches the open web, and a 2000-character "subject" produces eight sites
   * about nothing in particular.
   */
  subjectMaxChars: 200,
} as const
