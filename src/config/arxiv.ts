/**
 * arXiv is a firehose, and a beat only ever wants a slice of it.
 *
 * `rss.arxiv.org/rss/cs.AI` serves **every** paper announced in that category —
 * measured 258–693 a day, all of them hours old, so `pipeline.maxItemAgeDays`
 * lets every one through. On the reader's `computer-science` beat that was 951
 * of 1,084 articles in a week (88% of intake, ~92% of ranking input tokens) for
 * **32 papers that cleared the beat's threshold** — a 2% hit rate.
 *
 * The category is not the problem: cs.AI is genuinely the right category for
 * that beat. The problem is that a category is not a subject. arXiv's API takes
 * a search query, so the subject the beat already declares — its subtopics — can
 * be pushed into the feed URL, and the firehose narrows itself before a single
 * token is spent.
 *
 * This is applied **when a feed is added**, not at fetch time, so what is stored
 * in `beat_feeds` is exactly what will be fetched. A URL that means something
 * different from what the reader typed would be a bad surprise, so `/addfeed`
 * says what it did.
 */
export const arxiv = {
  /** Where a scoped feed is fetched from. The `rss.` host serves listings only. */
  apiBase: 'http://export.arxiv.org/api/query',

  /**
   * Entries a scoped feed returns per fetch.
   *
   * Sorted newest-first, so this is "the most recent N matching papers" rather
   * than a sample. Sixty is comfortably more than a narrow query produces in a
   * day and comfortably under `pipeline.maxItemsPerFeedRun`, so neither bound
   * has to do anything in the normal case.
   */
  maxResults: 60,

  /**
   * Subtopics that are too generic to narrow anything.
   *
   * A beat may legitimately carry a label like `frameworks` or `tools`, which as
   * an abstract search matches most of computer science and would scope nothing
   * while looking like it had. Dropped from the query rather than dropped from
   * the beat — they remain perfectly good *ranking* labels, which is what they
   * were written for.
   */
  uselessTerms: new Set([
    'frameworks', 'framework', 'tools', 'tooling', 'libraries', 'library',
    'platform', 'platforms', 'research', 'papers', 'news', 'updates', 'general',
    'other', 'misc', 'software', 'engineering', 'development', 'computing',
    // The vocabulary of academic writing itself. Measured against the reader's
    // `ai-model-releases` beat, whose labels are `benchmarks` and `capabilities`
    // — perfectly good ranking labels, and as an abstract search they match a
    // large fraction of every AI category on arXiv.
    'benchmarks', 'benchmark', 'capabilities', 'evaluation', 'evaluations',
    'methods', 'approaches', 'techniques', 'applications', 'systems', 'models',
  ]),

  /**
   * Terms needed before a feed is scoped at all.
   *
   * Below this the query would be so narrow or so generic that it is not worth
   * the risk of silently changing what a beat reads. One term is also the case
   * where a typo produces an empty feed with no second term to save it.
   */
  minTerms: 2,

  /** Terms carried into the query. Past this the URL is long and the gain is nil. */
  maxTerms: 6,
} as const
