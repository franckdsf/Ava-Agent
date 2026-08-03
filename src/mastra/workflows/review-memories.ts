import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { memoryConfig } from '../../config/memory.js'
import {
  deleteExpiredShortTerm,
  memoriesForReview,
  promoteMemories,
} from '../../db/memories.js'
import { reviewMemories } from '../agents/memory.js'

/**
 * The weekly memory review: promote what turned out to be biography, delete the
 * rest once it is past the window.
 *
 * This is the other half of the two-tier design
 * ([ADR-0014](../../../docs/decisions/0014-two-tier-memory-for-ava.md)). Newy
 * writes a note the moment she hears something and is told to prefer "short"
 * when unsure, because a wrong "long" is permanent and a wrong "short" is
 * recoverable — *this job is what makes that true*. Without it, either short-term
 * notes accumulate forever or a blind sweep throws away the one that mattered.
 *
 * **Two steps, and the split is a safety property, not tidiness.** `decide`
 * calls the model; `apply` writes. A model call that throws or comes back
 * unparsable fails the run before `apply` executes, so the notes are still there
 * next week. Any design where one step both asks and deletes turns a bad model
 * response into data loss.
 *
 * A model on a schedule is a deliberate exception to
 * [invariant 2](../../../AGENTS.md#invariants), and a narrow one: the control
 * flow is fixed — read, one call, write — and the model chooses only *which rows*,
 * from a set it was handed, validated against that set on the way back. It never
 * decides whether to run, what to run next, or what a note says. See
 * [ADR-0015](../../../docs/decisions/0015-weekly-memory-review.md).
 */

const empty = z.object({})

const decided = z.object({
  /** Notes the reviewer judged worth keeping forever. */
  promote: z.array(z.object({ id: z.string(), fact: z.string(), reason: z.string() })),
  reviewed: z.number(),
})

const reviewed = decided.extend({
  promoted: z.number(),
  /** Facts deleted this run, kept in the result so a run is readable in Studio. */
  deleted: z.array(z.string()),
})

const decide = createStep({
  id: 'decide',
  inputSchema: empty,
  outputSchema: decided,
  execute: async ({ mastra }) => {
    const notes = await memoriesForReview()
    return {
      promote: await reviewMemories(mastra, notes),
      reviewed: notes.short.length,
    }
  },
})

const apply = createStep({
  id: 'apply',
  inputSchema: decided,
  outputSchema: reviewed,
  execute: async ({ inputData }) => {
    // Promote first, delete second. `deleteExpiredShortTerm` only ever matches
    // `tier = 'short'`, so anything promoted a moment ago is already out of
    // reach of the sweep — the ordering is what keeps a rescued note from being
    // deleted in the same run that saved it.
    const promoted = await promoteMemories(inputData.promote.map(entry => entry.id))
    const gone = await deleteExpiredShortTerm()
    return { ...inputData, promoted, deleted: gone.map(memory => memory.fact) }
  },
})

export const reviewMemoriesWorkflow = createWorkflow({
  id: 'review-memories',
  inputSchema: empty,
  outputSchema: reviewed,
  // One schedule. The review is global — it reasons over the whole set of notes
  // at once, which is the only way to spot a recent note that duplicates
  // something already lasting.
  schedule: {
    cron: `0 ${memoryConfig.reviewHour} * * ${memoryConfig.reviewWeekday}`,
    timezone: env.AGENT_TIMEZONE,
    inputData: {},
  },
})
  .then(decide)
  .then(apply)
  .commit()
