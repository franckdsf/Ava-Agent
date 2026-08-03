/**
 * The job pipeline's knobs. No magic numbers in the logic.
 *
 * Two of these may not be tuned independently, and one pair is load-bearing in a
 * way that is easy to undo by accident — read
 * [ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)
 * before moving any of the three window values.
 */

export const jobPipeline = {
  /**
   * How old a posting may be and still be ingested.
   *
   * Wide, because listings stay open — hiring takes weeks, and a three-week-old
   * posting is still worth applying to. This is the number that most obviously
   * differs from the news pipeline's 7-day window, where three weeks old means
   * dead.
   *
   * **Must stay well below `retentionDays`.** Deleting a row frees its id, and
   * the id is the dedupe, so a pruned posting a board still serves would be
   * re-ingested with a null `deliveredAt` and re-sent. The ingest window
   * refusing it on age is the first guard; `job_deliveries` is the second and
   * the one that actually holds.
   */
  ingestWindowDays: 30,

  /**
   * How long a posting is kept.
   *
   * Double the ingest window, so the trap above cannot fire on any source that
   * ships a date. Shortlisted and applied postings outlive this through the
   * denormalized copy on their delivery row.
   */
  retentionDays: 60,

  /**
   * How long after delivering a posting the same identity is suppressed.
   *
   * **Must exceed `retentionDays`**, or the pruning hole reopens: a posting
   * pruned at 60 days and re-crawled the next day would otherwise clear a
   * shorter guard and be sent twice.
   *
   * The cost is that a role genuinely re-advertised inside 75 days is not shown
   * again — which is the right behaviour anyway. A repost two months on is one
   * the reader already saw and passed over; the repost worth surfacing is the
   * long-gap one, and it clears this comfortably.
   */
  redeliveryGuardDays: 75,

  /**
   * Postings handed to the scorer in one run.
   *
   * A 30-day window means the *first* run pulls a month of every source at once,
   * and several boards serve their whole history. Without this the first run
   * scores several hundred postings in one call. Mirrors
   * `pipeline.maxItemsPerRankingRun`, and exists for the same reason it does.
   */
  maxJobsPerScoringRun: 60,

  /** Postings delivered in one run, per search, so a busy cycle can't wall the tab. */
  maxJobsPerDelivery: 8,

  /**
   * Minimum fit for a posting to be delivered, when a search doesn't override it.
   *
   * Null on `job_searches.fitThreshold` means this, so retuning here moves every
   * search that never set its own — which is the point of the null rather than a
   * copied number.
   */
  defaultFitThreshold: 70,

  /**
   * Hours that must pass before a run does anything.
   *
   * The schedule fires **daily** and this gate is what makes it every two days.
   * A day-of-month step of two — the obvious cron for this — is *not* "every two
   * days": it fires on the 1st, 3rd … 31st and then the 1st again, so seven
   * month boundaries a year produce two consecutive runs. (The literal cannot be
   * written in a block comment here; its star-slash closes the comment.) A
   * stored `lastRunAt` also survives the thing that already bit this repo once:
   * a missed schedule firing on boot, with two runs then in flight at once.
   *
   * 44 rather than 48 so a run that starts a few minutes late doesn't push the
   * next one a whole day.
   */
  intervalHours: 44,

  /** Hour the daily schedule fires, in `AGENT_TIMEZONE`. */
  runHour: 8,

  /**
   * Longest description stored per posting.
   *
   * Job adverts run to thousands of words of benefits boilerplate. The scorer
   * sees a truncated version anyway (see below), and the writer reads this one.
   */
  maxDescriptionChars: 12_000,

  /**
   * Description characters shown to the *batch scorer*, per posting.
   *
   * Far smaller than the stored version, because the scoring prompt carries the
   * CV once plus every candidate posting — at 60 postings, a full advert each
   * would be the whole prompt. The first part of an advert carries the role;
   * the tail carries the equal-opportunity statement.
   */
  scorerDescriptionChars: 1_200,

  /**
   * How many times a structured model call is attempted before giving up.
   *
   * Mastra's own `maxRetries` retries a failed *request*; this retries a
   * malformed *answer*, which is a different failure and the one measured here —
   * a truncated JSON body that fails schema validation. Truncation is
   * stochastic, so asking the same question again usually works.
   *
   * Two, not more: the scorer's call is the run's whole model spend and takes
   * minutes, so a third attempt costs far more than the batch is worth waiting
   * for. The run degrades rather than retrying forever.
   */
  modelAttempts: 2,

  /** Concurrency over sources at ingest. Politeness, not throughput. */
  sourceConcurrency: 4,

  /** How long to wait on one source before giving up on it for this run. */
  sourceTimeoutMs: 20_000,

  /**
   * Browser User-Agent for job boards.
   *
   * Same finding as the news pipeline's homepage fetch: several boards answer
   * 403 to an honest bot UA. Job boards are more hostile about this than RSS
   * publishers, not less.
   */
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/126.0.0.0 Safari/537.36',
} as const
