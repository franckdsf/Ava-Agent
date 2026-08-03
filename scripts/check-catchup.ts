/**
 * Exercises the boot catch-up's decision against fixtures, and reports what a
 * boot *right now* would do to the live pipelines.
 *
 *     pnpm catchup:check
 *
 * `decideCatchup` runs unattended, once, on a path that is invisible when it is
 * right and expensive when it is wrong: a wrong "fire" starts a curation run
 * beside a scheduled one, and a wrong "skip" leaves the reader with silence
 * after a downtime — the exact thing the catch-up exists to end. It would
 * otherwise be exercised for the first time in production, on a boot nobody is
 * watching.
 *
 * Every guard in `src/config/catchup.ts` gets a case here. When you add or
 * change one, add the case that proves it.
 *
 * Reads the live database. Writes nothing, fires nothing, calls no model.
 */

import { catchup } from '../src/config/catchup.js'
import { jobPipeline } from '../src/config/jobs.js'
import {
  CATCHUP_TARGETS,
  decideCatchup,
  scheduleFires,
  type CatchupDecision,
  type ScheduleFire,
} from '../src/mastra/boot-catchup.js'

let failures = 0
function check(name: string, actual: CatchupDecision, expected: CatchupDecision) {
  // The reason strings carry numbers that would make this a change-detector, so
  // only the decision itself is asserted; the reason is printed to be read.
  const ok = actual.fire === expected.fire && (!actual.fire || !expected.fire || actual.scheduleId === expected.scheduleId)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${name}\n         ${actual.fire ? `fire ${actual.scheduleId}` : 'skip'} — ${actual.reason}`,
  )
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

console.log('\nFixtures — the staleness gate, per pipeline\n')

check(
  'news that ingested this morning is left alone',
  decide({ lastRunAt: now - hours(5), schedules: digests }),
  { fire: false, reason: '' },
)

check(
  `news idle ${NEWS - 1}d is still under its ${NEWS}d bar`,
  decide({ lastRunAt: now - days(NEWS - 1), schedules: [active('nightly', 10)] }),
  { fire: false, reason: '' },
)

check(
  `news idle ${NEWS + 1}d fires`,
  decide({ lastRunAt: now - days(NEWS + 1), schedules: [active('nightly', 10)] }),
  { fire: true, scheduleId: 'nightly', reason: '' },
)

// The two bars are the point of the split: the same age is a healthy news
// pipeline and a jobs pipeline that has missed its cycle.
check(
  `jobs idle ${JOBS + 1}d fires, where news at the same age would not`,
  decide({ lastRunAt: now - days(JOBS + 1), schedules: [active('jobs-daily', 10)], staleAfterDays: JOBS }),
  { fire: true, scheduleId: 'jobs-daily', reason: '' },
)

check(
  `news idle ${JOBS + 1}d does not`,
  decide({ lastRunAt: now - days(JOBS + 1), schedules: [active('nightly', 10)] }),
  { fire: false, reason: '' },
)

// The bar is inclusive — `>=` fires — so an hour under it is the last quiet
// case, and the boundary itself is the first firing one.
check(
  `jobs idle an hour under ${JOBS}d is left alone`,
  decide({
    lastRunAt: now - days(JOBS) + hours(1),
    schedules: [active('jobs-daily', 10)],
    staleAfterDays: JOBS,
  }),
  { fire: false, reason: '' },
)

check(
  `jobs idle ${JOBS}d to the second fires`,
  decide({ lastRunAt: now - days(JOBS), schedules: [active('jobs-daily', 10)], staleAfterDays: JOBS }),
  { fire: true, scheduleId: 'jobs-daily', reason: '' },
)

// The guard on the one coupling nothing else enforces. A daily fire gated at
// `intervalHours` runs every other fire — 48h apart on the usual rhythm, and up
// to `intervalHours + 24` after a run that started off it, which is what a
// catch-up run itself produces. The bar has to clear that ceiling, or a boot on
// an ordinary day spends a scoring call on a pipeline that is perfectly healthy.
// Raising `jobPipeline.intervalHours` past 48 is what breaks this, and this case
// is the only thing that would say so.
const healthyCeilingHours = jobPipeline.intervalHours + 24
check(
  `jobs at the top of its healthy range (${healthyCeilingHours}h) is left alone`,
  decide({
    lastRunAt: now - hours(healthyCeilingHours),
    schedules: [active('jobs-daily', 10)],
    staleAfterDays: JOBS,
  }),
  { fire: false, reason: '' },
)

check(
  'a pipeline that has never run fires',
  decide({ lastRunAt: null, schedules: [active('nightly', 10)] }),
  { fire: true, scheduleId: 'nightly', reason: '' },
)

console.log('\nFixtures — the imminent-fire gate\n')

// The imminent fire is also the soonest, so this covers the sort and the window
// together — which is the pairing that decides a real boot minutes before 08:00.
check(
  'a fortnight idle, but the next digest is twenty minutes out',
  decide({
    lastRunAt: now - days(14),
    schedules: [active('digest-1900', 7), { id: 'digest-0800', status: 'active', nextFireAt: now + 20 * 60_000 }],
  }),
  { fire: false, reason: '' },
)

check(
  `a fire ${catchup.imminentWithinMinutes - 5}m away waits`,
  decide({
    lastRunAt: now - days(14),
    schedules: [{ id: 'soon', status: 'active', nextFireAt: now + (catchup.imminentWithinMinutes - 5) * 60_000 }],
  }),
  { fire: false, reason: '' },
)

check(
  `a fire ${catchup.imminentWithinMinutes + 5}m away does not`,
  decide({
    lastRunAt: now - days(14),
    schedules: [{ id: 'later', status: 'active', nextFireAt: now + (catchup.imminentWithinMinutes + 5) * 60_000 }],
  }),
  { fire: true, scheduleId: 'later', reason: '' },
)

check(
  'the jobs run due at 08:00 is left to the scheduler when a boot lands at 07:40',
  decide({
    lastRunAt: now - days(3),
    schedules: [{ id: 'jobs-daily', status: 'active', nextFireAt: now + 20 * 60_000 }],
    staleAfterDays: JOBS,
  }),
  { fire: false, reason: '' },
)

check(
  'a fire already overdue is left to the scheduler',
  decide({ lastRunAt: now - days(14), schedules: [active('overdue', -2)] }),
  { fire: false, reason: '' },
)

check(
  'the soonest schedule is the one fired, not the first listed',
  decide({
    lastRunAt: now - days(14),
    schedules: [active('digest-1900', 7), active('digest-0800', 20), active('digest-1300', 5)],
  }),
  { fire: true, scheduleId: 'digest-1300', reason: '' },
)

console.log('\nFixtures — what a boot must never wake\n')

check(
  'a paused schedule stays paused, however stale the pipeline',
  decide({
    lastRunAt: now - days(30),
    schedules: [{ id: 'digest-0800', status: 'paused', nextFireAt: now + hours(20) }],
  }),
  { fire: false, reason: '' },
)

check(
  'a paused schedule beside an active one does not win the sort',
  decide({
    lastRunAt: now - days(30),
    schedules: [
      { id: 'paused-soon', status: 'paused', nextFireAt: now + hours(1) },
      active('active-later', 9),
    ],
  }),
  { fire: true, scheduleId: 'active-later', reason: '' },
)

check(
  'a workflow with no schedule row yet is left alone',
  decide({ lastRunAt: null, schedules: [] }),
  { fire: false, reason: '' },
)

/* ─────────────────────────── the live pipelines ─────────────────────────── */

console.log('\nLive — what a boot right now would do\n')

const liveNow = Date.now()
for (const target of CATCHUP_TARGETS) {
  const lastRunAt = await target.lastRunAt()
  const schedules = await scheduleFires(target.workflowId)
  const decision = decideCatchup({
    now: liveNow,
    lastRunAt,
    staleAfterDays: target.staleAfterDays,
    schedules,
  })

  console.log(`  ${target.label} (${target.workflowId}) — fires after ${target.staleAfterDays}d idle`)
  console.log(
    `    last run   ${lastRunAt === null ? 'never' : `${new Date(lastRunAt).toISOString()}  (${((liveNow - lastRunAt) / hours(1)).toFixed(1)}h ago)`}`,
  )
  if (schedules.length === 0) {
    console.log('    schedules  none — has this workflow ever booted with a schedule declared?')
  }
  for (const schedule of schedules.sort((a, b) => a.nextFireAt - b.nextFireAt)) {
    console.log(
      `    ${schedule.status === 'active' ? 'next  ' : 'paused'}     ${schedule.id} at ${new Date(schedule.nextFireAt).toISOString()}  (in ${((schedule.nextFireAt - liveNow) / hours(1)).toFixed(1)}h)`,
    )
  }
  console.log(
    `    verdict    ${decision.fire ? `FIRE ${decision.scheduleId}` : 'leave alone'} — ${decision.reason}\n`,
  )
}

console.log(
  failures === 0
    ? 'All fixture cases passed.\n'
    : `${failures} fixture case(s) FAILED.\n`,
)
process.exit(failures === 0 ? 0 : 1)
