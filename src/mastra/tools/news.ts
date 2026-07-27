import { createTool } from '@mastra/core/tools'
import { and, desc, eq, gte, isNotNull, like, or } from 'drizzle-orm'
import { z } from 'zod'
import { CATEGORIES } from '../../config/categories.js'
import { db, migrate } from '../../db/client.js'
import { feedback, items } from '../../db/schema.js'

/**
 * Read-only windows onto the news tables, for the conversational agent.
 *
 * Read-only is the whole design. The pipeline is deterministic on a schedule
 * ([invariant 2](../../../AGENTS.md#invariants)) and stays that way: nothing
 * here writes, triggers a run, or marks anything delivered. An agent that could
 * re-send a digest would eventually re-send a digest.
 *
 * Every tool caps its own result set. The model pays for what these return, and
 * "what did I get this week" against a table that grows forever is a bill, not
 * a feature.
 */

const categorySlugs = CATEGORIES.map(category => category.slug)

const categoryInput = z
  .enum(categorySlugs as [string, ...string[]])
  .optional()
  .describe(`Restrict to one beat. One of: ${categorySlugs.join(', ')}. Omit for all.`)

/** Milliseconds, from a day count the model supplies. */
const since = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000

const articleShape = z.object({
  title: z.string(),
  source: z.string(),
  link: z.string(),
  category: z.string(),
  subtopic: z.string().nullable(),
  score: z.number().nullable(),
  deliveredAt: z.string().nullable(),
})

export const recentNews = createTool({
  id: 'recent-news',
  description:
    'List articles already delivered to the reader, newest first. Use for "what did you send me", ' +
    '"what happened this week", or any question about news the reader has already seen.',
  inputSchema: z.object({
    category: categoryInput,
    days: z.number().int().min(1).max(90).default(7).describe('How far back to look.'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({ articles: z.array(articleShape) }),
  execute: async ({ category, days, limit }) => {
    await migrate()
    const rows = await db()
      .select()
      .from(items)
      .where(
        and(
          isNotNull(items.deliveredAt),
          gte(items.deliveredAt, since(days)),
          ...(category ? [eq(items.categorySlug, category)] : []),
        ),
      )
      .orderBy(desc(items.deliveredAt))
      .limit(limit)
    return { articles: rows.map(toArticle) }
  },
})

export const searchNews = createTool({
  id: 'search-news',
  description:
    'Search stored articles by keyword across titles and excerpts, whether or not they were ever ' +
    'delivered. Use when the reader asks about a specific topic, company, or technology.',
  inputSchema: z.object({
    query: z.string().min(2).describe('Keyword or phrase. Matched case-insensitively.'),
    category: categoryInput,
    limit: z.number().int().min(1).max(30).default(15),
  }),
  outputSchema: z.object({ articles: z.array(articleShape) }),
  execute: async ({ query, category, limit }) => {
    await migrate()
    // libSQL's LIKE is case-insensitive for ASCII by default. `%` and `_` in the
    // query are escaped so a search for "C_" doesn't silently match everything.
    const pattern = `%${query.replace(/[%_\\]/g, '\\$&')}%`
    const rows = await db()
      .select()
      .from(items)
      .where(
        and(
          or(like(items.title, pattern), like(items.excerpt, pattern)),
          ...(category ? [eq(items.categorySlug, category)] : []),
        ),
      )
      .orderBy(desc(items.discoveredAt))
      .limit(limit)
    return { articles: rows.map(toArticle) }
  },
})

export const newsStats = createTool({
  id: 'news-stats',
  description:
    'Counts of what is in the pipeline right now — ingested, ranked, delivered, and pending — ' +
    'per beat. Use for "how much is queued", "is anything stuck", or status questions.',
  inputSchema: z.object({
    days: z.number().int().min(1).max(90).default(7),
  }),
  outputSchema: z.object({
    days: z.number(),
    beats: z.array(
      z.object({
        category: z.string(),
        ingested: z.number(),
        ranked: z.number(),
        delivered: z.number(),
      }),
    ),
  }),
  execute: async ({ days }) => {
    await migrate()
    const cutoff = since(days)
    const beats = []
    for (const category of CATEGORIES) {
      const rows = await db()
        .select({
          rankedAt: items.rankedAt,
          deliveredAt: items.deliveredAt,
        })
        .from(items)
        .where(and(eq(items.categorySlug, category.slug), gte(items.discoveredAt, cutoff)))
      beats.push({
        category: category.slug,
        ingested: rows.length,
        ranked: rows.filter(row => row.rankedAt !== null).length,
        delivered: rows.filter(row => row.deliveredAt !== null).length,
      })
    }
    return { days, beats }
  },
})

export const myFeedback = createTool({
  id: 'my-feedback',
  description:
    'The reader\'s own 👍/👎 votes, newest first. Use to answer "what have I liked", ' +
    '"what do I keep downvoting", or to explain why a beat looks the way it does.',
  inputSchema: z.object({
    category: categoryInput,
    vote: z.enum(['up', 'down']).optional().describe('Filter to one direction.'),
    limit: z.number().int().min(1).max(50).default(25),
  }),
  outputSchema: z.object({
    votes: z.array(
      z.object({
        title: z.string(),
        source: z.string(),
        vote: z.string(),
        category: z.string(),
      }),
    ),
  }),
  execute: async ({ category, vote, limit }) => {
    await migrate()
    const rows = await db()
      .select({
        title: items.title,
        source: items.source,
        vote: feedback.vote,
        category: feedback.categorySlug,
      })
      .from(feedback)
      .innerJoin(items, eq(items.id, feedback.itemId))
      .where(
        and(
          ...(category ? [eq(feedback.categorySlug, category)] : []),
          ...(vote ? [eq(feedback.vote, vote)] : []),
        ),
      )
      .orderBy(desc(feedback.createdAt))
      .limit(limit)
    return { votes: rows }
  },
})

function toArticle(row: typeof items.$inferSelect) {
  return {
    title: row.title,
    source: row.source,
    link: row.link,
    category: row.categorySlug,
    subtopic: row.subtopic,
    score: row.score,
    deliveredAt: row.deliveredAt ? new Date(row.deliveredAt).toISOString() : null,
  }
}

export const newsTools = { recentNews, searchNews, newsStats, myFeedback }
