/**
 * The boot catch-up's numbers.
 *
 * A container that was off for a fortnight comes back with its schedules intact
 * and nothing to show for the gap: the next digest is at its usual hour whatever happened
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
   * nowhere near a healthy gap. Halve the cadence again and re-read this —
   * `definePipeline` refuses a bar at or under the healthy ceiling, today the
   * 5h gate plus the 14h gap from 20:00 to 10:00 plus a DST hour: 20h.
   */
  newsStaleAfterDays: 7,

  /**
   * The same for jobs, and it is a different number because the cadence is:
   * `findJobs` fires daily and gates itself with `jobPipeline.intervalHours`, so
   * a week here would be several missed cycles rather than twenty missed fires.
   *
   * **The bar must clear the pipeline's own healthy range**, or a boot spends the
   * run's scoring call — this system's single most expensive request — on a cycle
   * the next fire would have started anyway. `definePipeline` refuses to load a
   * bar at or under that ceiling (`src/mastra/pipeline-kit.ts`): the 20h gate,
   * plus the widest gap between the 08:00 and 20:00 fires (12h), plus a DST
   * hour — 33h.
   *
   * **Three is conservative rather than tight, and deliberately left there.** It
   * was calibrated against a 44h gate and a single fire. Two days would clear
   * today's ceiling by fifteen hours; the cost of three is a jobs digest up to a
   * day later after an outage.
   */
  jobsStaleAfterDays: 3,

  /**
   * The same for leads, checked against its cadence by `definePipeline` the same
   * way.
   *
   * The ceiling is the 44h gate plus the widest gap between the 09:00 and 21:00
   * fires (12h) plus a DST hour — 57h. Three days clears it by fifteen. Four
   * would too, and would only add a day of silence after an outage.
   */
  leadsStaleAfterDays: 3,

  /**
   * A scheduled fire this close is left to the scheduler.
   *
   * Waiting twenty minutes for the next digest costs the reader nothing.
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
