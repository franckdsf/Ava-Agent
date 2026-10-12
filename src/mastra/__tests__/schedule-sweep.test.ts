import { Mastra } from '@mastra/core'
import { describe, expect, it } from 'vitest'
import { env } from '../../config/env.js'
import { NEWS } from '../pipelines.js'
import { storage } from '../storage.js'
import { curateAll } from '../workflows/curate-all.js'

// Slice 3 moved news from one schedule row per digest hour to the kit's single row. No migration
// removes the old rows: Mastra's declarative sync deletes any `wf_<workflow>__*` row the workflow
// no longer declares. That was read from 1.52.1's source, not observed, and the double replay it
// ends — two digest runs 146 ms apart on 2026-08-16 — is why it is pinned here rather than trusted.
// An upgrade that stops sweeping fails this, and the fallback is one schedule id per fire hour.
describe("Mastra's schedule sync", () => {
  it('collapses the per-hour digest rows into the one row NEWS declares', async () => {
    await storage.init()
    const schedules = await storage.getStore('schedules')
    if (!schedules) throw new Error('no schedules store')

    const now = Date.now()
    for (const hour of [10, 20]) {
      await schedules.createSchedule({
        id: `wf_${NEWS.workflowId}__digest-${hour}00`,
        target: { type: 'workflow', workflowId: NEWS.workflowId, inputData: {} },
        cron: `0 ${hour} * * *`,
        timezone: env.AGENT_TIMEZONE,
        status: 'active',
        nextFireAt: now + 3_600_000,
        createdAt: now,
        updatedAt: now,
      })
    }

    expect(await schedules.listSchedules({ workflowId: NEWS.workflowId })).toHaveLength(2)

    // `workers: false`: the sync is called by hand, and nothing may start polling.
    const mastra = new Mastra({ workflows: { curateAll }, storage, workers: false, logger: false })
    await mastra.registerDeclarativeSchedules(schedules)

    const rows = await schedules.listSchedules({ workflowId: NEWS.workflowId })
    expect(rows.map(row => ({ id: row.id, cron: row.cron, status: row.status }))).toEqual([
      { id: `wf_${NEWS.workflowId}__${NEWS.scheduleId}`, cron: NEWS.schedule[0].cron, status: 'active' },
    ])
  })
})
