/**
 * Finding sources that **break** a story rather than repeat it.
 *
 * The problem this exists for is not that the pipeline delivers old articles —
 * it is that a source can be perfectly punctual about its own publishing and
 * still be four days behind the news. A blog that writes about a model release
 * the following week carries a fresh `publishedAt` and stale information, and
 * nothing in `checkFeed()` can tell the difference: the feed parses, it has
 * entries, its newest one is hours old. It is a healthy feed and a late one.
 *
 * So candidate discovery here has three stages, and only the last is new:
 *
 * 1. **Search** — `finder.wprssaggregator.com/api/topic-search`, a Brave-backed
 *    lookup that answers with feed URLs plus `velocity` and `lastUpdated`.
 *    rssfinder.app (see [`rss-finder.ts`](rss-finder.ts)) is the fallback for a
 *    *domain*, which is the axis it is good at.
 * 2. **Verify** — `checkFeed()`, unchanged and still the only authority on
 *    whether a URL is a feed at all.
 * 3. **Race** — fetch every surviving candidate and measure how far behind the
 *    first publisher each one was, story by story. That is `feed-timeliness.ts`,
 *    and it is the stage that answers the question actually being asked.
 *
 * Both endpoints are undocumented and belong to somebody else. Read the note on
 * `rssFinder.endpoint`; it applies here word for word.
 */
export const feedFinder = {
  /**
   * Topic search. **POST only** — a GET answers `405`, and an empty `q` answers
   * `400` with `{"error": …}` rather than an empty result set.
   */
  endpoint: 'https://finder.wprssaggregator.com/api/topic-search',

  /** One search against a stranger's server, same reasoning as `rssFinder.timeoutMs`. */
  timeoutMs: 20_000,

  /**
   * Queries are run as written and their results merged.
   *
   * This endpoint answers with **few but precise** results — measured
   * 2026-08-06, between 1 and 5 feeds per query, where rssfinder returns a flat
   * 7 of mixed quality. `limit` is accepted and ignored. So breadth comes from
   * asking several ways rather than from asking for more, and the caller is
   * expected to hand over a small set of phrasings.
   */
  maxQueries: 6,

  /**
   * Candidates carried into the race, after verification and the gates below.
   *
   * The race fetches every one of them, so this is the real cost bound of a
   * finder run — and it is the [invariant 2](../../AGENTS.md#invariants) bound
   * for the search shape, not a tuning knob.
   */
  maxCandidates: 24,

  /**
   * Gates applied to what the search returns, before anything is fetched.
   *
   * Deliberately weak. They exist to drop the obviously dead — a blog last
   * touched in December, a feed that posts twice a year — and not to judge,
   * because the race is a far better judge than either number. A feed with a
   * low velocity that consistently breaks stories is exactly what this is
   * hunting for, and a `velocity` gate set high would discard it.
   */
  gates: {
    /**
     * Posts per day, as the endpoint reports it. Verified against
     * `openrouter.ai/blog` on 2026-08-06: the API said `3.24` and the feed
     * carries roughly three posts a week, so **the unit is per week, not per
     * day** — do not raise this thinking it means daily.
     */
    minVelocity: 0.5,
    /** Days since the newest entry, past which a source is treated as dormant. */
    maxStaleDays: 45,
  },

  /**
   * How the race is run. Every one of these bounds a heuristic that has no
   * obviously correct value, so they are here rather than inline.
   */
  race: {
    /** Entries read per candidate. Enough to cover several stories, few enough to stay cheap. */
    entriesPerFeed: 60,

    /** Feeds fetched at once. Matches `discovery.siteConcurrency` — same politeness argument. */
    concurrency: 4,

    /** Only entries this recent take part. Older ones describe a different news cycle. */
    windowDays: 45,

    /**
     * A gap this long inside one token's mentions starts a new story.
     *
     * Without it, "gemini" in June and "gemini" in August measure as one event
     * with a t0 six weeks before half the mentions, and every source that
     * covered only the later release looks catastrophically late.
     */
    storyGapDays: 5,

    /**
     * A token appearing in more than this share of all titles is vocabulary, not
     * news. `model`, `ai` and `release` are in nearly every title in this domain
     * and would otherwise generate meaningless races with an arbitrary t0.
     *
     * Started at 0.12 and that was too loose: the first live run raced on
     * `july`, `real`, `prompt` and `without`, which are words several blogs
     * happened to share rather than stories any of them broke. The ranking it
     * produced was plausible, which is exactly what makes a loose filter
     * dangerous — it does not look wrong.
     */
    maxDocFrequency: 0.06,

    /**
     * Longest a story may run, first mention to last.
     *
     * The episode split only guarantees no *single* gap exceeds `storyGapDays`,
     * so a word mentioned every few days chains into one 45-day "story" whose t0
     * is meaningless. Real news propagates in days: past this, the token is part
     * of the vocabulary of the subject rather than an event inside it.
     */
    maxStorySpanDays: 7,

    /** A story needs this many distinct feeds, or there is no race to be behind in. */
    minFeedsPerStory: 2,

    /**
     * Stories a feed must appear in before its lag is reported as a number.
     *
     * Below this it is shown but not ranked. One lucky scoop is not evidence,
     * and the failure mode of pretending otherwise is adopting a dead blog that
     * happened to be first about one thing.
     */
    minStoriesToRank: 3,

    /** Shortest token treated as a name. Kills `a`, `is`, `to` before the stopword list does. */
    minTokenLength: 3,

    /**
     * When to stop believing capitalisation.
     *
     * A Title-Cased headline capitalises everything, so `Three Domains: Portal
     * Sprawl` would contribute four "names". Past this share of capitalised
     * words the signal is discarded for that headline and only digit-bearing
     * tokens survive.
     *
     * **0.85, not 0.6.** At 0.6 the check fired on the headlines worth reading —
     * `Introducing Gemini Robotics ER 2` and `One-shotting a Raccoon Heist game
     * using Claude Fable 5` are 100% and 71% capitalised because they are *full
     * of proper nouns*, which is the opposite of the pattern being excluded. The
     * word count matters for the same reason: a three-word headline of names
     * looks identical to Title Case and cannot be told apart, so it is left
     * alone.
     */
    titleCaseRatio: 0.85,
    titleCaseMinWords: 4,
  },
} as const

/**
 * Words that carry no news. Not a general stopword list — a list of the words
 * this *domain* says constantly, which is why it is short and specific.
 *
 * The document-frequency filter catches most of them on a large enough pool;
 * this covers the case where the pool is small and a common word therefore looks
 * rare. Both are needed.
 */
export const RACE_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'your', 'are',
  'was', 'were', 'has', 'have', 'had', 'not', 'but', 'all', 'can', 'how', 'why',
  'what', 'when', 'who', 'its', 'our', 'their', 'his', 'her', 'they', 'them',
  'new', 'now', 'get', 'got', 'out', 'via', 'over', 'into', 'more', 'most',
  'best', 'top', 'first', 'next', 'last', 'about', 'after', 'before',
  'without', 'within', 'through', 'across', 'between', 'under', 'than', 'them',
  'ai', 'llm', 'llms', 'model', 'models', 'release', 'releases', 'released',
  'launch', 'launches', 'launched', 'update', 'updates', 'updated', 'version',
  'news', 'blog', 'post', 'article', 'week', 'weekly', 'day', 'daily',
  'open', 'source', 'data', 'using', 'use', 'guide', 'introducing', 'announcing',
  // Generic subject vocabulary. Every one of these produced a bogus "story" on
  // a real run: they are what this field is *about*, so of course several blogs
  // say them in the same fortnight.
  'agent', 'agents', 'agentic', 'prompt', 'prompts', 'voice', 'image', 'images',
  'video', 'chat', 'code', 'coding', 'tool', 'tools', 'api', 'app', 'apps',
  'real', 'frontier', 'research', 'training', 'inference', 'benchmark',
  'generation', 'generative', 'reasoning', 'context', 'token', 'tokens',
  // Months and weekdays — `july` raced four sources on the first run.
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
])
