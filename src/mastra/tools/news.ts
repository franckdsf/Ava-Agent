import { createTool } from '@mastra/core/tools'
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { pipeline } from '../../config/pipeline.js'
import { verdictsForArticle } from '../../db/articles.js'
import { activeBeats } from '../../db/beats.js'
import { db, migrate } from '../../db/client.js'
import { articleBeats, articles, feedback } from '../../db/schema.js'
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

/**
 * A beat slug, as free text rather than an enum.
 *
 * It used to be `z.enum(CATEGORIES.map(c => c.slug))`, which validated the
 * model's guess and listed the options in the schema for free. Neither survives
 * beats being rows: the enum would be fixed at boot, so a beat created this
 * afternoon would be rejected by its own tools. An unknown slug now returns an
 * empty result, which is the same answer as a beat with nothing in it.
 *
 * What replaces the listed options is Newy's own instructions, which render the
 * live beat list every turn — so the model is told the valid slugs without this
 * schema having to be rebuilt.
 */
const beatInput = z
  .string()
  .optional()
  .describe('Restrict to one beat, by slug. Omit for all beats.')

/** Milliseconds, from a day count the model supplies. */
const since = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000

/**
 * One beat's opinion of an article.
 *
 * A list rather than a single score, because a story can sit on several beats
 * and be judged differently by each. This is also the near-miss reader: the
 * ranker writes a `reason` for everything it scores, so a verdict with a score
 * below the beat's threshold is the answer to "why didn't you send me that?".
 */
const verdictShape = z.object({
  beat: z.string(),
  score: z.number().nullable(),
  subtopic: z.string().nullable(),
  /** The ranker's own one-line rationale — written for rejects as well as sends. */
  reason: z.string().nullable(),
})

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
  /** The beat that actually sent it, or null when it was never delivered. */
  deliveredBeat: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  /**
   * Enough to answer *about* the article, not just name it. A headline alone
   * forces the model to either hedge or invent, and it was doing both.
   *
   * Still the excerpt rather than the body, but that is now a routing decision
   * instead of a ceiling: search matches on the full text and `read-article`
   * returns it for one article. Returning 15 bodies per search costs ~30k tokens
   * at the 8k cap and buries the one article the reader asked about in fourteen
   * others.
   */
  excerpt: z.string().nullable(),
  /** Every beat that scored it, best first. Usually one entry. */
  verdicts: z.array(verdictShape),
})

type ArticleRow = typeof articles.$inferSelect

/**
 * Attaches every beat's verdict to a batch of articles, in one extra query.
 *
 * Per-article lookups would be N+1 across a 15-result search, and the verdicts
 * are small — a slug, an integer and fifteen words.
 */
async function withVerdicts(rows: ArticleRow[]) {
  if (rows.length === 0) return []
  const links = await db()
    .select({
      articleId: articleBeats.articleId,
      beat: articleBeats.beatSlug,
      score: articleBeats.score,
      subtopic: articleBeats.subtopic,
      reason: articleBeats.reason,
    })
    .from(articleBeats)
    .where(inArray(articleBeats.articleId, rows.map(row => row.id)))
    .orderBy(desc(articleBeats.score))

  const byArticle = new Map<string, z.infer<typeof verdictShape>[]>()
  for (const link of links) {
    const existing = byArticle.get(link.articleId)
    const verdict = {
      beat: link.beat,
      score: link.score,
      subtopic: link.subtopic,
      reason: link.reason,
    }
    if (existing) existing.push(verdict)
    else byArticle.set(link.articleId, [verdict])
  }

  return rows.map(row => ({
    id: row.id,
    title: row.title,
    source: row.source,
    link: row.link,
    deliveredBeat: row.deliveredBeat,
    deliveredAt: row.deliveredAt ? new Date(row.deliveredAt).toISOString() : null,
    excerpt: row.excerpt,
    verdicts: byArticle.get(row.id) ?? [],
  }))
}

export const recentNews = createTool({
  id: 'recent-news',
  description:
    'List articles already delivered to the reader, newest first. Use for "what did you send me", ' +
    '"what happened this week", or any question about news the reader has already seen.',
  inputSchema: z.object({
    beat: beatInput,
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
  execute: async ({ beat, days, limit }) => {
    await migrate()
    // Filters on `deliveredBeat`, not on the link table: "what did you send me
    // on Design" is about which beat won the story, and a beat that scored it
    // and lost did not send it.
    const rows = await db()
      .select()
      .from(articles)
      .where(
        and(
          isNotNull(articles.deliveredAt),
          gte(articles.deliveredAt, since(days)),
          ...(beat ? [eq(articles.deliveredBeat, beat)] : []),
        ),
      )
      .orderBy(desc(articles.deliveredAt))
      .limit(limit)
    return { articles: await withVerdicts(rows) }
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

/** Article ids for one match expression, best first. */
async function rankedIds(match: string, beat: string | undefined, limit: number) {
  const weights = pipeline.searchColumnWeights
  // The beat filter is an EXISTS against the link table rather than a join: an
  // article on two beats would otherwise come back twice and eat the limit.
  const rows = await db().all<{ id: string }>(sql`
    select ${articles.id} as id
    from articles_fts
    join ${articles} on ${articles}.rowid = articles_fts.rowid
    where articles_fts match ${match}
    ${beat
      ? sql`and exists (
            select 1 from ${articleBeats}
            where ${articleBeats.articleId} = ${articles.id}
              and ${articleBeats.beatSlug} = ${beat}
          )`
      : sql``
    }
    order by bm25(articles_fts, ${weights.title}, ${weights.excerpt}, ${weights.content})
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
    beat: beatInput,
    limit: z.number().int().min(1).max(30).default(15),
  }),
  outputSchema: z.object({ articles: z.array(articleShape) }),
  execute: async ({ query, beat, limit }) => {
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
    const all = await rankedIds(terms.join(' AND '), beat, limit)
    const ranked = all.length > 0 ? all : await rankedIds(terms.join(' OR '), beat, limit)
    if (ranked.length === 0) return { articles: [] }

    const rows = await db().select().from(articles).where(inArray(articles.id, ranked))
    // `inArray` returns rows in storage order, so bm25's ranking is re-applied
    // from the id list rather than lost on the way back.
    const byId = new Map(rows.map(row => [row.id, row]))
    const ordered = ranked.flatMap(id => {
      const row = byId.get(id)
      return row ? [row] : []
    })
    return { articles: await withVerdicts(ordered) }
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
    const rows = await db().select().from(articles).where(eq(articles.id, id)).limit(1)
    const row = rows[0]
    if (!row) return { article: null }

    // Feed body when there is one, a live fetch when there isn't, and never
    // written back — the reasoning lives with `articleBody`, which the
    // translation commands share so the two surfaces cannot disagree about what
    // an article says.
    const [shaped] = await withVerdicts([row])
    const body = await articleBody(row)

    return {
      article: { ...shaped!, content: body.text, contentFrom: body.from },
    }
  },
})

export const newsStats = createTool({
  id: 'news-stats',
  description:
    'Counts of what is in the pipeline right now — linked, ranked, delivered, and pending — ' +
    'per beat. Use for "how much is queued", "is anything stuck", or status questions. Also the ' +
    'way to list the beats that exist and what they are called.',
  inputSchema: z.object({
    days: z.number().int().min(1).max(pipeline.retentionDays).default(7),
  }),
  outputSchema: z.object({
    days: z.number(),
    beats: z.array(
      z.object({
        slug: z.string(),
        title: z.string(),
        /** Articles attached to this beat in the window — not necessarily unique to it. */
        linked: z.number(),
        ranked: z.number(),
        /** Articles this beat actually won and sent. */
        delivered: z.number(),
      }),
    ),
  }),
  execute: async ({ days }) => {
    await migrate()
    const cutoff = since(days)
    const beats = await activeBeats()

    const stats = []
    for (const beat of beats) {
      const rows = await db()
        .select({
          rankedAt: articleBeats.rankedAt,
          deliveredBeat: articles.deliveredBeat,
        })
        .from(articleBeats)
        .innerJoin(articles, eq(articles.id, articleBeats.articleId))
        .where(and(eq(articleBeats.beatSlug, beat.slug), gte(articles.discoveredAt, cutoff)))
      stats.push({
        slug: beat.slug,
        title: beat.title,
        linked: rows.length,
        ranked: rows.filter(row => row.rankedAt !== null).length,
        // Delivered *by this beat*, so the numbers across beats sum to the
        // number of messages sent rather than double-counting a shared story.
        delivered: rows.filter(row => row.deliveredBeat === beat.slug).length,
      })
    }
    return { days, beats: stats }
  },
})

export const whyNotSent = createTool({
  id: 'why-not-sent',
  description:
    'Every beat\'s score and one-line reason for one article, including the beats that scored it ' +
    'and did not send it. Use when the reader asks why something was skipped, why a story went to ' +
    'one beat rather than another, or how an article was judged.',
  inputSchema: z.object({
    id: z.string().describe('The article id from a previous search or listing.'),
  }),
  outputSchema: z.object({
    verdicts: z.array(verdictShape),
  }),
  execute: async ({ id }) => {
    const verdicts = await verdictsForArticle(id)
    return {
      verdicts: verdicts.map(verdict => ({
        beat: verdict.beatSlug,
        score: verdict.score,
        subtopic: verdict.subtopic,
        reason: verdict.reason,
      })),
    }
  },
})

export const myFeedback = createTool({
  id: 'my-feedback',
  description:
    'The reader\'s own 👍/👎 votes, newest first. Use to answer "what have I liked", ' +
    '"what do I keep downvoting", or to explain why a beat looks the way it does.',
  inputSchema: z.object({
    beat: beatInput,
    vote: z.enum(['up', 'down']).optional().describe('Filter to one direction.'),
    limit: z.number().int().min(1).max(50).default(25),
  }),
  outputSchema: z.object({
    votes: z.array(
      z.object({
        title: z.string(),
        source: z.string(),
        vote: z.string(),
        beat: z.string(),
      }),
    ),
  }),
  execute: async ({ beat, vote, limit }) => {
    await migrate()
    // No join to `articles`: a vote carries its own title and source so it
    // survives the article being pruned. Votes outlive articles here by design.
    const rows = await db()
      .select({
        title: feedback.title,
        source: feedback.source,
        vote: feedback.vote,
        beat: feedback.beatSlug,
      })
      .from(feedback)
      .where(
        and(
          ...(beat ? [eq(feedback.beatSlug, beat)] : []),
          ...(vote ? [eq(feedback.vote, vote)] : []),
        ),
      )
      .orderBy(desc(feedback.createdAt))
      .limit(limit)
    return { votes: rows }
  },
})

export const newsTools = {
  recentNews,
  searchNews,
  readArticle,
  newsStats,
  whyNotSent,
  myFeedback,
}
