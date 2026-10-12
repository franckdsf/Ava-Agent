import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '../../db/client.js'
import { startRun } from '../../db/runs.js'
import { pipelineRuns } from '../../db/schema.js'
import { definePipeline, healthyCeilingHours, type PipelineDefinition } from '../pipeline-kit.js'

// The real `startRun`, wrapped so one case can make the run row lose the write lock.
vi.mock('../../db/runs.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../db/runs.js')>()
  return { ...actual, startRun: vi.fn(actual.startRun) }
})

// Audit F1/F2: the cycle is handed back when a run stops before spending anything, and a cadence
// that contradicts itself does not load. Against a real SQLite (vitest.setup.ts), because the
// release is a guarded write and a mock would test nothing. Only `Date` is faked.

const HOUR = 3_600_000
const t0 = Date.parse('2026-08-23T08:00:00Z')

const cadence = { runHours: [9, 21], intervalHours: 44, staleAfterDays: 3 }

/** A fresh pipeline id per test, so tests share the database but never a row. */
function pipeline(overrides: Partial<PipelineDefinition> = {}) {
  return definePipeline({
    id: `test-${randomUUID()}`,
    workflowId: 'test-workflow',
    scheduleId: 'test-daily',
    ...cadence,
    ...overrides,
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(t0)
})
afterEach(() => {
  vi.useRealTimers()
})

const at = (offsetMs: number) => vi.setSystemTime(t0 + offsetMs)
const proceed = async () => 'ran'

describe('the window before spending', () => {
  it('a run that returns normally keeps the cycle — the next fire inside the gate is refused', async () => {
    const leads = pipeline()
    expect(await leads.open({}, proceed)).toEqual({ ok: true, value: 'ran', runId: expect.any(String) })
    at(12 * HOUR)
    expect(await leads.open({}, proceed)).toEqual({
      ok: false,
      note: `Only 12.0h since the last ${leads.id} run; the interval is 44h.`,
    })
  })

  it('a throw inside the window (SQLITE_BUSY on 2026-08-23) rethrows and hands the cycle back', async () => {
    const leads = pipeline()
    const busy = new Error('SQLITE_BUSY: database is locked')
    await expect(leads.open({}, async () => { throw busy })).rejects.toBe(busy)
    at(1 * HOUR)
    expect(await leads.open({}, proceed)).toEqual({ ok: true, value: 'ran', runId: expect.any(String) })
  })

  it('abandon (no client profiles) reports its note and hands the cycle back', async () => {
    const leads = pipeline()
    const note = 'Nobody to prospect for — no active client profiles. Use /client.'
    expect(await leads.open({}, async ({ abandon }) => abandon(note))).toEqual({ ok: false, note })
    at(1 * HOUR)
    expect(await leads.open({}, proceed)).toEqual({ ok: true, value: 'ran', runId: expect.any(String) })
  })

  it('an abandoned run after a real one restores the real one’s stamp, not none', async () => {
    const leads = pipeline()
    await leads.open({}, proceed)
    at(45 * HOUR)
    await leads.open({}, async ({ abandon }) => abandon('nobody'))
    at(46 * HOUR)
    expect(await leads.open({}, proceed)).toEqual({ ok: true, value: 'ran', runId: expect.any(String) })
    at(47 * HOUR)
    expect((await leads.open({}, proceed)).ok).toBe(false)
  })

  it('a refused run never enters the window', async () => {
    const leads = pipeline()
    await leads.open({}, proceed)
    at(1 * HOUR)
    const window = vi.fn(proceed)
    await leads.open({}, window)
    expect(window).not.toHaveBeenCalled()
  })

  it('force passes the gate and still spends the cycle', async () => {
    const leads = pipeline()
    await leads.open({}, proceed)
    at(1 * HOUR)
    expect(await leads.open({ force: true }, proceed)).toEqual({ ok: true, value: 'ran', runId: expect.any(String) })
    at(2 * HOUR)
    expect((await leads.open({}, proceed)).ok).toBe(false)
  })
})

describe('the run log (audit D2)', () => {
  const rows = (pipelineId: string) => db().select().from(pipelineRuns).where(eq(pipelineRuns.pipeline, pipelineId))

  it('an opened run has its row, started at the claim and not yet finished, under the id it was handed', async () => {
    const leads = pipeline()
    const opened = await leads.open({}, proceed)
    if (!opened.ok) throw new Error('expected the run to open')
    expect(await rows(leads.id)).toEqual([
      expect.objectContaining({ id: opened.runId, startedAt: t0, finishedAt: null }),
    ])
  })

  it('an abandoned run, a throw in the window and a refused fire write no row', async () => {
    const leads = pipeline()
    await leads.open({}, async ({ abandon }) => abandon('nobody'))
    await expect(leads.open({}, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await leads.open({}, proceed)
    at(1 * HOUR)
    await leads.open({}, proceed)
    expect(await rows(leads.id)).toHaveLength(1)
  })

  it('the row losing the write lock (SQLITE_BUSY on 2026-08-23) rethrows and hands the cycle back', async () => {
    const leads = pipeline()
    const busy = new Error('SQLITE_BUSY: database is locked')
    vi.mocked(startRun).mockRejectedValueOnce(busy)
    await expect(leads.open({}, proceed)).rejects.toBe(busy)
    at(1 * HOUR)
    expect((await leads.open({}, proceed)).ok).toBe(true)
  })
})

describe('the cadence is one definition', () => {
  it('renders every fire hour into one cron under the kept schedule id', () => {
    expect(pipeline().schedule[0]).toMatchObject({ id: 'test-daily', cron: '0 9,21 * * *', inputData: {} })
  })

  it('the healthy ceiling is the gate plus the widest gap between fires, plus a DST hour', () => {
    expect(healthyCeilingHours({ runHours: [9, 21], intervalHours: 44 })).toBe(44 + 12 + 1)
    expect(healthyCeilingHours({ runHours: [9], intervalHours: 44 })).toBe(44 + 24 + 1)
    expect(healthyCeilingHours({ runHours: [8, 20], intervalHours: 20 })).toBe(20 + 12 + 1)
  })

  it('a catch-up bar at or under the ceiling does not load', () => {
    // One fire a day at a 44h gate is a 69h ceiling — leads before this slice. Three days clears
    // it by three hours; two does not clear it at all.
    expect(() => pipeline({ runHours: [9], staleAfterDays: 2 })).toThrow(/not above the healthy ceiling/)
    expect(() => pipeline({ intervalHours: 80, staleAfterDays: 3 })).toThrow(/not above the healthy ceiling/)
    expect(() => pipeline({ runHours: [9], staleAfterDays: 3 })).not.toThrow()
  })

  it('fire hours that cannot fire do not load', () => {
    expect(() => pipeline({ runHours: [] })).toThrow(/never fire/)
    expect(() => pipeline({ runHours: [24] })).toThrow(/not an hour/)
    expect(() => pipeline({ runHours: [9, 9] })).toThrow(/repeats/)
  })
})
