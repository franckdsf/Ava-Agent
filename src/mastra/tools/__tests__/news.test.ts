import { beforeAll, describe, expect, it } from 'vitest'

import { db, migrate } from '../../../db/client.js'
import { articleBeats, articles, beats, feedback } from '../../../db/schema.js'
import { myFeedback, newsStats, readArticle, recentNews, searchNews } from '../news.js'

/**
 * What Newy's news tools answer, on a seeded database.
 *
 * Written before the reads moved into `src/db/` (slice 7), against the code as it was, so the move
 * is held to the same answers: the window and beat filters, the full-text search with its
 * AND-then-OR fallback and bm25 order, the per-beat counts, the reader's votes.
 */

const DAY = 86_400_000
const now = Date.now()
const ago = (days: number) => now - days * DAY

/** Tools are called the way the agent calls them; the context is unused by these. */
const call = <T>(tool: { execute?: (input: never, context: never) => Promise<unknown> }, input: unknown) =>
  tool.execute!(input as never, {} as never) as Promise<T>

type Listed = { articles: { id: string; deliveredBeat: string | null; verdicts: { beat: string; score: number | null }[] }[] }
const ids = (result: Listed) => result.articles.map(article => article.id)

beforeAll(async () => {
  await migrate()
  await db()
    .insert(beats)
    .values(
      ['ai', 'design'].map(slug => ({
        slug,
        title: slug === 'ai' ? 'AI' : 'Design',
        emoji: '📌',
        rubric: '-',
        subtopics: ['general'],
        createdAt: ago(60),
      })),
    )

  const article = (id: string, title: string, fields: Partial<typeof articles.$inferInsert>) => ({
    id,
    feedUrl: 'https://example.com/feed',
    source: 'Example',
    title,
    link: `https://example.com/${id}`,
    discoveredAt: ago(1),
    ...fields,
  })
  await db()
    .insert(articles)
    .values([
      article('a1', 'Open model fine-tune costs drop', {
        excerpt: 'Cheaper RLHF.',
        content: 'The full body about the fine-tune costs.',
        deliveredAt: ago(1),
        deliveredBeat: 'ai',
      }),
      article('a2', 'Design systems at scale', { deliveredAt: ago(2), deliveredBeat: 'design' }),
      article('a3', 'An old AI story', { discoveredAt: ago(20), deliveredAt: ago(20), deliveredBeat: 'ai' }),
      article('a4', 'Rust compiler release', { excerpt: 'A new Rust.' }),
      article('a5', 'GPU prices', { content: 'Why a fine-tune got cheaper this quarter.' }),
      article('a6', 'Weekly links', { content: 'Includes one item about rust.' }),
    ])

  const verdict = (articleId: string, beatSlug: string, score: number | null) => ({
    articleId,
    beatSlug,
    score,
    subtopic: score === null ? null : 'general',
    reason: score === null ? null : `${beatSlug} gave ${score}`,
    rankedAt: score === null ? null : ago(1),
  })
  await db()
    .insert(articleBeats)
    .values([
      verdict('a1', 'ai', 85),
      verdict('a1', 'design', 30),
      verdict('a2', 'design', 90),
      verdict('a3', 'ai', 80),
      verdict('a4', 'ai', 40),
      verdict('a4', 'design', 55),
      verdict('a5', 'ai', null),
      verdict('a6', 'ai', null),
    ])

  await db()
    .insert(feedback)
    .values([
      { articleId: 'a1', beatSlug: 'ai', title: 'Open model fine-tune costs drop', source: 'Example', vote: 'up', createdAt: ago(1) },
      { articleId: 'a2', beatSlug: 'design', title: 'Design systems at scale', source: 'Example', vote: 'down', createdAt: ago(0.5) },
    ])
})

describe('recent-news', () => {
  it('lists what was delivered inside the window, newest first, each with every beat’s verdict', async () => {
    const result = await call<Listed>(recentNews, { days: 7, limit: 20 })
    expect(ids(result)).toEqual(['a1', 'a2'])
    expect(result.articles[0]!.verdicts).toEqual([
      expect.objectContaining({ beat: 'ai', score: 85 }),
      expect.objectContaining({ beat: 'design', score: 30 }),
    ])
  })

  it('filters on the beat that sent it, not on every beat that scored it', async () => {
    expect(ids(await call<Listed>(recentNews, { beat: 'design', days: 7, limit: 20 }))).toEqual(['a2'])
  })
})

describe('search-news', () => {
  it('requires every term when that finds something', async () => {
    expect(ids(await call<Listed>(searchNews, { query: 'fine-tune costs', limit: 15 }))).toEqual(['a1'])
  })

  it('falls back to any term when requiring all finds nothing', async () => {
    const found = ids(await call<Listed>(searchNews, { query: 'fine-tune zzyzx', limit: 15 }))
    expect(found.sort()).toEqual(['a1', 'a5'])
  })

  it('keeps bm25’s order — a title match ahead of a body match', async () => {
    expect(ids(await call<Listed>(searchNews, { query: 'rust', limit: 15 }))).toEqual(['a4', 'a6'])
  })

  it('returns an article on two beats once, and filters by beat', async () => {
    expect(ids(await call<Listed>(searchNews, { query: 'rust', beat: 'design', limit: 15 }))).toEqual(['a4'])
    expect(ids(await call<Listed>(searchNews, { query: 'fine-tune', beat: 'design', limit: 15 }))).toEqual(['a1'])
  })

  it('answers nothing for a phrase with no words, rather than an FTS5 syntax error', async () => {
    expect(ids(await call<Listed>(searchNews, { query: '!!!', limit: 15 }))).toEqual([])
  })
})

describe('read-article', () => {
  it('returns the stored body and says where it came from', async () => {
    const { article } = await call<{ article: { id: string; content: string; contentFrom: string } }>(readArticle, {
      id: 'a1',
    })
    expect(article).toMatchObject({ id: 'a1', content: 'The full body about the fine-tune costs.', contentFrom: 'feed' })
  })

  it('returns null for an id that does not exist', async () => {
    expect(await call(readArticle, { id: 'nope' })).toEqual({ article: null })
  })
})

describe('news-stats', () => {
  it('counts linked, ranked and delivered-by-this-beat inside the window', async () => {
    const { beats: stats } = await call<{ beats: { slug: string }[] }>(newsStats, { days: 7 })
    expect(stats).toEqual([
      { slug: 'ai', title: 'AI', linked: 4, ranked: 2, delivered: 1 },
      { slug: 'design', title: 'Design', linked: 3, ranked: 3, delivered: 1 },
    ])
  })
})

describe('my-feedback', () => {
  it('lists votes newest first, filtered by beat or direction', async () => {
    const all = await call<{ votes: { title: string; vote: string }[] }>(myFeedback, { limit: 25 })
    expect(all.votes.map(vote => vote.vote)).toEqual(['down', 'up'])
    expect((await call<typeof all>(myFeedback, { vote: 'up', limit: 25 })).votes).toEqual([
      { title: 'Open model fine-tune costs drop', source: 'Example', vote: 'up', beat: 'ai' },
    ])
    expect((await call<typeof all>(myFeedback, { beat: 'design', limit: 25 })).votes.map(v => v.vote)).toEqual(['down'])
  })
})
