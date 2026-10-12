import { catchup } from '../config/catchup.js'
import { jobPipeline } from '../config/jobs.js'
import { leadPipeline } from '../config/leads.js'
import { minDigestGapHours, pipeline } from '../config/pipeline.js'
import { definePipeline } from './pipeline-kit.js'

/**
 * Every scheduled pipeline, all built on the kit. The boot catch-up iterates
 * this list, so a pipeline defined here is caught up by being defined.
 */

/**
 * Newy's digest run. `digest` is one row whose cron carries every
 * `digestHours` fire; it replaced one row per hour (`digest-1000`,
 * `digest-2000`), which a boot replayed one each — two runs 146 ms apart on
 * 2026-08-16.
 *
 * **The gate is half the tightest digest gap, derived rather than set.** A
 * hand-written number would be a third knob tied to `digestHours` with nothing
 * enforcing the relationship: add an 08:00 digest and the tightest gap becomes
 * 2 hours, and a hardcoded 5 would silently swallow two digests a day. Half,
 * because the gate must never turn away a fire that is merely late — the runs
 * it exists to stop start milliseconds apart, so everything above a few seconds
 * is margin for a digest that fired behind schedule, and half spends it evenly
 * ([ADR-0034](../../docs/decisions/0034-a-pipeline-claims-its-cycle.md)).
 */
export const NEWS = definePipeline({
  id: 'news',
  workflowId: 'curate-all',
  scheduleId: 'digest',
  runHours: pipeline.digestHours,
  intervalHours: minDigestGapHours() / 2,
  staleAfterDays: catchup.newsStaleAfterDays,
})

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

export const PIPELINES = [NEWS, JOBS, LEADS]
