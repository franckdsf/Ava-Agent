import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { jobCommands } from '../../config/job-commands.js'
import { activeSearches, getSearch, saveSearch } from '../../db/job-searches.js'
import type { JobSearch } from '../../db/schema.js'

/**
 * Joob's hands on the searches themselves.
 *
 * **These write `job_searches` and nothing else**, which the restated
 * [invariant 8](../../AGENTS.md#invariants) permits: configuration a *future*
 * run reads. They cannot reach a fit score, a delivery, a `job_deliveries` row
 * or a run in progress, and nothing here starts a workflow.
 *
 * **Why a tool, when the beat commands deliberately are not.** AGENTS.md says
 * archiving a beat should happen because the reader typed `/pause design`, not
 * because a model inferred it from a sentence about being tired of design news —
 * and that reasoning still holds for *destructive* changes. Refining a target is
 * a different act: `/target` already answers with a full summary of what was
 * understood, and the natural next sentence is "actually, Paris only". Making
 * the reader re-type the whole search to change one field is the kind of
 * friction that stops them correcting a bad parse at all — and a bad parse is
 * the exact failure `mustHave` and `dealbreakers` make expensive.
 *
 * Two guards make that safe. **Nothing here creates or archives a search** —
 * `/target` and `/untarget` remain the only ways in and out, so a model cannot
 * invent a search or silently stop one. And every write returns the full row
 * back, so Joob's prompt can echo it and a wrong edit is visible in the same
 * turn it was made.
 *
 * **`list-targets` is also how Joob sees what a command said.** A slash command
 * answers through the transport and never reaches the agent's memory, so the
 * tighter target `/target` proposed was invisible to Joob — asked to "apply your
 * example", it had no example and invented a generic one. The proposal is parked
 * on the row it is about, which is the only place both halves can read it.
 */

const searchShape = z.object({
  slug: z.string(),
  label: z.string(),
  locations: z.array(z.string()),
  remote: z.string(),
  seniority: z.array(z.string()),
  contractTypes: z.array(z.string()),
  mustHave: z.array(z.string()),
  dealbreakers: z.array(z.string()),
  minCompensation: z.number().nullable(),
  currency: z.string().nullable(),
  notes: z.string().nullable(),
})

const suggestionShape = z.object({
  diagnosis: z.string(),
  command: z.string(),
  /** False when the line would not parse — then it can only be pasted, not applied. */
  applicable: z.boolean(),
})

const toSearchShape = (search: JobSearch) => ({
  slug: search.slug,
  label: search.label,
  locations: search.locations,
  remote: search.remote,
  seniority: search.seniority,
  contractTypes: search.contractTypes,
  mustHave: search.mustHave,
  dealbreakers: search.dealbreakers,
  minCompensation: search.minCompensation,
  currency: search.currency,
  notes: search.notes,
})

export const listTargets = createTool({
  id: 'list-targets',
  description:
    'The job searches currently running, with every filter on each. Use this before answering ' +
    'anything about what is being looked for, rather than remembering it from an earlier turn. ' +
    'A search flagged as too broad carries the tighter version that was suggested for it.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    searches: z.array(searchShape.extend({ suggestion: suggestionShape.optional() })),
  }),
  execute: async () => ({
    searches: (await activeSearches()).map(search => ({
      ...toSearchShape(search),
      ...(search.suggestion
        ? {
          suggestion: {
            diagnosis: search.suggestion.diagnosis,
            command: search.suggestion.command,
            applicable: search.suggestion.criteria !== null,
          },
        }
        : {}),
    })),
  }),
})

export const applySuggestion = createTool({
  id: 'apply-suggestion',
  description:
    'Replace a search with the tighter version that was suggested for it. Only when they ask for ' +
    'it — "apply your example", "yes, use that one". "list-targets" says which searches have one ' +
    'and whether it can be applied. Returns the search as it now stands.',
  inputSchema: z.object({
    slug: z.string().describe('Which search. "list-targets" gives the slugs.'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    search: searchShape.optional(),
  }),
  execute: async input => {
    const existing = await getSearch(input.slug)
    if (!existing) return { ok: false, error: `There is no search called "${input.slug}".` }
    if (!existing.suggestion) {
      return {
        ok: false,
        error:
          `Nothing was suggested for "${input.slug}". Do not invent one — a target is only ` +
          'changed by what they asked for.',
      }
    }
    if (!existing.suggestion.criteria) {
      return {
        ok: false,
        error:
          'That suggestion was never parsed into filters, so it can only be pasted. Show them ' +
          `the line and let them send it: ${existing.suggestion.command}`,
      }
    }

    // The slug is deliberately not among the fields written: it is how the reader
    // refers to this search and how every stored verdict points at it.
    const updated = { ...existing, ...existing.suggestion.criteria }
    await saveSearch(updated)
    return { ok: true, search: toSearchShape(updated) }
  },
})

export const updateTarget = createTool({
  id: 'update-target',
  description:
    'Change one or more filters on an existing job search. Only for when the reader has directly ' +
    'asked for the change — never inferred from a passing remark. Omit a field to leave it alone; ' +
    'pass an empty array to clear one. Returns the whole search back so you can show them what it ' +
    'looks like now. Cannot create a search or switch one off: those are /target and /untarget.',
  inputSchema: z.object({
    slug: z.string().describe('Which search to change. "list-targets" gives the slugs.'),
    locations: z.array(z.string()).optional().describe('Places, as a posting would name them. Empty clears it.'),
    remote: z
      .enum(['required', 'preferred', 'onsite', 'any'])
      .optional()
      .describe('"required" and "onsite" reject postings; "preferred" and "any" do not.'),
    seniority: z.array(z.string()).optional().describe('junior, mid, senior, staff, principal, lead.'),
    contractTypes: z.array(z.string()).optional(),
    mustHave: z
      .array(z.string())
      .optional()
      .describe(
        'A HARD filter: a posting never mentioning one of these is discarded before it is read. ' +
        'Keep it to two or three, and prefer notes for anything soft.',
      ),
    dealbreakers: z
      .array(z.string())
      .optional()
      .describe('Also a HARD filter: any posting mentioning one of these is discarded.'),
    minCompensation: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    notes: z
      .string()
      .nullable()
      .optional()
      .describe('Everything a filter cannot express. This shifts the score rather than rejecting.'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    search: searchShape.optional(),
  }),
  execute: async input => {
    if (!jobCommands.slugPattern.test(input.slug)) {
      return { ok: false, error: `"${input.slug}" is not a slug I could have made.` }
    }

    const existing = await getSearch(input.slug)
    if (!existing) {
      return { ok: false, error: `There is no search called "${input.slug}".` }
    }
    if (existing.archivedAt !== null) {
      return {
        ok: false,
        error: `"${input.slug}" is switched off. The reader brings it back with /target, not with an edit.`,
      }
    }

    // Field by field, so an omitted key means "leave it" and an explicit empty
    // array means "clear it" — a spread of the whole input would erase every
    // field the model did not happen to mention.
    const updated = {
      ...existing,
      locations: input.locations ?? existing.locations,
      remote: input.remote ?? existing.remote,
      seniority: input.seniority ?? existing.seniority,
      contractTypes: input.contractTypes ?? existing.contractTypes,
      mustHave: input.mustHave ?? existing.mustHave,
      dealbreakers: input.dealbreakers ?? existing.dealbreakers,
      minCompensation:
        input.minCompensation === undefined ? existing.minCompensation : input.minCompensation,
      currency: input.currency === undefined ? existing.currency : input.currency,
      notes: input.notes === undefined ? existing.notes : input.notes,
    }

    await saveSearch(updated)
    return {
      ok: true,
      search: {
        slug: updated.slug,
        label: updated.label,
        locations: updated.locations,
        remote: updated.remote,
        seniority: updated.seniority,
        contractTypes: updated.contractTypes,
        mustHave: updated.mustHave,
        dealbreakers: updated.dealbreakers,
        minCompensation: updated.minCompensation,
        currency: updated.currency,
        notes: updated.notes,
      },
    }
  },
})

export const targetTools = { listTargets, updateTarget, applySuggestion }
