import { and, eq, lt } from 'drizzle-orm'
import { db, migrate } from './client.js'
import { pipelineCycles } from './schema.js'

/**
 * Whether a pipeline may start a run right now — asked and answered in one
 * write, so two runs cannot both be told yes.
 *
 * The old jobs gate read `job_runs` and, several awaits later, inserted into it.
 * Between those two statements the database still said the last run was
 * yesterday's, so two fires arriving together both passed. That is the same
 * shape as the delivery bug it sat above
 * ([ADR-0033](../../docs/decisions/0033-a-delivery-is-claimed-before-it-is-sent.md)),
 * and the window is widest at boot, where `migrate()` runs on the first query
 * and the replayed fires arrive milliseconds apart
 * ([ADR-0034](../../docs/decisions/0034-a-pipeline-claims-its-cycle.md)).
 */

export type CycleClaim =
  /** This run owns the cycle and must proceed. */
  | { claimed: true; release: () => Promise<void> }
  /** Another run owns it, or it is simply too soon. `lastStartedAt` is why. */
  | { claimed: false; lastStartedAt: number }

/**
 * Claims the next cycle for `id` if the last one started more than `minGapMs`
 * ago, returning whether this caller won it.
 *
 * Two statements, and the decision only ever comes out of a guarded one:
 *
 * - The `insert … onConflictDoNothing` is for the first run on a fresh volume,
 *   where there is no row to update. Of two runs racing an empty table exactly
 *   one insert lands; the loser falls through to the update, whose guard the
 *   winner has just made false, and is correctly turned away.
 * - The `update … where started_at < cutoff` is every run after that. SQLite
 *   serialises writers, so of two runs holding the same cutoff exactly one
 *   matches the row and the other matches nothing.
 *
 * `force` skips the guard but still stamps the row, because a hand-fired run
 * spends the cycle exactly as a scheduled one does — it fetches the same
 * sources and makes the same model calls. A forced run that left the marker
 * untouched would let the next scheduled fire run again minutes later, which is
 * the thing being prevented.
 *
 * **A winner gets a `release`, and it is only for a run that did nothing.** The
 * claim is deliberately written before any work, so a run that dies on its very
 * first statement still spends the cycle — and one did: on 2026-08-23 two fires
 * arrived in the same millisecond, the winner's `insert into job_runs` lost the
 * write lock with `SQLITE_BUSY`, and a run that had touched no source and made
 * no model call cost the pipeline the whole interval. Handing the cycle back
 * costs nothing there, because nothing was spent.
 *
 * It is *not* a general undo. Once a run has fetched a source or called a model
 * it has spent the cycle whatever happens next, and releasing would let the next
 * fire spend it again minutes later. Callers therefore release only inside the
 * window before their first side effect.
 */
export async function claimCycle(
  id: string,
  minGapMs: number,
  options: { force?: boolean } = {},
): Promise<CycleClaim> {
  await migrate()
  const now = Date.now()

  // Read before the write, purely so a release has something to restore. It is
  // *not* part of the decision — that still comes out of the guarded write
  // below, which is the whole point of this function. A value that goes stale
  // between here and there cannot be restored over anyone: `releaseCycle` only
  // matches a row still stamped `now`, and the only writer who could have moved
  // it in that window is one whose stamp makes our own guard fail.
  const previous = await lastCycleStart(id)

  if (options.force) {
    await db()
      .insert(pipelineCycles)
      .values({ id, startedAt: now })
      .onConflictDoUpdate({ target: pipelineCycles.id, set: { startedAt: now } })
    return { claimed: true, release: () => releaseCycle(id, now, previous) }
  }

  const inserted = await db()
    .insert(pipelineCycles)
    .values({ id, startedAt: now })
    .onConflictDoNothing()
    .returning({ id: pipelineCycles.id })
  if (inserted.length > 0) return { claimed: true, release: () => releaseCycle(id, now, null) }

  const claimed = await db()
    .update(pipelineCycles)
    .set({ startedAt: now })
    .where(and(eq(pipelineCycles.id, id), lt(pipelineCycles.startedAt, now - minGapMs)))
    .returning({ id: pipelineCycles.id })
  if (claimed.length > 0) return { claimed: true, release: () => releaseCycle(id, now, previous) }

  // Only for the message, and read again rather than reused from `previous`:
  // the number a turned-away run reports should be the winner's fresh stamp.
  // The decision was made above, by the write.
  return { claimed: false, lastStartedAt: (await lastCycleStart(id)) ?? now }
}

/**
 * When the cycle for `id` last started, or null on a fresh volume.
 *
 * Also the boot catch-up's answer to "when did this pipeline last run" for every
 * pipeline on the kit (audit F6): a released claim restores the previous stamp,
 * so a run that stopped before spending anything does not read as a run.
 */
export async function lastCycleStart(id: string): Promise<number | null> {
  await migrate()
  const [row] = await db()
    .select({ startedAt: pipelineCycles.startedAt })
    .from(pipelineCycles)
    .where(eq(pipelineCycles.id, id))
  return row?.startedAt ?? null
}

/**
 * Puts the marker back the way a claim found it, if the claim still stands.
 *
 * Guarded on `startedAt === stamp` — the value the claim wrote — which is what
 * makes this safe to call late and safe to call twice. A release that arrives
 * after some later run has claimed the cycle matches nothing and does nothing,
 * rather than handing that run's cycle away underneath it.
 *
 * `previous === null` means the claim created the row on a fresh volume, so the
 * way back is to delete it rather than to invent a timestamp: a row stamped with
 * some epoch-ish number would read as "ran long ago" and be indistinguishable
 * from a real one.
 */
async function releaseCycle(id: string, stamp: number, previous: number | null): Promise<void> {
  const still = and(eq(pipelineCycles.id, id), eq(pipelineCycles.startedAt, stamp))
  if (previous === null) {
    await db().delete(pipelineCycles).where(still)
    return
  }
  await db().update(pipelineCycles).set({ startedAt: previous }).where(still)
}

/** Hours since `lastStartedAt`, for the note a turned-away run reports. */
export function hoursSince(lastStartedAt: number, now = Date.now()): number {
  return (now - lastStartedAt) / 3_600_000
}
