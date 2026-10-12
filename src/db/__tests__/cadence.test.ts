import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { jobPipeline } from '../../config/jobs.js'
import { leadPipeline } from '../../config/leads.js'
import { claimCycle } from '../cycles.js'

// What a schedule and a gate produce together: the scheduled fires, each one asking `claimCycle`
// with the pipeline's real `intervalHours`, over simulated days. Audit F1 is the reason — jobs got
// two fires a day in 7762cf4 "so a refused fire is not the day's only chance", leads did not.
//
// The property: **once the gate opens, a fire comes within half a day.** That is the jobs fix's
// promise, stated as a number. A single daily fire breaks it whenever a run lands off-rhythm —
// which is every run the scheduler replays at boot, at whatever hour the container came up.
//
// Hours are plain offsets from a UTC midnight: only the gaps matter, and the gaps do not depend on
// the timezone (a DST night shifts one gap by an hour, which no case here is near).

const HOUR = 3_600_000
const HALF_A_DAY = 12 * HOUR
const midnight = Date.parse('2026-08-03T00:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

let pipelineSeq = 0

/**
 * Runs one off-schedule start at `firstRunHour` on day 0, then every scheduled fire for `days`,
 * and returns the times of the runs that won their claim, the first one included.
 */
async function runs(pipeline: { fireHours: readonly number[]; intervalHours: number }, firstRunHour: number, days = 7) {
  const id = `cadence-${pipelineSeq++}`
  const gap = pipeline.intervalHours * HOUR

  vi.setSystemTime(midnight + firstRunHour * HOUR)
  await claimCycle(id, gap, { force: true })
  const won = [midnight + firstRunHour * HOUR]

  const fires = Array.from({ length: days }, (_, day) =>
    pipeline.fireHours.map(hour => midnight + (day * 24 + hour) * HOUR),
  )
    .flat()
    .filter(fire => fire > won[0]!)
    .sort((a, b) => a - b)

  for (const fire of fires) {
    vi.setSystemTime(fire)
    if ((await claimCycle(id, gap)).claimed) won.push(fire)
  }
  return won
}

/** Hours from each run to the next. */
const gapsInHours = (times: number[]) => times.slice(1).map((time, i) => (time - times[i]!) / HOUR)

const jobs = { fireHours: jobPipeline.runHours, intervalHours: jobPipeline.intervalHours }
// Slice 2 gives leads `runHours` and reads it here; until then its one fire is the whole list.
const leads = { fireHours: [leadPipeline.runHour], intervalHours: leadPipeline.intervalHours }

describe('jobs — two fires a day, one gate', () => {
  it('on its rhythm, runs once a day', async () => {
    const times = await runs(jobs, jobs.fireHours[0]!)
    expect(new Set(gapsInHours(times))).toEqual(new Set([24]))
  })

  it('after an off-rhythm run (15:00), the next comes within half a day of the gate opening', async () => {
    const [first, second] = await runs(jobs, 15)
    expect(second! - first!).toBeLessThanOrEqual(jobs.intervalHours * HOUR + HALF_A_DAY)
  })
})

describe('leads — one fire a day, one gate', () => {
  it('on its rhythm, runs every other day', async () => {
    const times = await runs(leads, leads.fireHours[0]!)
    expect(new Set(gapsInHours(times))).toEqual(new Set([48]))
  })

  // F1, pinned before it is fixed: a 15:00 run is refused at 09:00 (18h) and 09:00 again (42h),
  // so the next run is 66h out — 22h after the gate opened. `it.fails` passes while that is true
  // and turns red the moment slice 2 fixes it, which is the signal to make this a plain `it`.
  it.fails('after an off-rhythm run (15:00), the next comes within half a day of the gate opening', async () => {
    const [first, second] = await runs(leads, 15)
    expect(second! - first!).toBeLessThanOrEqual(leads.intervalHours * HOUR + HALF_A_DAY)
  })
})
