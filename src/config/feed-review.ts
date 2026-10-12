/**
 * The weekly feed review: drop the sources that earn nothing, re-test them a
 * month later, and top the beat back up.
 *
 * A beat accumulates feeds — `/follow` attaches up to eight, `/addfeed` adds
 * more, and nothing ever took one away. Every one of them is fetched on **every**
 * digest and every article it brings is **ranked**, which is the main cost lever
 * in this pipeline. So a feed that has never once produced something worth
 * sending is not neutral; it is paid for at every digest hour, forever, and it
 * dilutes every ranking batch it appears in.
 *
 * **Every threshold here exists to stop this job doing harm**, because the
 * failure it can cause is silent and expensive: archiving a feed that was fine.
 * The guards are deliberately conservative and the reasoning for each is on the
 * field. The default posture is *do nothing* — a review with insufficient
 * evidence must leave the beat exactly as it found it.
 */
export const feedReview = {
  /**
   * Monday 06:00. After the memory review at 05:00 and before the first digest,
   * so a beat that loses a feed has its next digest already reflecting it, and
   * two model-calling jobs never overlap.
   */
  reviewWeekday: 1,
  reviewHour: 6,

  /**
   * How far back performance is measured.
   *
   * Thirty days, which is `pipeline.retentionDays` — measuring over a window
   * longer than articles are kept would count a feed's oldest contributions
   * against rows that no longer exist and make every feed look worse the further
   * back you look.
   */
  windowDays: 30,

  /**
   * Articles a feed must have contributed before it can be judged at all.
   *
   * A feed that published four things this month has told us nothing about its
   * quality, and a quiet specialist source is often the most valuable one on a
   * beat. Below this the feed is skipped, not archived.
   */
  minCollected: 20,

  /**
   * Of those, how many the ranker must actually have scored.
   *
   * Separate from `minCollected` because they come apart exactly when it
   * matters: articles ingested in the last hours are unranked, and a beat
   * created days ago can have hundreds collected and none scored. Judging on
   * `collected` alone would archive every feed on a young beat.
   */
  minRanked: 15,

  /**
   * Articles the **beat** must have delivered in the window before any of its
   * feeds may be archived.
   *
   * The single most important guard here. If a beat has sent nothing at all, the
   * fault is the beat — a threshold set too high, a rubric that matches nothing,
   * a ranker having a bad week — and *every* feed will look worthless. Without
   * this, one misconfigured beat silently loses all of its sources in one run,
   * and the reader's only clue is that the digests stopped.
   */
  minBeatDelivered: 3,

  /**
   * Never prune a beat below this many live feeds.
   *
   * A beat with one feed is a beat that goes quiet the day that feed does.
   * Pruning stops here even when the evidence against the remaining feeds is
   * good; the reader is told, and `/removefeed` is still theirs.
   */
  minFeedsPerBeat: 3,

  /** Most feeds one run may archive per beat, so a bad measurement can't empty it. */
  maxArchivedPerRun: 2,

  /**
   * How long an archived feed rests before it is given another month to prove
   * itself.
   *
   * A feed can be bad for reasons that pass: a site between editors, a section
   * that was dormant, a beat whose rubric has since been rewritten. Thirty days
   * is long enough that the second trial is a genuinely new sample.
   */
  retryAfterDays: 30,

  /**
   * How many times a feed may be auto-archived before it stays archived.
   *
   * The backoff. Without it a feed that is simply a poor fit cycles forever —
   * archived, restored a month later, fetched on every digest for a week,
   * archived again. Past this the reader can still re-add it with `/addfeed`,
   * which is the deliberate act this is meant to require.
   */
  maxTrials: 2,

  /**
   * Whether the review tops beats back up with new feeds after pruning.
   *
   * This is what makes the job a net improvement rather than a slow drain: a
   * beat that loses two dead sources should gain candidates, not shrink. Runs
   * only for beats under `discovery.maxFeedsPerBeat`, and goes through the same
   * discovery path `/follow` uses, so nothing unverified is ever attached.
   */
  topUp: true,
} as const
