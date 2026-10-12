/**
 * Reports what a boot *right now* would do to the live pipelines.
 *
 *     pnpm catchup:check
 *
 * `decideCatchup` runs unattended, once, on a path that is invisible when it is
 * right and expensive when it is wrong: a wrong "fire" starts a curation run
 * beside a scheduled one, and a wrong "skip" leaves the reader with silence
 * after a downtime — the exact thing the catch-up exists to end.
 *
 * Every guard in `src/config/catchup.ts` has its case in
 * `src/mastra/__tests__/boot-catchup.test.ts`, which `pnpm verify` runs. This
 * script is the half a test cannot be: the decision against the real tables
 * and the real schedule rows.
 *
 * Reads the live database. Writes nothing, fires nothing, calls no model.
 */

import { CATCHUP_TARGETS, decideCatchup, scheduleFires } from '../src/mastra/boot-catchup.js'

const hours = (count: number) => count * 3_600_000

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
