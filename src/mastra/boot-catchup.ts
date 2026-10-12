import type { Mastra } from '@mastra/core'
import { catchup } from '../config/catchup.js'
import { lastFeedFetchAt } from '../db/feeds.js'
import { lastRunStartedAt } from '../db/jobs.js'
import { storage } from './storage.js'
import { curateAll } from './workflows/curate-all.js'
import { findJobs } from './workflows/find-jobs.js'

/**
 * A boot fires a pipeline that has stopped running — a week without news, two
 * days without jobs, each pipeline judged against its own cadence.
 *
 * Schedules are persisted and survive a restart, which is the behaviour you
 * want and also the whole problem: a machine that was off for a fortnight comes
 * back knowing only when the *next* fire is due. Nothing anywhere reads the gap.
 * So the reader turns the container back on and hears nothing until the next digest hour, and
 * the job run is up to a further day behind that
 * ([ADR-0025](../../docs/decisions/0025-a-boot-catch-up-for-a-stale-pipeline.md)).
 *
 * Three things are deliberate about the shape here.
 *
 * **It fires the schedule, not the workflow.** `mastra.schedules.run(id)` starts
 * exactly what the cron would have started — the schedule row carries the
 * `inputData` and `initialState` the declaration set, so a catch-up cannot drift
 * from a scheduled fire the way a hand-built `createRun()` can, and `curateAll`'s
 * defaultless `stateSchema` needs nothing spelled out at this call site. It also
 * writes a trigger row, so the fire is auditable in Studio next to the cron ones,
 * and it explicitly does not move the cadence: the next scheduled digest still happens.
 *
 * **Staleness is read from the pipelines' own tables**, not from a marker this
 * module writes. `feed_state.lastFetchedAt` and `job_runs.startedAt` are written
 * by the runs themselves, which means a catch-up that starts and then crashes
 * still counts as having spent the cycle — the same reasoning the job pipeline's
 * own gate is built on.
 *
 * **A paused schedule is never woken.** Pausing is a durable operator decision
 * ("this misfires, stop it while I look"), and a boot that undid it would make
 * restarting the container the way to re-break production.
 */

/** The subset of a schedule row this decision needs. */
export type ScheduleFire = {
  id: string
  status: 'active' | 'paused'
  nextFireAt: number
}

export type CatchupDecision =
  | { fire: true; scheduleId: string; reason: string }
  | { fire: false; reason: string }

const HOUR_MS = 3_600_000

/**
 * Whether a boot should fire this pipeline, given when it last ran and when it
 * is next due.
 *
 * Pure, and exported for `pnpm catchup:check` — this runs unattended at boot on
 * a path that is invisible when it decides correctly and expensive when it does
 * not, which is exactly the shape that never gets exercised otherwise.
 *
 * `staleAfterDays` is an argument rather than a config read because the two
 * pipelines answer it differently: a week of no news is twenty missed fires,
 * while a week of no jobs is three missed cycles. Passing it in also means the
 * check script can prove both bars against the same function.
 */
export function decideCatchup(input: {
  now: number
  lastRunAt: number | null
  staleAfterDays: number
  schedules: ScheduleFire[]
}): CatchupDecision {
  const active = input.schedules
    .filter(schedule => schedule.status === 'active')
    .sort((a, b) => a.nextFireAt - b.nextFireAt)

  // No active schedule means either a paused one — an operator's durable
  // decision — or a workflow whose schedule row has not been synced yet, on a
  // boot too early to tell. Both say wait, for opposite reasons.
  if (active.length === 0) return { fire: false, reason: 'no active schedule' }

  const ageHours = input.lastRunAt === null ? Infinity : (input.now - input.lastRunAt) / HOUR_MS
  const staleAfterHours = input.staleAfterDays * 24
  if (ageHours < staleAfterHours) {
    return { fire: false, reason: `last ran ${ageHours.toFixed(1)}h ago, under ${staleAfterHours}h` }
  }

  // Negative when a fire is already due and the scheduler's tick has not claimed
  // it yet — which is the strongest possible reason not to start a second one.
  const soonest = active[0]!
  const minutesToFire = (soonest.nextFireAt - input.now) / 60_000
  if (minutesToFire <= catchup.imminentWithinMinutes) {
    return {
      fire: false,
      reason: `${soonest.id} fires in ${minutesToFire.toFixed(0)}m, inside the ${catchup.imminentWithinMinutes}m window`,
    }
  }

  const age = input.lastRunAt === null ? 'never run' : `last ran ${(ageHours / 24).toFixed(1)}d ago`
  return {
    fire: true,
    scheduleId: soonest.id,
    reason: `${age}, next fire ${(minutesToFire / 60).toFixed(1)}h away`,
  }
}

/**
 * The schedule rows a workflow declared, through Mastra's own storage API.
 *
 * Read from `storage` rather than from `mastra.schedules` so the check script
 * can ask the same question without constructing a Mastra instance — the flat
 * `mastra.schedules` view needs one, and building it would boot both Telegram
 * bots to answer a read-only question. Invariant 4 is about who *owns* a table;
 * this reads Mastra's through Mastra's API, never as raw SQL.
 */
export async function scheduleFires(workflowId: string): Promise<ScheduleFire[]> {
  const schedules = await storage.getStore('schedules')
  if (!schedules) return []
  const rows = await schedules.listSchedules({ workflowId })
  return rows.map(row => ({ id: row.id, status: row.status, nextFireAt: row.nextFireAt }))
}

/** One pipeline, named by the workflow whose schedule a catch-up would fire. */
export type CatchupTarget = {
  label: string
  workflowId: string
  /** This pipeline's own bar, because the two cadences are an order apart. */
  staleAfterDays: number
  lastRunAt: () => Promise<number | null>
}

/**
 * The two pipelines, in the order a boot considers them.
 *
 * `workflowId` is read off each workflow rather than written out: a schedule row
 * is keyed by the id in `createWorkflow`, which is the kebab-case one and *not*
 * the key it is registered under in `index.ts`. Spelling either by hand is a
 * silent miss — an unknown id lists no schedules and the catch-up decides,
 * correctly and uselessly, to do nothing.
 */
export const CATCHUP_TARGETS: CatchupTarget[] = [
  {
    label: 'news',
    workflowId: curateAll.id,
    staleAfterDays: catchup.newsStaleAfterDays,
    lastRunAt: lastFeedFetchAt,
  },
  {
    label: 'jobs',
    workflowId: findJobs.id,
    staleAfterDays: catchup.jobsStaleAfterDays,
    lastRunAt: lastRunStartedAt,
  },
]

/**
 * Waits for the worker that consumes `workflow.start`.
 *
 * The scheduler does not run workflows: it publishes, and the orchestration
 * worker executes. Both come up inside the server's `startWorkers()`, a moment
 * after this module is evaluated — so firing on the way past drops the event
 * into a pubsub nobody is subscribed to, which fails *silently* and leaves a
 * trigger row saying it published.
 *
 * Returns false on timeout rather than throwing: no workers means no schedules
 * are firing at all, which is a bigger problem than a missed catch-up and not
 * one this module can fix.
 */
async function workersReady(mastra: Mastra): Promise<boolean> {
  const deadline = Date.now() + catchup.workerReadyTimeoutMs
  while (Date.now() < deadline) {
    if (mastra.getWorker('orchestration')?.isRunning) return true
    await new Promise(resolve => setTimeout(resolve, catchup.workerPollMs))
  }
  return mastra.getWorker('orchestration')?.isRunning === true
}

/**
 * Fires whichever pipelines are past their own staleness bar.
 *
 * Fire-and-forget from `index.ts`, and it must stay that way: every decision
 * here is optional, and none of it may hold up the surface coming back.
 *
 * **The window this does not close.** A container in a crash loop could fire a
 * catch-up on each boot. What bounds it is that both runs write their own
 * staleness marker in the first seconds — ingest stamps `feed_state`, and
 * `startJobRun()` writes `job_runs.startedAt` — so the next boot sees a fresh
 * pipeline and stands down. A restart inside that first window would start a
 * second run; a process restarting every few seconds has worse problems, and
 * invariant 6 already assumes a single replica.
 */
export async function catchUpOnBoot(mastra: Mastra): Promise<void> {
  const logger = mastra.getLogger()

  if (!(await workersReady(mastra))) {
    logger?.warn('Boot catch-up skipped: the orchestration worker never came up')
    return
  }

  for (const target of CATCHUP_TARGETS) {
    try {
      const decision = decideCatchup({
        now: Date.now(),
        lastRunAt: await target.lastRunAt(),
        staleAfterDays: target.staleAfterDays,
        schedules: await scheduleFires(target.workflowId),
      })

      if (!decision.fire) {
        logger?.info(`Boot catch-up: leaving ${target.label} alone — ${decision.reason}`)
        continue
      }

      await mastra.schedules.run(decision.scheduleId)
      logger?.info(
        `Boot catch-up: firing ${target.label} (${decision.scheduleId}) — ${decision.reason}`,
      )
    } catch (error) {
      // One pipeline's catch-up must not take the other's with it.
      logger?.error(`Boot catch-up failed for ${target.label}`, error)
    }
  }
}
