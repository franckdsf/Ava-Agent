import { catchup } from '../config/catchup.js'
import { jobPipeline } from '../config/jobs.js'
import { leadPipeline } from '../config/leads.js'
import { definePipeline } from './pipeline-kit.js'

/**
 * Every pipeline built on the kit. The boot catch-up iterates this list, so a
 * pipeline defined here is caught up by being defined.
 *
 * News is not here yet — it moves next, and until then `boot-catchup.ts` still
 * lists it by hand.
 */

/**
 * Joob's job run ([ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)).
 * `jobs-daily` names the cadence, one run a day, not the number of fires.
 */
export const JOBS = definePipeline({
  id: 'jobs',
  workflowId: 'find-jobs',
  scheduleId: 'jobs-daily',
  runHours: jobPipeline.runHours,
  intervalHours: jobPipeline.intervalHours,
  staleAfterDays: catchup.jobsStaleAfterDays,
})

/** Joob's prospecting run ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)). */
export const LEADS = definePipeline({
  id: 'leads',
  workflowId: 'find-leads',
  scheduleId: 'leads-daily',
  runHours: leadPipeline.runHours,
  intervalHours: leadPipeline.intervalHours,
  staleAfterDays: catchup.leadsStaleAfterDays,
})

export const PIPELINES = [JOBS, LEADS]
