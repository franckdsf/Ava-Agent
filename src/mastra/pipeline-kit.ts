import { env } from '../config/env.js'
import { claimCycle, hoursSince } from '../db/cycles.js'

/**
 * The mechanics around a scheduled pipeline, written once
 * ([audit F2](../../docs/audit/03-FLAWS.md#-f2--pipeline-mechanics-are-written-three-times)).
 *
 * Every pipeline here is *claim → work → report*, and the claim, the cadence and
 * the boot catch-up were each solved once and copied by hand. That is how F1
 * happened: `7762cf4` gave jobs a second fire and a claim that releases itself,
 * and leads — the same shape — got neither. A pipeline keeps its own steps; what
 * it no longer writes is what surrounds them.
 *
 * **The cadence is one definition**, so its three numbers cannot disagree: the
 * fire hours, the gate, and how long a pipeline may go quiet before a boot runs
 * it. `definePipeline` refuses a set that contradicts itself, at load, rather
 * than letting a boot quietly spend a cycle the next fire was about to start.
 */

const HOUR_MS = 3_600_000

/**
 * A DST night stretches one gap between fires by an hour. Counted in the
 * ceiling so a bar set exactly on it is refused rather than hit twice a year.
 */
const DST_SLACK_HOURS = 1

export type PipelineDefinition = {
  /** The `pipeline_cycles` key. */
  id: string
  /**
   * The id passed to `createWorkflow`, which takes it from here. A schedule row is
   * keyed by this, so the catch-up reads the same string the workflow declares.
   */
  workflowId: string
  /**
   * The stored schedule row's key. **Never rename it**: a renamed id strands the
   * old row, and a stranded row is still active — one pipeline, two schedules.
   * Changing `runHours` under the same id updates the row in place.
   */
  scheduleId: string
  /** Hours of day the schedule fires, in `AGENT_TIMEZONE`. Every fire past the first is a retry. */
  runHours: readonly number[]
  /** Hours that must have elapsed since the last claimed run. The gate decides, not the cron. */
  intervalHours: number
  /** How long the pipeline may go without a run before a boot fires it. */
  staleAfterDays: number
}

/** What `abandon` returns, so `open` can tell a deliberate stop from a value. */
class Abandoned {
  constructor(readonly note: string) {}
}

export type Opened<T> = { ok: true; value: T } | { ok: false; note: string }

export type Pipeline = PipelineDefinition & {
  /** For `createWorkflow({ schedule })`: one cron carrying every fire hour. */
  schedule: [{ id: string; cron: string; timezone: string; inputData: Record<string, never> }]

  /**
   * Claims the cycle, then runs `beforeSpending` — the window in which the run
   * may still stop without having cost anything.
   *
   * The claim is written before any work so two fires cannot both pass the gate
   * ([ADR-0034](../../docs/decisions/0034-a-pipeline-claims-its-cycle.md)). The
   * price is that a run stopping on its first statement still burns the
   * interval, and it did: on 2026-08-23 a run lost the write lock with
   * `SQLITE_BUSY` before touching a source. So inside the window:
   *
   * - a throw releases the claim and rethrows;
   * - `abandon(note)` releases it and resolves `{ ok: false, note }`;
   * - returning normally keeps it — **everything after `open` resolves has
   *   spent the cycle**, and nothing hands it back.
   *
   * A callback rather than `begin()` / `spend()`: between those two calls nothing
   * could catch a throw, and that gap is exactly where `SQLITE_BUSY` struck.
   * Put only what spends nothing inside — no source fetch, no model call.
   */
  open<T>(
    options: { force?: boolean },
    beforeSpending: (window: { abandon: (note: string) => Abandoned }) => Promise<T | Abandoned>,
  ): Promise<Opened<T>>
}

/**
 * The longest a healthy pipeline waits between two runs: the gate opens, and
 * the next fire after it can be up to the widest gap between fires away.
 *
 * Off-rhythm runs land here, which is every run the scheduler replays at boot at
 * whatever hour the container came up — so this is the healthy range a boot
 * catch-up must stay above, not an outage.
 */
export function healthyCeilingHours(def: Pick<PipelineDefinition, 'runHours' | 'intervalHours'>): number {
  const hours = [...def.runHours].sort((a, b) => a - b)
  const gaps = hours.map((hour, index) =>
    index === hours.length - 1 ? 24 - hour + hours[0]! : hours[index + 1]! - hour,
  )
  return def.intervalHours + Math.max(...gaps) + DST_SLACK_HOURS
}

/** Throws on a cadence that cannot be right, so a bad config fails at boot (P4). */
function assertCadence(def: PipelineDefinition): void {
  const { id, runHours, intervalHours, staleAfterDays } = def
  if (runHours.length === 0) throw new Error(`${id}: runHours is empty — the pipeline would never fire`)
  for (const hour of runHours) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error(`${id}: runHours has ${hour}, not an hour of the day`)
    }
  }
  if (new Set(runHours).size !== runHours.length) throw new Error(`${id}: runHours repeats an hour`)
  if (!(intervalHours > 0)) throw new Error(`${id}: intervalHours must be positive`)

  const ceiling = healthyCeilingHours(def)
  if (staleAfterDays * 24 <= ceiling) {
    throw new Error(
      `${id}: staleAfterDays ${staleAfterDays} (${staleAfterDays * 24}h) is not above the healthy ` +
        `ceiling of ${ceiling}h (${intervalHours}h gate + widest gap between ${runHours.join(', ')} + DST). ` +
        `A boot would spend a cycle the next fire was about to start.`,
    )
  }
}

export function definePipeline(def: PipelineDefinition): Pipeline {
  assertCadence(def)

  return {
    ...def,
    schedule: [
      {
        id: def.scheduleId,
        cron: `0 ${def.runHours.join(',')} * * *`,
        timezone: env.AGENT_TIMEZONE,
        inputData: {},
      },
    ],

    async open(options, beforeSpending) {
      const cycle = await claimCycle(def.id, def.intervalHours * HOUR_MS, { force: options.force })
      if (!cycle.claimed) {
        const elapsed = hoursSince(cycle.lastStartedAt).toFixed(1)
        return {
          ok: false,
          note: `Only ${elapsed}h since the last ${def.id} run; the interval is ${def.intervalHours}h.`,
        }
      }

      let result
      try {
        result = await beforeSpending({ abandon: note => new Abandoned(note) })
      } catch (error) {
        await cycle.release()
        throw error
      }
      if (result instanceof Abandoned) {
        await cycle.release()
        return { ok: false, note: result.note }
      }
      return { ok: true, value: result }
    },
  }
}
