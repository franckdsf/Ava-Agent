import { eq } from 'drizzle-orm'
import { db, migrate } from './client.js'
import { pipelineRuns } from './schema.js'

/**
 * The run log every pipeline writes — one row per run, keyed by pipeline
 * ([audit D2](../../docs/audit/04-BLUEPRINT.md#decisions)).
 *
 * `startRun` is the kit's, called inside its window before spending; a pipeline
 * only ever finishes the row it was handed. Nothing reads these rows back in
 * code: the gate and the boot catch-up read `pipeline_cycles`.
 */

export type RunCounters = {
  fetched?: number
  stored?: number
  considered?: number
  scored?: number
  delivered?: number
  /** The one-line reason a run did nothing, so quiet and broken look different. */
  note?: string | null
  /** What only this pipeline counts — `visionCalls` for leads, `linked` for news. */
  detail?: Record<string, number>
}

export async function startRun(pipeline: string): Promise<string> {
  await migrate()
  const id = crypto.randomUUID()
  await db().insert(pipelineRuns).values({ id, pipeline, startedAt: Date.now() })
  return id
}

export async function finishRun(id: string, counters: RunCounters): Promise<void> {
  await migrate()
  await db()
    .update(pipelineRuns)
    .set({ ...counters, finishedAt: Date.now() })
    .where(eq(pipelineRuns.id, id))
}
