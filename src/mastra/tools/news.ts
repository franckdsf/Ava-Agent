import { createTool } from '@mastra/core/tools'
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { CATEGORIES } from '../../config/categories.js'
import { pipeline } from '../../config/pipeline.js'
import { db, migrate } from '../../db/client.js'
import { feedback, items } from '../../db/schema.js'
import { articleBody } from '../../services/article.js'

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
 *
 * Listing and reading are separate on purpose. `search-news` matches on the full
 * article text but returns excerpts, and `read-article` returns one body in
 * full — so a question that needs what an article *says* is two cheap calls
 * rather than one that drags fifteen 8k bodies into context.
 */

const categorySlugs = CATEGORIES.map(category => category.slug)

const categoryInput = z
  .enum(categorySlugs as [string, ...string[]])
  .optional()
  .describe(`Restrict to one beat. One of: ${categorySlugs.join(', ')}. Omit for all.`)

/** Milliseconds, from a day count the model supplies. */
const since = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000

const articleShape = z.object({
  /**
   * The handle for `read-article`. Every list tool returns it so a result the
   * model wants to say more about can be opened, rather than guessed at from
   * the excerpt.
   */
  id: z.string(),
  title: z.string(),
  source: z.string(),
  link: z.string(),
  category: z.string(),
  subtopic: z.string().nullable(),
  score: z.number().nullable(),
  deliveredAt: z.string().nullable(),
  /**
   * Enough to answer *about* the article, not just name it. A headline alone
   * forces the model to either hedge or invent, and it was doing both.
   *
   * Still the excerpt rather than the body, but that is now a routing decision
   * instead of a ceiling: search matches on the full text and `read-article`
   * returns it for one item. Returning 15 bodies per search costs ~30k tokens
   * at the 8k cap and buries the one article the reader asked about in fourteen
   * others.
   */
  excerpt: z.string().nullable(),
  /** The ranker's own one-line rationale for the score. */
  reason: z.string().nullable(),
})

export const recentNews = createTool({
  id: 'recent-news',
  description:
    'List articles already delivered to the reader, newest first. Use for "what did you send me", ' +
    '"what happened this week", or any question about news the reader has already seen.',
  inputSchema: z.object({
    category: categoryInput,
    days: z
      .number()
      .int()
      .min(1)
      .max(pipeline.retentionDays)
      .default(7)
      .describe(
        `How far back to look. Nothing is kept beyond ${pipeline.retentionDays} days, so that ` +
          'is the whole history — an empty result at the maximum means it was never delivered ' +
          'or has since been pruned, not that the search was too narrow.',
      ),
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

/**
 * Splits a reader's phrase into quoted FTS5 terms.
 *
 * The quoting is not cosmetic: punctuation is *match syntax* in FTS5, so a bare
 * `fine-tune` parses as a column filter and fails with "no such column: tune".
 * Splitting on non-alphanumerics and quoting each term makes every one literal,
 * and leaves nothing a reader could type that reaches the query parser.
 *
 * Empty when the phrase has no word characters at all ("!!!"), which the caller
 * must treat as "no results" — an empty match string is a syntax error.
 */
function searchTerms(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(term => `"${term}"`)
}

/** Item ids for one match expression, best first. */
async function rankedIds(match: string, category: string | undefined, limit: number) {
  const weights = pipeline.searchColumnWeights
  const rows = await db().all<{ id: string }>(sql`
    select ${items.id} as id
    from items_fts
    join ${items} on ${items}.rowid = items_fts.rowid
    where items_fts match ${match}
    ${category ? sql`and ${items.categorySlug} = ${category}` : sql``}
    order by bm25(items_fts, ${weights.title}, ${weights.excerpt}, ${weights.content})
    limit ${limit}
  `)
  return rows.map(row => row.id)
}

export const searchNews = createTool({
  id: 'search-news',
  description:
    'Search stored articles by keyword across titles, excerpts and article bodies, whether or not ' +
    'they were ever delivered. Use when the reader asks about a specific topic, company, or ' +
    'technology. Word order does not matter and word endings are stemmed, so plain phrasing from ' +
    'the question works better than guessing at exact headline wording.',
  inputSchema: z.object({
    query: z.string().min(2).describe('Words to look for. Case, order and punctuation are ignored.'),
    category: categoryInput,
    limit: z.number().int().min(1).max(30).default(15),
  }),
  outputSchema: z.object({ articles: z.array(articleShape) }),
  execute: async ({ query, category, limit }) => {
    await migrate()
    const terms = searchTerms(query)
    if (terms.length === 0) return { articles: [] }

    // Precision first, then recall. Requiring every term is the better answer
    // when it lands, but a single term the reader guessed wrong ("RLHF cheap
    // fine-tune") makes it return nothing — and nothing reads as an empty
    // database rather than a near miss. Falling back to *any* term lets bm25
    // sort it out, since a rare term like "500" outweighs a common one like
    // "model". Both empty still means both empty, so "I have nothing on that"
    // stays a real answer.
    const all = await rankedIds(terms.join(' AND '), category, limit)
    const ranked = all.length > 0 ? all : await rankedIds(terms.join(' OR '), category, limit)
    if (ranked.length === 0) return { articles: [] }

    const rows = await db().select().from(items).where(inArray(items.id, ranked))
    // `inArray` returns rows in storage order, so bm25's ranking is re-applied
    // from the id list rather than lost on the way back.
    const byId = new Map(rows.map(row => [row.id, row]))
    return {
      articles: ranked.flatMap(id => {
        const row = byId.get(id)
        return row ? [toArticle(row)] : []
      }),
    }
  },
})

export const readArticle = createTool({
  id: 'read-article',
  description:
    'The full text of one stored article, by the id returned from "search-news" or "recent-news". ' +
    'Use it whenever answering needs what the article actually says — details, numbers, names, ' +
    'quotes — rather than what it is about. Search first to find the id; do not guess one.',
  inputSchema: z.object({
    id: z.string().describe('The article id from a previous search or listing.'),
  }),
  outputSchema: z.object({
    article: articleShape
      .extend({
        /** Plain text, capped at `articleMaxChars`. Null when there is no body to be had. */
        content: z.string().nullable(),
        /**
         * Where the body came from, so the model can tell "the article says X"
         * from "the feed gave us nothing".
         */
        contentFrom: z.enum(['feed', 'fetched']).nullable(),
      })
      .nullable()
      .describe('Null when no article has that id.'),
  }),
  execute: async ({ id }) => {
    await migrate()
    const rows = await db().select().from(items).where(eq(items.id, id)).limit(1)
    const row = rows[0]
    if (!row) return { article: null }

    // Feed body when there is one, a live fetch when there isn't, and never
    // written back — the reasoning lives with `articleBody`, which the
    // translation commands share so the two surfaces cannot disagree about what
    // an article says.
    const body = await articleBody(row)

    return {
      article: { ...toArticle(row), content: body.text, contentFrom: body.from },
    }
  },
})

export const newsStats = createTool({
  id: 'news-stats',
  description:
    'Counts of what is in the pipeline right now — ingested, ranked, delivered, and pending — ' +
    'per beat. Use for "how much is queued", "is anything stuck", or status questions.',
  inputSchema: z.object({
    days: z.number().int().min(1).max(pipeline.retentionDays).default(7),
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
    // No join to `items`: a vote carries its own title and source so it survives
    // the article being pruned. Votes outlive articles here by design.
    const rows = await db()
      .select({
        title: feedback.title,
        source: feedback.source,
        vote: feedback.vote,
        category: feedback.categorySlug,
      })
      .from(feedback)
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
    id: row.id,
    title: row.title,
    source: row.source,
    link: row.link,
    category: row.categorySlug,
    subtopic: row.subtopic,
    score: row.score,
    deliveredAt: row.deliveredAt ? new Date(row.deliveredAt).toISOString() : null,
    excerpt: row.excerpt,
    reason: row.reason,
  }
}

export const newsTools = { recentNews, searchNews, readArticle, newsStats, myFeedback }
