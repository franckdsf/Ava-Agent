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
   * Against three digests a day this is twenty missed fires — far enough out
   * that no reading of "the schedule has not been running" disagrees, and not
   * reachable by a slow run or a quiet week of feeds.
   */
  newsStaleAfterDays: 7,

  /**
   * The same for jobs, and it is a different number because the cadence is:
   * `findJobs` fires daily and gates itself to every two days, so a week here
   * would be three missed cycles rather than twenty missed fires.
   *
   * **Three rather than two, so the bar clears the pipeline's own healthy
   * range.** A daily fire gated at `jobPipeline.intervalHours` (44h) runs every
   * *other* fire — 48h apart on the usual cycle, and up to
   * `intervalHours + 24` = 68h after a run that started off the 08:00 rhythm,
   * which is exactly what a catch-up run produces. Two days (48h) falls inside
   * that: a restart on an ordinary Tuesday would fire a run the next 08:00 would
   * have started anyway, and that run's scoring call is this system's single most
   * expensive request. Seventy-two hours sits above the ceiling, so a boot fires
   * only when a cycle was genuinely missed. The cost is a jobs digest that can
   * wait up to a day longer after an outage.
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
