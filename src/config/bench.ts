/**
 * `pnpm bench` — the numbers that decide how a model comparison is run.
 *
 * Nothing here is read by the bot. It lives in `src/config/` rather than beside
 * the script because every other tunable does, and because a reader deciding
 * whether to trust a bench table should find "how many runs" where they would
 * look for any other number.
 */
export const bench = {
  /**
   * The model that ranks the field. It never generates, so it is never in the
   * running — and it should not share a vendor with the incumbent of the task it
   * judges where that can be helped, or "sounds like me" becomes a criterion.
   * Run at `high` effort: it is read once, and it is the one call whose own
   * quality is not what is being measured.
   */
  judge: 'openrouter/google/gemini-3.8-flash',

  /**
   * Generations per entrant per fixture. Three is the fewest that tells "good on
   * average" apart from "good once": a model excellent in one run and broken in
   * two looks like a coin flip at two runs and like what it is at three.
   */
  runs: 3,

  /** Fixtures per task when `--fixtures` is not given. Two inputs, so one odd batch cannot crown a model. */
  fixtures: 2,

  /**
   * Generations in flight at once, across every entrant.
   *
   * Eight, as `check-models.ts` ran: OpenRouter answers a burst with 429s, and
   * a rate-limited call fails exactly like a bad model does — the table would
   * blame the model for the account. Raise it only after a run at this number
   * came back with no failures.
   */
  concurrency: 8,

  /**
   * How long one generation — retries included — may take before it is scored
   * as a failure. Ten minutes, because a high-effort entrant on a slow endpoint
   * legitimately takes minutes, and without a cap one model that never answers
   * holds the pool, the judge and the transcript hostage.
   */
  timeoutMs: 600_000,

  /**
   * The judge's own budget, never below an entrant's: it reads every answer from
   * every run in one prompt, and it is the last call of a run whose generations
   * are already paid for — losing it to a timeout loses the table.
   */
  judgeTimeoutMs: 600_000,

  /**
   * Articles per ranker fixture. Production sends up to `maxItemsPerRankingRun`
   * (250); forty keeps a judge prompt that shows every entrant's every run to
   * every article readable, and is still enough for scores to spread.
   */
  rankerBatch: 40,

  /**
   * Postings per job-scorer fixture. Production sends up to
   * `maxJobsPerScoringRun` (90) behind a ~20k-token CV; thirty keeps the judge's
   * prompt — CV, postings and every entrant's every verdict — inside what a
   * judge reads carefully, and is still three bands of ten.
   */
  jobBatch: 30,
} as const
