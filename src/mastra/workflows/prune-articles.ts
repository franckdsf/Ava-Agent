import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { pipeline } from '../../config/pipeline.js'
import { deleteArticlesOlderThan } from '../../db/articles.js'

/**
 * Retention. One deterministic sweep a day that deletes articles older than
 * `pipeline.retentionDays` so the database stops growing without bound.
 *
 * Feeds are ingested six times a day and almost nothing is ever read after the
 * digest that carried it, so without this the `articles` table grows forever —
 * mostly article bodies, which are ~88% of a row's bytes (1754 of 1995,
 * measured over 288 articles on 2026-07-28).
 *
 * `articles`, and the `article_beats` rows that point at them. Nothing else.
 * The join rows are swept explicitly rather than by cascade: SQLite only
 * cascades a foreign key that was declared *and* enforced, and there is none
 * here — a beat is soft-deleted, so nothing in this schema wants referential
 * deletes. Miss them and every join quietly gets narrower over time.
 *
 * `feedback` is explicitly *not* pruned — a vote is the reader's own judgement
 * and it is kept forever, which is why the title and source it needs are stored
 * on the vote rather than joined from the article. `beats` and `beat_feeds` are
 * configuration and are never swept by age at all. `mastra_*` is Mastra's
 * ([invariant 4](../../../AGENTS.md#invariants)) and is live state, not spare
 * capacity: workflow snapshots resume suspended runs and `mastra_messages` is
 * the conversation history.
 *
 * No model is called here, which keeps [invariant 2](../../../AGENTS.md#invariants)
 * true: a scheduled job that let an LLM decide what to delete would eventually
 * delete the wrong thing.
 *
 * See [ADR-0012](../../../docs/decisions/0012-thirty-day-retention-on-items.md).
 */

const empty = z.object({})

const pruned = z.object({
  /** Epoch ms; anything discovered before this was deleted. */
  cutoff: z.number(),
  articles: z.number(),
  /**
   * `article_beats` rows that went with them. Reported separately because it is
   * the number that shows the join table is being swept at all — a bug leaving
   * links behind would still report articles deleted and look healthy.
   */
  links: z.number(),
})

const prune = createStep({
  id: 'prune',
  inputSchema: empty,
  outputSchema: pruned,
  execute: async () => {
    const cutoff = Date.now() - pipeline.retentionDays * 24 * 60 * 60 * 1000
    const deleted = await deleteArticlesOlderThan(cutoff, pipeline.pruneBatchSize)
    return { cutoff, ...deleted }
  },
})

export const pruneArticles = createWorkflow({
  id: 'prune-articles',
  inputSchema: empty,
  outputSchema: pruned,
  // A single schedule, so no `id` is needed — Mastra assigns a stable internal
  // one. Retention is global rather than per-beat: the cutoff is a date, and
  // running it once per beat would just make the second run find nothing.
  // C8: maintenance — retention: no gate, no claim, no catch-up; a missed day prunes the next.
  schedule: {
    cron: `0 ${pipeline.pruneHour} * * *`,
    timezone: env.AGENT_TIMEZONE,
    inputData: {},
  },
})
  .then(prune)
  .commit()
