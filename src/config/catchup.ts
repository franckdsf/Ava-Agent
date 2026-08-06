/**
 * The boot catch-up's numbers.
 *
 * A container that was off for a fortnight comes back with its schedules intact
 * and nothing to show for the gap: the next digest is at 08:00 whatever happened
 * before, so the reader's first evidence the machine is alive again arrives
 * hours later, and the jobs run waits for its own daily fire on top of that.
 * These decide when a boot runs a pipeline itself instead of waiting
 * ([ADR-0025](../../docs/decisions/0025-a-boot-catch-up-for-a-stale-pipeline.md)).
 */
export const catchup = {
  /**
   * How long the news pipeline may go without an ingest before a boot fires it.
   *
   * Against `pipeline.digestHours` this is fourteen missed fires — far enough
   * out that no reading of "the schedule has not been running" disagrees, and
   * not reachable by a slow run or a quiet week of feeds.
   *
   * **It said twenty when the cadence was three a day**, and the cadence dropped
   * to two on 2026-08-06. The number did not need to move: the bar is a multiple
   * of the cadence rather than a fixed count, and fourteen missed fires is still
   * nowhere near a healthy gap. Halve the cadence again and re-read this.
   */
  newsStaleAfterDays: 7,

  /**
   * The same for jobs, and it is a different number because the cadence is:
   * `findJobs` fires daily and gates itself with `jobPipeline.intervalHours`, so
   * a week here would be several missed cycles rather than twenty missed fires.
   *
   * **The bar must clear the pipeline's own healthy range**, or a boot spends the
   * run's scoring call — this system's single most expensive request — on a cycle
   * the next 08:00 would have started anyway. At the current 20h gate a daily
   * fire runs *every* fire, so the healthy range is 24h, stretching to ~48h after
   * a run that started off the 08:00 rhythm (which is exactly what a catch-up run
   * produces). Seventy-two hours sits clear above that.
   *
   * **Three is now conservative rather than tight, and deliberately left there.**
   * It was calibrated against a 44h gate, where the ceiling was 68h and 72h was
   * the next safe step. Lowering the gate to 20h dropped the ceiling to ~48h, so
   * this could be two — but two days *is* 48h, which puts the bar exactly on the
   * ceiling, and that is the collision this comment exists to prevent. The cost
   * of leaving it at three is a jobs digest up to a day later after an outage.
   *
   * **So this is coupled to `jobPipeline.intervalHours`, with nothing enforcing
   * it.** Raise that gate past 48h and the healthy ceiling climbs back through
   * 72h, and the only symptom is boots quietly spending scoring calls.
   * `pnpm catchup:check` has the case that fails when it happens.
   */
  jobsStaleAfterDays: 3,

  /**
   * A scheduled fire this close is left to the scheduler.
   *
   * Waiting twenty minutes for the 08:00 digest costs the reader nothing.
   * Starting a run twenty minutes before a scheduled one is how two runs end up
   * delivering at once — the failure the job pipeline's own gate already exists
   * to prevent, arriving through a different door.
   */
  imminentWithinMinutes: 30,

  /**
   * How long a boot waits for the orchestration worker before giving up.
   *
   * Firing a schedule publishes a `workflow.start` event; the worker that
   * consumes it is started by the server a moment after this module is
   * evaluated. Publishing before it subscribes drops the event silently, which
   * is the one failure mode here that looks exactly like success.
   */
  workerReadyTimeoutMs: 120_000,

  /** How often to re-check for that worker while waiting. */
  workerPollMs: 500,
} as const
