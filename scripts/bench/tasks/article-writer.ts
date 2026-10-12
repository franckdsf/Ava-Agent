/**
 * `pnpm bench article-writer` — `AVA_MODEL_RSS_SUMMARIZER`, through
 * `writeArticleSummary`.
 *
 * A fixture is four articles that were actually delivered, each with its stored
 * body, the beat that won it and the ranker's reason — exactly what the deliver
 * step hands the writer. One run writes all four, one call each, as production
 * does.
 *
 * **Stored bodies only.** Production fetches the page when the feed carried no
 * body; a bench that fetched would compare models on whatever the site served
 * that minute. Articles without a stored body are skipped instead.
 *
 * A failed article is not a failed run: production degrades it to the excerpt
 * and sends the rest, so here it is a flag on a run that still counts. The run
 * fails only when every article did.
 */
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { bench } from '../../../src/config/bench.js'
import { db } from '../../../src/db/client.js'
import type { Beat } from '../../../src/db/beats.js'
import { articleBeats, articles, beats } from '../../../src/db/schema.js'
import type { Article } from '../../../src/db/types.js'
import {
  articleWriterId,
  curatorAgents,
  renderArticleForWriter,
  writeArticleSummary,
  type ArticleSummary,
} from '../../../src/mastra/agents/curator.js'
import type { BenchTask } from '../kit.js'

interface Story {
  id: string
  beat: string
  title: string
  source: string
  reason: string | null
  body: string
}

export interface ArticleWriterFixture {
  stories: Story[]
}

type Summaries = (ArticleSummary | null)[]

function prompt(story: Story): string {
  // The renderer reads the beat's title and the article's title and source.
  return renderArticleForWriter(
    { title: story.beat } as Beat,
    { title: story.title, source: story.source } as Article,
    story.reason,
    story.body,
  )
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length

/** A sentence about the article instead of about its subject — what the instructions call filler. */
const FRAME = /^\s*(this|the) (article|post|blog post|piece|paper|video|author|authors|researchers)\b|\bthis (article|post|piece)\b/i

/** Everything code can prove wrong with one run's summaries. */
export function articleWriterFlags(summaries: Summaries, fixture: ArticleWriterFixture): string[] {
  const flags: string[] = []
  summaries.forEach((summary, index) => {
    const story = fixture.stories[index]
    const at = `article ${index + 1}`
    if (!summary) {
      flags.push(`${at}: every attempt failed — production would send the bare excerpt`)
      return
    }
    if (!summary.lede.trim()) flags.push(`${at}: empty lede`)
    if (summary.points.length > 3) flags.push(`${at}: ${summary.points.length} points, the limit is 3`)
    const all = [summary.lede, ...summary.points]
    const framed = all.find(text => FRAME.test(text))
    if (framed) flags.push(`${at}: talks about the article rather than its subject — "${framed.slice(0, 80)}"`)
    // The sender adds the title and the link; the writer is told never to.
    if (all.some(text => /https?:\/\//.test(text))) flags.push(`${at}: contains a URL`)
    if (story && story.title.length > bench.titleEchoMinChars && all.some(text => text.includes(story.title))) {
      flags.push(`${at}: repeats the title verbatim`)
    }
  })
  return flags
}

/**
 * Delivered articles with a body, most recent first, dealt round-robin across
 * their beats so a fixture is not four stories from the beat that sends most.
 */
async function readFixtures(count: number): Promise<ArticleWriterFixture[]> {
  const rows = await db()
    .select({
      id: articles.id,
      beat: beats.title,
      beatSlug: articles.deliveredBeat,
      title: articles.title,
      source: articles.source,
      reason: articleBeats.reason,
      body: articles.content,
    })
    .from(articles)
    .innerJoin(
      articleBeats,
      and(eq(articleBeats.articleId, articles.id), eq(articleBeats.beatSlug, articles.deliveredBeat)),
    )
    .innerJoin(beats, eq(beats.slug, articles.deliveredBeat))
    .where(and(isNotNull(articles.deliveredAt), sql`length(${articles.content}) >= ${bench.writerMinBodyChars}`))
    .orderBy(desc(articles.deliveredAt))

  const byBeat = new Map<string, Story[]>()
  for (const row of rows) {
    const story: Story = {
      id: row.id,
      beat: row.beat,
      title: row.title,
      source: row.source,
      reason: row.reason,
      body: row.body ?? '',
    }
    byBeat.set(row.beatSlug ?? '', [...(byBeat.get(row.beatSlug ?? '') ?? []), story])
  }
  const dealt: Story[] = []
  const queues = [...byBeat.values()]
  while (queues.some(queue => queue.length)) {
    for (const queue of queues) {
      const next = queue.shift()
      if (next) dealt.push(next)
    }
  }

  const fixtures: ArticleWriterFixture[] = []
  for (let i = 0; i + bench.writerBatch <= dealt.length && fixtures.length < count; i += bench.writerBatch) {
    fixtures.push({ stories: dealt.slice(i, i + bench.writerBatch) })
  }
  return fixtures
}

export const articleWriter: BenchTask<ArticleWriterFixture, Summaries> = {
  title: 'article-writer',
  knob: 'AVA_MODEL_RSS_SUMMARIZER',
  agentId: articleWriterId,
  agent: curatorAgents[articleWriterId] as BenchTask<ArticleWriterFixture, Summaries>['agent'],
  // Edited freely between runs. The field that chose deepseek-v4.1-flash with
  // reasoning off on 2026-10-12 (see env.ts) was v4-flash-0731 as incumbent and
  // at off, v4.1-flash off/low, claude-haiku-5.5 off/low and gpt-5.6-luna low;
  // the incumbent is now v4.1 at off, so `low` is the question left open here.
  field: [
    { model: 'openrouter/deepseek/deepseek-v4.1-flash', efforts: ['low'] },
    // { model: 'openrouter/anthropic/claude-haiku-5.5', efforts: [false, 'low'] },
    // { model: 'openrouter/openai/gpt-5.6-luna', efforts: [false, 'low'] },
  ],
  fixtures: readFixtures,
  describe: f => `${f.stories.length} articles — ${f.stories.map(s => `${s.beat}: ${s.title.slice(0, 50)}`).join(' · ')}`,
  call: async (mastra, fixture) => {
    // One after another, as the pool already holds eight runs in flight —
    // four calls each at once would put thirty-two on OpenRouter.
    const summaries: Summaries = []
    for (const story of fixture.stories) summaries.push(await writeArticleSummary(mastra, prompt(story)))
    return summaries.some(Boolean) ? summaries : null
  },
  check: articleWriterFlags,
  metrics: summaries => {
    const ok = summaries.filter((s): s is ArticleSummary => s !== null)
    return {
      'lede words': ok.length ? ok.reduce((sum, s) => sum + words(s.lede), 0) / ok.length : NaN,
      points: ok.length ? ok.reduce((sum, s) => sum + s.points.length, 0) / ok.length : NaN,
    }
  },
  judgeInput: fixture =>
    fixture.stories.map((story, index) => `## Article ${index + 1}\n\n${prompt(story)}`).join('\n\n---\n\n'),
  renderOutput: (summaries, fixture) =>
    summaries
      .map((summary, index) => {
        const head = `Article ${index + 1} — ${fixture.stories[index]?.title ?? ''}`
        return summary
          ? [head, `lede: ${summary.lede}`, ...summary.points.map(point => `- ${point}`)].join('\n')
          : `${head}\nFAILED — production would send the bare excerpt`
      })
      .join('\n\n'),
  criteria: [
    'The lede tells a technically skilled reader who does not know this project what it is and why it ' +
    'matters: the topic in plain language first, the problem, the main change, the technical name.',
    'Every claim is in the article. An invented benchmark, version or date is the worst failure here.',
    'Points add concrete facts not already in the lede — numbers, versions, limitations — or are absent ' +
    'when the article has none. A point that restates the lede fails.',
    'No filler, hype or marketing language, and nothing about "this article" or "the researchers".',
  ],
  caveats: () => [
    'Every fixture article is in English, so the rule that a summary is always in English is not tested ' +
    'here. `$/run` and the median are for four articles, one call each.',
  ],
}
