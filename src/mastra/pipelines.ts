import { catchup } from '../config/catchup.js'
import { leadPipeline } from '../config/leads.js'
import { definePipeline } from './pipeline-kit.js'

/**
 * Every pipeline built on the kit. The boot catch-up iterates this list, so a
 * pipeline defined here is caught up by being defined.
 *
 * News and jobs are not here yet — they move in the next slice, and until then
 * `boot-catchup.ts` still lists them by hand.
 */

/** Joob's prospecting run ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)). */
export const LEADS = definePipeline({
  id: 'leads',
  workflowId: 'find-leads',
  scheduleId: 'leads-daily',
  runHours: leadPipeline.runHours,
  intervalHours: leadPipeline.intervalHours,
  staleAfterDays: catchup.leadsStaleAfterDays,
})

export const PIPELINES = [LEADS]
