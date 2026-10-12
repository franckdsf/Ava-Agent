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
   * Eight, as the old `models:check` script ran: OpenRouter answers a burst with 429s, and
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

  /**
   * Articles per article-writer fixture. The writer is called once per article,
   * so one article per fixture would give the judge two summaries to compare per
   * run; four, from different beats where possible, show whether a model is
   * good or got lucky on one easy story.
   */
  writerBatch: 4,

  /**
   * The shortest stored body an article-writer fixture accepts. Below this a
   * feed carried a teaser, not the article, and the writer is summarizing an
   * excerpt — a different task from the one production mostly does.
   */
  writerMinBodyChars: 1_500,

  /**
   * A title shorter than this is not flagged when a summary repeats it: "Rust
   * 2.0" inside a lede is naming the subject, a whole headline is echoing it.
   */
  titleEchoMinChars: 20,

  /**
   * How many "fits" a job brief may carry. Mirrors "two to four" in the job
   * writer's instructions (`src/mastra/agents/job-scorer.ts`) — change both.
   */
  jobBriefFits: { min: 2, max: 4 },

  /**
   * Stored body lengths the translator and summarizer fixtures draw from — the
   * range the old `models:check` used before the bench. Long enough that a summary
   * has something to choose from, short enough to be a whole stored article
   * rather than one cut at `articleMaxChars`.
   */
  readerBodyChars: { min: 3_000, max: 8_000 },

  /**
   * A gloss longer than this many words is counted as `long gloss` — a note to
   * the reader rather than a term, the failure the translator's prompt argues
   * against. Four, as the old `models:check` counted it.
   */
  longGlossWords: 4,
} as const
