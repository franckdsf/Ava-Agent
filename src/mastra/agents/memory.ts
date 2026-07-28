import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { memoryConfig } from '../../config/memory.js'
import { env } from '../../config/env.js'
import { memoriesForPrompt, type Memory } from '../../db/memories.js'

/**
 * The block of notes prepended to Agent's instructions on every turn.
 *
 * Rendered here rather than in `src/db/` for the same reason
 * `renderInterestProfile` sits in the workflow that consumes it: the shape of a
 * prompt belongs next to the prompt, and the repository stays a repository.
 */

/**
 * Today, in the reader's zone.
 *
 * The model has no clock, and every line below is dated — without today's date
 * "2026-07-12" is a string rather than "two weeks ago", and no amount of
 * instruction about recency makes a timeline legible. Day granularity, not
 * time-of-day, so the block is stable across a day's turns instead of changing
 * on every message.
 */
function today(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.AGENT_TIMEZONE }).format(now)
}

function render(entries: Memory[]): string {
  return entries.map(entry => `- ${entry.happenedOn} — ${entry.fact}`).join('\n')
}

/**
 * How to read the block. This travels *with* the notes rather than sitting in
 * the static prompt because it is meaningless without them, and because the
 * recency rule has to be right next to the dates it governs.
 */
const howToReadNotes = [
  'These are your own notes, written by you in earlier conversations. The reader has not just',
  'said any of this. Use them the way you would use something you remember: bring one up when it',
  'is relevant, never recite the list, and never tell them what is or is not in your notes unless',
  'they ask.',
  '',
  'Each line is dated with when the fact was true, oldest first. **A later line about the same',
  'thing supersedes an earlier one** — if one note says their hair is dark (2025-01) and a later',
  'one says it is blond (2026-01), their hair is blond now and was dark before. Say "used to" or',
  '"since" about the older one; never present it as current, and never treat the pair as a',
  'contradiction to raise with them.',
  '',
  'Lasting notes stay indefinitely. Recent notes are only kept for a month, so their absence means',
  'nothing was recorded — not that nothing happened.',
].join('\n')

/**
 * Agent's notes as a system message, or the empty state when she has none.
 *
 * Kept as a *second* system message rather than concatenated into the main
 * prompt so the long static half stays byte-identical between turns and remains
 * a cacheable prefix; only this block changes.
 *
 * Never throws. A failed read here would otherwise take down the whole
 * conversation over the part of it that is an enhancement — she answers without
 * her notes, which is how she behaved before this existed.
 */
export async function memoryInstructions(now = new Date()): Promise<string> {
  const day = today(now)

  let notes: { long: Memory[]; short: Memory[] }
  try {
    notes = await memoriesForPrompt(now.getTime())
  } catch {
    return [
      `Today is ${day}.`,
      'Your notes about the reader could not be read this turn. Do not say you have no notes ' +
      'and do not re-record what you may already know — answer without them.',
    ].join('\n\n')
  }

  const blocks = [`Today is ${day}.`, '# What you know about them', howToReadNotes]

  if (notes.long.length === 0 && notes.short.length === 0) {
    blocks.push(
      'You have no notes yet. The first thing they tell you about themselves is worth writing down.',
    )
    return blocks.join('\n\n')
  }

  if (notes.long.length > 0) {
    blocks.push('## Lasting', render(notes.long))
  }
  if (notes.short.length > 0) {
    blocks.push(`## Recent (last ${memoryConfig.shortTermDays} days)`, render(notes.short))
  }

  return blocks.join('\n\n')
}

/* ────────────────────────────── weekly review ─────────────────────────────── */

/**
 * The reviewer. Its whole job is a tier decision Ava could not have made at the
 * time: she writes a note the moment she hears it, with no idea whether it will
 * still matter in a month, and is told to prefer "short" when unsure. This runs
 * a month later, when the answer is obvious.
 *
 * It returns ids, never prose and never new facts. Nothing it says is written to
 * a note — the worst a bad run can do is move the wrong row between tiers, which
 * is recoverable; a run that could *rewrite* a fact would not be.
 *
 * See [ADR-0015](../../../docs/decisions/0015-weekly-memory-review.md).
 */
export const memoryReviewerId = 'memory-reviewer'

export const memoryReviewer = new Agent({
  id: memoryReviewerId,
  name: 'Memory Reviewer',
  model: env.AVA_MODEL_MEMORY_REVIEWER,
  instructions: {
    providerOptions: {
      openrouter: {
        reasoningEffort: 'max',
      }
    },
    role: 'system',
    content: `You maintain the long-term memory of an assistant that has one user.

You are given two lists of notes about that user. LASTING notes are already kept
forever — they are context only, and you cannot change them. RECENT notes were
recorded as short-lived; each was written the moment the user mentioned it,
before anyone could know whether it would still matter.

Return the ids of the RECENT notes that should become lasting.

**Everything you do not return is deleted permanently, after
${memoryConfig.shortTermDays} days.** The two mistakes are not equal. Keeping an
ordinary day costs one extra line in a list. Deleting a fact about who this
person is loses it for good, silently, and nobody finds out until the assistant
needed it and did not have it. When a note could go either way, keep it.

Keep a note when it is still true of the *person*, not of a day:
- who they are, and who is close to them: family, partner, friends by name
- where they live, their job or studies, their health, their background
- what they lastingly prefer, avoid, believe, or are committed to
- a change of state that persists: a move, a new role, a new relationship, a
  loss, a diagnosis, something they have taken up
- anything they asked to be remembered

Keep, for example: "They started a new job at Acme as a staff engineer", "Their
sister Claire lives in Lyon", "They are learning Japanese", "They bought a flat".

Let a note go when it described a moment and left nothing behind:
- meals, outings, errands, what they watched or read
- a task, mood, or plan tied to that one week
- a one-off event with no lasting consequence

Let go, for example: "They ate ramen at Kodawari", "They watched a film on
Saturday", "They spent the week chasing a flaky test".

**Never keep a duplicate.** If a LASTING note already carries the same fact in
any wording, let the recent one go — "They avoid peanuts because of an allergy"
adds nothing when a lasting note already says they are allergic to peanuts. This
is the one case where a borderline note is dropped rather than kept.

Judge each note on its own, not against a quota. Some weeks nothing qualifies and
an empty list is the honest answer; other weeks half the list is worth keeping.

What you return is the keep list and nothing else. A note you decide to let go is
simply absent from it — never list one together with a reason explaining why you
dropped it, because everything you return is kept regardless of what the reason
says. Each reason states, in at most 12 words, why that note is still true of the
person; if you cannot write that sentence, the note does not belong in the list.

Echo ids back exactly as given. Never invent an id, never return an id from the
LASTING list, and never rewrite the text of a note.
`.trim()
  },
})

/** What the reviewer returns: ids to keep, each with a short why. */
const reviewSchema = z.object({
  promote: z.array(
    z.object({
      id: z.string(),
      reason: z.string().describe('At most 12 words: why this is still true about the person.'),
    }),
  ),
})

export interface Promotion {
  id: string
  fact: string
  reason: string
}

function renderForReview(entries: Memory[]): string {
  return entries.map(entry => `- ${entry.id} | ${entry.happenedOn} | ${entry.fact}`).join('\n')
}

/**
 * Runs the review and returns only what survives validation.
 *
 * Two things are enforced here rather than trusted from the model. Ids are
 * filtered to the short-term set that was actually sent, so a hallucinated or
 * long-term id cannot reach the update — the same guard the ranker applies to
 * scores. And a response with no parsed object **throws**: the caller deletes
 * everything this function didn't promote, so "the model returned junk" and
 * "nothing was worth keeping" must never be the same value. Failing here leaves
 * the notes untouched until next week.
 */
export async function reviewMemories(
  mastra: Mastra,
  notes: { long: Memory[]; short: Memory[] },
): Promise<Promotion[]> {
  if (notes.short.length === 0) return []

  const agent = mastra.getAgent(memoryReviewerId)
  const response = await agent.generate(
    [
      `## LASTING notes — context only, ${notes.long.length} of them`,
      notes.long.length > 0 ? renderForReview(notes.long) : '(none yet)',
      '',
      `## RECENT notes to judge (${notes.short.length})`,
      'Format: id | date the fact was true | fact',
      renderForReview(notes.short),
    ].join('\n'),
    { structuredOutput: { schema: reviewSchema } },
  )

  if (!response.object) {
    throw new Error('Memory reviewer returned no parsable object; leaving notes untouched.')
  }

  const byId = new Map(notes.short.map(note => [note.id, note]))
  return response.object.promote.flatMap(({ id, reason }) => {
    const note = byId.get(id)
    return note ? [{ id, fact: note.fact, reason }] : []
  })
}
