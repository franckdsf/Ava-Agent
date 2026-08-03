/**
 * The reader's CV, fetched from their own portfolio at run time.
 *
 * Joob's equivalent of a beat's rubric, and deliberately *not* stored here or in
 * the database ([ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)).
 * It is fetched fresh at the start of every run, cached nowhere, and distilled
 * into nothing:
 *
 * - **No stored copy.** A stale CV costs nothing — the next run is two days away
 *   — and a failed fetch costs nothing either, because unscored postings stay
 *   pending and the next run picks them all up, exactly as `listUnranked`
 *   already behaves for articles. A cache would be a second source of truth for
 *   a document the reader edits somewhere else.
 * - **No distilled profile.** It enters the scoring prompt **once for the whole
 *   batch**, every two days, so compressing it buys nothing. The deterministic
 *   filters read `job_searches` rows, not the CV.
 *
 * The guards below exist because a wrong endpoint never errors — the same
 * failure class as a wrong feed URL. A deployment-protection wall answers 200
 * with an HTML login page; a bad token answers 401; an empty deploy answers 200
 * with nothing. All three would be fed to the scoring model as if they were a
 * CV, and the symptom would be a fortnight of baffling matches rather than an
 * error.
 */

export const portfolio = {
  /**
   * How long to wait for the endpoint.
   *
   * Without a timeout a hung request stalls the workflow step indefinitely —
   * there is no ambient deadline on `fetch`. Generous, because this happens once
   * per run and a cold serverless start is a real thing.
   */
  timeoutMs: 15_000,

  /**
   * Content types that may be a CV.
   *
   * Checked rather than sniffed because the endpoint declares one honestly:
   * `text/markdown; charset=utf-8` on success, `text/plain` on its 401. Anything
   * else is a wall, a redirect page, or a misconfiguration.
   */
  acceptedContentTypes: ['text/markdown', 'text/plain'] as const,

  /**
   * Below this, whatever came back is not a CV.
   *
   * The failure this catches is a deploy that ships an empty `portfolio.md`,
   * which returns a perfectly valid 200 and would otherwise score every posting
   * against nothing. 200 characters is far under any real CV and far over any
   * plausible error string.
   */
  minChars: 200,

  /**
   * Above this, the CV is truncated rather than refused.
   *
   * Refusing would mean no jobs at all from a document that is merely long,
   * which is the worse failure — so this degrades instead, and the result
   * carries a `truncated` flag so the run can say so.
   *
   * **Set to 80k on the reasoning that it was "comfortably more than any CV",
   * and the first real one measured 80,562** — it was silently losing its tail
   * on the very first fetch. This is now roughly 50% headroom over a known real
   * document rather than a guess. The reader's CV is the one input here that
   * grows on its own, so re-check `pnpm portfolio:check` for a `TRUNCATED`
   * notice rather than assuming this number is still generous.
   *
   * It cannot be raised without limit: the CV enters the scoring prompt whole,
   * once per run, alongside every candidate posting. At 120k characters it is
   * about 30k tokens before a single job is added.
   */
  maxChars: 120_000,
} as const
