import { describe, expect, it } from 'vitest'

import { catchup } from '../../config/catchup.js'
import { jobPipeline } from '../../config/jobs.js'
import { decideCatchup, type CatchupDecision, type ScheduleFire } from '../boot-catchup.js'

// `decideCatchup` runs unattended, once, on a path that is invisible when it is right and expensive
// when it is wrong: a wrong "fire" starts a run beside a scheduled one, a wrong "skip" leaves the
// reader with silence after a downtime. Every guard in `src/config/catchup.ts` gets a case here.
// What a boot *right now* would do to the live pipelines is `pnpm catchup:check`.

/**
 * The reason strings carry numbers that would make this a change-detector, so only the decision
 * itself is asserted — and the schedule, when both sides fire.
 */
function expectDecision(actual: CatchupDecision, expected: { fire: false } | { fire: true; scheduleId: string }) {
  expect(actual.fire, actual.reason).toBe(expected.fire)
  if (actual.fire && expected.fire) expect(actual.scheduleId, actual.reason).toBe(expected.scheduleId)
}

const now = Date.parse('2026-08-04T12:00:00Z')
const hours = (count: number) => count * 3_600_000
const days = (count: number) => hours(count * 24)

/** The news bar, unless a case is about the jobs one. */
const NEWS = catchup.newsStaleAfterDays
const JOBS = catchup.jobsStaleAfterDays

const active = (id: string, firesInHours: number): ScheduleFire => ({
  id,
  status: 'active',
  nextFireAt: now + hours(firesInHours),
})

const digests: ScheduleFire[] = [active('digest-0800', 20), active('digest-1300', 1), active('digest-1900', 7)]

/** `now` and the news bar bound, so a case only states what it is about. */
const decide = (input: {
  lastRunAt: number | null
  schedules: ScheduleFire[]
  staleAfterDays?: number
}): CatchupDecision => decideCatchup({ now, staleAfterDays: NEWS, ...input })

describe('the staleness gate, per pipeline', () => {
  it('news that ingested this morning is left alone', () => {
    expectDecision(decide({ lastRunAt: now - hours(5), schedules: digests }), { fire: false })
  })

  it(`news idle ${NEWS - 1}d is still under its ${NEWS}d bar`, () => {
    expectDecision(decide({ lastRunAt: now - days(NEWS - 1), schedules: [active('nightly', 10)] }), { fire: false })
  })

  it(`news idle ${NEWS + 1}d fires`, () => {
    expectDecision(decide({ lastRunAt: now - days(NEWS + 1), schedules: [active('nightly', 10)] }), {
      fire: true,
      scheduleId: 'nightly',
    })
  })

  // The two bars are the point of the split: the same age is a healthy news pipeline and a jobs
  // pipeline that has missed its cycle.
  it(`jobs idle ${JOBS + 1}d fires, where news at the same age would not`, () => {
    expectDecision(
      decide({ lastRunAt: now - days(JOBS + 1), schedules: [active('jobs-daily', 10)], staleAfterDays: JOBS }),
      { fire: true, scheduleId: 'jobs-daily' },
    )
  })

  it(`news idle ${JOBS + 1}d does not`, () => {
    expectDecision(decide({ lastRunAt: now - days(JOBS + 1), schedules: [active('nightly', 10)] }), { fire: false })
  })

  // The bar is inclusive — `>=` fires — so an hour under it is the last quiet case, and the
  // boundary itself is the first firing one.
  it(`jobs idle an hour under ${JOBS}d is left alone`, () => {
    expectDecision(
      decide({ lastRunAt: now - days(JOBS) + hours(1), schedules: [active('jobs-daily', 10)], staleAfterDays: JOBS }),
      { fire: false },
    )
  })

  it(`jobs idle ${JOBS}d to the second fires`, () => {
    expectDecision(
      decide({ lastRunAt: now - days(JOBS), schedules: [active('jobs-daily', 10)], staleAfterDays: JOBS }),
      { fire: true, scheduleId: 'jobs-daily' },
    )
  })

  // The guard on the one coupling nothing else enforces. A daily fire gated at `intervalHours`
  // runs every other fire — 48h apart on the usual rhythm, and up to `intervalHours + 24` after a
  // run that started off it, which is what a catch-up run itself produces. The bar has to clear
  // that ceiling, or a boot on an ordinary day spends a scoring call on a pipeline that is
  // perfectly healthy. Raising `jobPipeline.intervalHours` past 48 is what breaks this, and this
  // case is the only thing that would say so.
  const healthyCeilingHours = jobPipeline.intervalHours + 24
  it(`jobs at the top of its healthy range (${healthyCeilingHours}h) is left alone`, () => {
    expectDecision(
      decide({ lastRunAt: now - hours(healthyCeilingHours), schedules: [active('jobs-daily', 10)], staleAfterDays: JOBS }),
      { fire: false },
    )
  })

  it('a pipeline that has never run fires', () => {
    expectDecision(decide({ lastRunAt: null, schedules: [active('nightly', 10)] }), { fire: true, scheduleId: 'nightly' })
  })
})

describe('the imminent-fire gate', () => {
  // The imminent fire is also the soonest, so this covers the sort and the window together —
  // which is the pairing that decides a real boot minutes before a scheduled fire.
  it('a fortnight idle, but the next digest is twenty minutes out', () => {
    expectDecision(
      decide({
        lastRunAt: now - days(14),
        schedules: [active('digest-1900', 7), { id: 'digest-0800', status: 'active', nextFireAt: now + 20 * 60_000 }],
      }),
      { fire: false },
    )
  })

  it(`a fire ${catchup.imminentWithinMinutes - 5}m away waits`, () => {
    expectDecision(
      decide({
        lastRunAt: now - days(14),
        schedules: [{ id: 'soon', status: 'active', nextFireAt: now + (catchup.imminentWithinMinutes - 5) * 60_000 }],
      }),
      { fire: false },
    )
  })

  it(`a fire ${catchup.imminentWithinMinutes + 5}m away does not`, () => {
    expectDecision(
      decide({
        lastRunAt: now - days(14),
        schedules: [{ id: 'later', status: 'active', nextFireAt: now + (catchup.imminentWithinMinutes + 5) * 60_000 }],
      }),
      { fire: true, scheduleId: 'later' },
    )
  })

  it('the jobs run due at 08:00 is left to the scheduler when a boot lands at 07:40', () => {
    expectDecision(
      decide({
        lastRunAt: now - days(3),
        schedules: [{ id: 'jobs-daily', status: 'active', nextFireAt: now + 20 * 60_000 }],
        staleAfterDays: JOBS,
      }),
      { fire: false },
    )
  })

  it('a fire already overdue is left to the scheduler', () => {
    expectDecision(decide({ lastRunAt: now - days(14), schedules: [active('overdue', -2)] }), { fire: false })
  })

  it('the soonest schedule is the one fired, not the first listed', () => {
    expectDecision(
      decide({
        lastRunAt: now - days(14),
        schedules: [active('digest-1900', 7), active('digest-0800', 20), active('digest-1300', 5)],
      }),
      { fire: true, scheduleId: 'digest-1300' },
    )
  })
})

describe('what a boot must never wake', () => {
  it('a paused schedule stays paused, however stale the pipeline', () => {
    expectDecision(
      decide({
        lastRunAt: now - days(30),
        schedules: [{ id: 'digest-0800', status: 'paused', nextFireAt: now + hours(20) }],
      }),
      { fire: false },
    )
  })

  it('a paused schedule beside an active one does not win the sort', () => {
    expectDecision(
      decide({
        lastRunAt: now - days(30),
        schedules: [{ id: 'paused-soon', status: 'paused', nextFireAt: now + hours(1) }, active('active-later', 9)],
      }),
      { fire: true, scheduleId: 'active-later' },
    )
  })

  it('a workflow with no schedule row yet is left alone', () => {
    expectDecision(decide({ lastRunAt: null, schedules: [] }), { fire: false })
  })
})
