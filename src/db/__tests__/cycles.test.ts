import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '../client.js'
import { claimCycle } from '../cycles.js'
import { pipelineCycles } from '../schema.js'

// ADR-0034: a pipeline claims its cycle in one guarded write. These run against a real, empty
// SQLite (vitest.setup.ts) because the guarded write *is* the behaviour — a mock would test
// nothing. Only `Date` is faked, so libsql's own timers are untouched.

const HOUR = 3_600_000
const GAP = 20 * HOUR
const t0 = Date.parse('2026-08-23T08:00:00Z')

/** A fresh pipeline id per test, so tests share the database but never a row. */
let id: string

beforeEach(() => {
  id = `test-${randomUUID()}`
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(t0)
})
afterEach(() => {
  vi.useRealTimers()
})

const at = (offsetMs: number) => vi.setSystemTime(t0 + offsetMs)

async function stamp(): Promise<number | null> {
  const [row] = await db().select({ startedAt: pipelineCycles.startedAt }).from(pipelineCycles).where(eq(pipelineCycles.id, id))
  return row?.startedAt ?? null
}

async function won(minGapMs = GAP, options: { force?: boolean } = {}) {
  const claim = await claimCycle(id, minGapMs, options)
  if (!claim.claimed) throw new Error(`expected to win the claim, was refused (last ${claim.lastStartedAt})`)
  return claim
}

describe('the claim', () => {
  it('the first claim on a fresh volume wins and stamps the row', async () => {
    await won()
    expect(await stamp()).toBe(t0)
  })

  it('a second claim inside the gap is refused, and names the winner’s stamp', async () => {
    await won()
    at(12 * HOUR)
    expect(await claimCycle(id, GAP)).toEqual({ claimed: false, lastStartedAt: t0 })
  })

  it('a claim past the gap wins', async () => {
    await won()
    at(GAP + 1)
    await won()
    expect(await stamp()).toBe(t0 + GAP + 1)
  })

  it('of two claims arriving together, exactly one wins', async () => {
    const claims = await Promise.all([claimCycle(id, GAP), claimCycle(id, GAP)])
    expect(claims.filter(claim => claim.claimed)).toHaveLength(1)
  })

  it('force claims inside the gap, and still stamps the row', async () => {
    await won()
    at(HOUR)
    await won(GAP, { force: true })
    expect(await stamp()).toBe(t0 + HOUR)
  })
})

describe('the release — only for a run that did nothing', () => {
  it('restores the stamp the claim found', async () => {
    await won()
    at(GAP + 1)
    const claim = await won()
    await claim.release()
    expect(await stamp()).toBe(t0)
  })

  it('on a fresh volume, deletes the row rather than inventing a timestamp', async () => {
    const claim = await won()
    await claim.release()
    expect(await stamp()).toBeNull()
  })

  it('a released cycle can be claimed again at once', async () => {
    await won()
    at(GAP + 1)
    const claim = await won()
    await claim.release()
    at(GAP + 2)
    await won()
  })

  it('a late release does not hand a later run’s cycle away', async () => {
    const first = await won()
    at(GAP + 1)
    await won()
    await first.release()
    expect(await stamp()).toBe(t0 + GAP + 1)
  })

  it('releasing twice is a no-op the second time', async () => {
    await won()
    at(GAP + 1)
    const claim = await won()
    await claim.release()
    at(GAP + 2)
    await won()
    await claim.release()
    expect(await stamp()).toBe(t0 + GAP + 2)
  })

  it('releasing a forced claim restores the stamp it overwrote', async () => {
    await won()
    at(HOUR)
    const forced = await won(GAP, { force: true })
    await forced.release()
    expect(await stamp()).toBe(t0)
  })
})
