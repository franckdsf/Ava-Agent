/**
 * Stored article bodies, for the two tasks a reader waits on.
 *
 * Real bodies because a synthetic article has none of what breaks these calls —
 * extraction debris, code blocks, a feed's own markup. Between 3,000 and 8,000
 * characters, as the old `models:check` used before the bench: long enough that a
 * summary has something to choose from, short enough to be one stored article
 * rather than a truncated one.
 */
import { and, desc, isNotNull, sql } from 'drizzle-orm'
import { bench } from '../../../src/config/bench.js'
import { db } from '../../../src/db/client.js'
import { articles } from '../../../src/db/schema.js'
import { capText } from '../../../src/services/article.js'

export interface ArticleBody {
  title: string
  source: string
  text: string
}

export async function readArticleBodies(count: number, maxChars: number): Promise<ArticleBody[]> {
  const rows = await db()
    .select({ title: articles.title, source: articles.source, content: articles.content })
    .from(articles)
    .where(
      and(
        isNotNull(articles.content),
        sql`length(${articles.content}) between ${bench.readerBodyChars.min} and ${bench.readerBodyChars.max}`,
      ),
    )
    .orderBy(desc(articles.discoveredAt))

  // The most recent from each source, so two fixtures are not two posts from
  // the one blog that publishes most — a model good at one house style has
  // not shown much.
  const seen = new Set<string>()
  return rows
    .filter(row => !seen.has(row.source) && seen.add(row.source))
    .slice(0, count)
    .map(row => ({ title: row.title, source: row.source, text: capText(row.content ?? '', maxChars) }))
}

export const words = (text: string): number => text.split(/\s+/).filter(Boolean).length
