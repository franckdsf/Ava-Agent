import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { memoryConfig } from '../../config/memory.js'
import { forgetMemory, rememberFact, searchMemories } from '../../db/memories.js'

/**
 * Ava's notes about the reader — the only tools on the conversational surface
 * that write.
 *
 * They write to `memories` and nothing else. The news tables stay read-only from
 * a conversation ([invariant 8](../../../AGENTS.md#invariants)), so no amount of
 * model improvisation mid-chat can re-send a digest, re-rank a beat or mark
 * something delivered. See
 * [ADR-0014](../../../docs/decisions/0014-two-tier-memory-for-ava.md).
 *
 * Everything Ava currently knows is already in her instructions, rebuilt each
 * turn — so `recall-memories` is not how she reads her notes. It is how she
 * reaches *past* the prompt caps, and how she gets the ids that `forget-memory`
 * needs, since the injected block deliberately carries no ids.
 */

const tier = z
  .enum(['short', 'long'])
  .describe(
    'long = true for years: their name, where they live, their job, family, a standing ' +
      'preference, an allergy. short = true for now: what they ate, where they went, what they ' +
      'are working on this week, how they are feeling. If unsure, choose short.',
  )

const memoryShape = z.object({
  /** The handle `forget-memory` takes. Never shown in the instructions block. */
  id: z.string(),
  fact: z.string(),
  tier: z.string(),
  happenedOn: z.string(),
  recordedOn: z.string(),
})

/**
 * `YYYY-MM-DD` at local noon.
 *
 * Noon rather than midnight because the stored instant is rendered back with
 * `toISOString()`: a date parsed as UTC midnight and read in a zone behind UTC
 * would come back as the previous day, which is a whole day of drift on exactly
 * the field the supersedes-by-recency reading depends on.
 */
function dayToEpoch(day: string | undefined): number | undefined {
  if (!day) return undefined
  const parsed = Date.parse(`${day}T12:00:00Z`)
  return Number.isNaN(parsed) ? undefined : parsed
}

export const remember = createTool({
  id: 'remember',
  description:
    'Write down one fact about the reader so it survives this conversation. Call it as soon as ' +
    'they reveal something about themselves — you do not need permission, and you should not ' +
    'wait to be asked. One fact per call; call it more than once when a message carries several. ' +
    'Do not record news content, anything you could look up with your other tools, or anything ' +
    'already listed in what you know about them.',
  inputSchema: z.object({
    fact: z
      .string()
      .min(3)
      .max(memoryConfig.factMaxChars)
      .describe(
        'The fact in one self-contained sentence, written in the third person about the reader ' +
          '("They are allergic to peanuts"), not addressed to them and not quoting them. It will ' +
          'be read months from now with none of this conversation around it, so resolve every ' +
          'pronoun and relative date ("their sister Claire", not "her"; "the Lisbon trip", not ' +
          '"the trip"). Write it in English whatever language the conversation is in.',
      ),
    tier,
    happenedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'YYYY-MM-DD, when the fact was actually true — only when they date it themselves ' +
          '("I ate there on Saturday"). Omit for anything true right now; it defaults to today.',
      ),
  }),
  outputSchema: z.object({
    memory: memoryShape,
    stored: z
      .boolean()
      .describe('False when this exact fact was already on record; nothing was changed.'),
  }),
  execute: async ({ fact, tier, happenedOn }) =>
    rememberFact({ fact, tier, happenedAt: dayToEpoch(happenedOn) }),
})

export const recallMemories = createTool({
  id: 'recall-memories',
  description:
    'Search your notes about the reader. Everything current is already in your instructions, so ' +
    'use this only to reach further back than what is listed there — an older short-term note ' +
    'that has dropped out — or to get the id of a note you need to forget.',
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe('Words to look for. Every word must appear in the note. Omit to list everything.'),
    tier: z.enum(['short', 'long']).optional().describe('Restrict to one tier. Omit for both.'),
    limit: z.number().int().min(1).max(memoryConfig.recallLimit).default(10),
  }),
  outputSchema: z.object({ memories: z.array(memoryShape) }),
  execute: async ({ query, tier, limit }) => ({
    memories: await searchMemories({ query, tier, limit }),
  }),
})

export const forget = createTool({
  id: 'forget-memory',
  description:
    'Delete one note, by the id from "recall-memories". Only for a fact that was never true or ' +
    'that they ask you to erase. A fact that has merely *changed* is not forgotten — record the ' +
    'new one with "remember" instead, so the change itself stays visible.',
  inputSchema: z.object({
    id: z.string().describe('The note id from "recall-memories". Do not guess one.'),
  }),
  outputSchema: z.object({
    forgotten: memoryShape.nullable().describe('Null when no note has that id — nothing was deleted.'),
  }),
  execute: async ({ id }) => ({ forgotten: await forgetMemory(id) }),
})

export const memoryTools = { remember, recallMemories, forget }
