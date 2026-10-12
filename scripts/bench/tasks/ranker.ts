/**
 * `pnpm bench ranker` — `AVA_MODEL_RSS_RANKER`, through `rankBatch`.
 *
 * A fixture is one beat's batch as the rank step would send it: the rubric, the
 * labels, both reader profiles, and a deduplicated run of that beat's recent
 * articles. Already-ranked articles rather than pending ones, because pending is
 * whatever arrived since the last run — often nothing — and a fixture has to
 * exist on the evening someone wants to compare models.
 *
 * **Votes are the only ground truth here, and they are kept out of the prompt.**
 * An article the reader voted on is put in the batch when it is still stored,
 * and its vote is removed from the interest profile that batch is sent with —
 * otherwise `agree` would measure whether a model can find a title it was just
 * shown, not whether it shares the reader's taste.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { bench } from '../../../src/config/bench.js'
import { pipeline } from '../../../src/config/pipeline.js'
import { activeBeats } from '../../../src/db/beats.js'
import { db, migrate } from '../../../src/db/client.js'
import type { FeedbackSignal } from '../../../src/db/feedback.js'
import { articleBeats, articles, feedback } from '../../../src/db/schema.js'
import type { ArticleRanking, PendingArticle } from '../../../src/db/types.js'
import {
  curatorAgents,
  rankBatch,
  rankerId,
  renderInterestProfile,
  renderRankingPrompt,
  renderReaderProfile,
} from '../../../src/mastra/agents/curator.js'
import { coverageFlags, scoreSpread, type BenchTask } from '../kit.js'

export interface RankerFixture {
  beat: { slug: string; title: string; rubric: string; subtopics: string[]; digestThreshold: number }
  profile: string
  reader: string
  articles: { id: string; source: string; title: string; excerpt: string | null }[]
  /** The reader's own vote on articles in this batch. Empty on a database nobody has voted in. */
  votes: Record<string, 'up' | 'down'>
}

function prompt(fixture: RankerFixture): string {
  return renderRankingPrompt({
    beat: fixture.beat,
    profile: fixture.profile,
    reader: fixture.reader,
    // The renderer reads id, source, title and excerpt — the fixture stores only
    // those, because the full row carries the article body and would make the
    // frozen file megabytes for nothing.
    articles: fixture.articles as PendingArticle[],
  })
}

/**
 * How often an article the reader liked outscored one they disliked — the share
 * of (up, down) pairs ordered the reader's way, ties counting half. 0.5 is a
 * coin; `NaN` when the batch lacks either kind of vote.
 */
export function voteAgreement(rankings: ArticleRanking[], votes: Record<string, 'up' | 'down'>): number {
  const score = new Map(rankings.map(r => [r.id, r.score]))
  const ups = Object.keys(votes).filter(id => votes[id] === 'up' && score.has(id)).map(id => score.get(id) as number)
  const downs = Object.keys(votes).filter(id => votes[id] === 'down' && score.has(id)).map(id => score.get(id) as number)
  if (ups.length === 0 || downs.length === 0) return NaN
  let won = 0
  for (const up of ups) for (const down of downs) won += up > down ? 1 : up === down ? 0.5 : 0
  return won / (ups.length * downs.length)
}

/** Everything code can prove wrong with one ranking of one batch. */
export function rankerFlags(rankings: ArticleRanking[], fixture: RankerFixture): string[] {
  const flags = coverageFlags(
    fixture.articles.map(a => a.id),
    rankings.map(r => r.id),
    'articles',
  )

  const labels = new Set(fixture.beat.subtopics)
  const offList = [...new Set(rankings.map(r => r.subtopic).filter(s => !labels.has(s)))]
  if (offList.length) flags.push(`subtopic not in the beat's labels: ${offList.map(s => `"${s}"`).join(', ')}`)

  const long = rankings.filter(r => r.reason.split(/\s+/).filter(Boolean).length > 15)
  if (long.length) flags.push(`${long.length} reasons over 15 words, e.g. "${long[0]?.reason}"`)
  const empty = rankings.filter(r => r.reason.trim() === '')
  if (empty.length) flags.push(`${empty.length} empty reasons`)

  // The instructions forbid it so a reason still reads correctly months later.
  const personal = rankings.filter(r => mentionsReader(r.reason))
  if (personal.length) flags.push(`${personal.length} reasons mention the reader, e.g. "${personal[0]?.reason}"`)
  return flags
}

/**
 * A reason that talks about the reader rather than the article.
 *
 * Narrower than it looks like it needs to be, because the first live run showed
 * what a loose pattern costs: an article about Amazon's "About You" page and one
 * about screen readers are subjects, not mentions — and a flag reaches the judge
 * as fact, so a false one sank a model on that fixture. "you" counts unless it is
 * "about you"; "reader" counts only after a determiner.
 */
export function mentionsReader(reason: string): boolean {
  return (
    /\b(the|this|our|to|for) reader\b/i.test(reason) ||
    /\breader'?s? (interests?|profile|notes|votes|taste)\b/i.test(reason) ||
    /(?<!about )\byour?\b/i.test(reason)
  )
}

async function readFixtures(count: number): Promise<RankerFixture[]> {
  await migrate()
  const reader = await renderReaderProfile()
  const beats = await activeBeats()

  const built = await Promise.all(
    beats.map(async beat => {
      const votes = await db()
        .select({ articleId: feedback.articleId, title: feedback.title, source: feedback.source, vote: feedback.vote })
        .from(feedback)
        .where(eq(feedback.beatSlug, beat.slug))
        .orderBy(desc(feedback.createdAt))

      const rows = await db()
        .select({
          id: articles.id,
          source: articles.source,
          title: articles.title,
          excerpt: articles.excerpt,
          clusterId: articleBeats.clusterId,
        })
        .from(articleBeats)
        .innerJoin(articles, eq(articles.id, articleBeats.articleId))
        .where(and(eq(articleBeats.beatSlug, beat.slug), isNotNull(articleBeats.rankedAt)))
        .orderBy(desc(articles.discoveredAt))
        .limit(bench.rankerBatch * 4)

      // Voted articles first, so a batch carries every vote that still has an
      // article behind it; then the most recent, one per story — the ranker
      // never sees two headlines from one cluster in production either.
      const voted = new Map(votes.map(v => [v.articleId, v.vote]))
      const picked: typeof rows = []
      const clusters = new Set<string>()
      for (const row of [...rows.filter(r => voted.has(r.id)), ...rows.filter(r => !voted.has(r.id))]) {
        if (picked.length >= bench.rankerBatch) break
        if (row.clusterId && clusters.has(row.clusterId)) continue
        if (row.clusterId) clusters.add(row.clusterId)
        picked.push(row)
      }
      picked.reverse()

      const inBatch = new Set(picked.map(r => r.id))
      const signals: FeedbackSignal[] = votes
        .filter(v => !inBatch.has(v.articleId))
        .slice(0, pipeline.feedbackWindow)
        .map(({ title, source, vote }) => ({ title, source, vote }))

      return {
        beat: {
          slug: beat.slug,
          title: beat.title,
          rubric: beat.rubric,
          subtopics: beat.subtopics,
          digestThreshold: beat.digestThreshold,
        },
        profile: renderInterestProfile(signals),
        reader,
        articles: picked.map(({ id, source, title, excerpt }) => ({ id, source, title, excerpt })),
        votes: Object.fromEntries(picked.filter(r => voted.has(r.id)).map(r => [r.id, voted.get(r.id) as 'up' | 'down'])),
      } satisfies RankerFixture
    }),
  )

  // The beats with the most votes in their batch, then the fullest batches.
  return built
    .filter(f => f.articles.length > 0)
    .sort((a, b) => Object.keys(b.votes).length - Object.keys(a.votes).length || b.articles.length - a.articles.length)
    .slice(0, count)
}

export const ranker: BenchTask<RankerFixture, ArticleRanking[]> = {
  title: 'ranker',
  knob: 'AVA_MODEL_RSS_RANKER',
  agentId: rankerId,
  agent: curatorAgents[rankerId] as BenchTask<RankerFixture, ArticleRanking[]>['agent'],
  // Edited freely between runs. The field that chose deepseek-v4.1-flash @ low on
  // 2026-10-12 (see env.ts) was v4-flash-0731 as incumbent, v4.1-flash off/low,
  // haiku-5.5 off/low and glm-5.3-flash low — glm cannot run with reasoning off.
  field: [
    // { model: 'openrouter/deepseek/deepseek-v4-flash-0731', efforts: [false] },
    // { model: 'openrouter/deepseek/deepseek-v4.1-flash', efforts: [false, 'low'] },
    // { model: 'openrouter/xiaomi/mimo-v2.6-flash', efforts: [false, 'low'] },
    // { model: 'openrouter/xiaomi/mimo-v2.6-pro', efforts: [false, 'low'] },
    { model: 'openrouter/anthropic/claude-haiku-5.5', efforts: [false, 'low'] },
    { model: 'openrouter/z-ai/glm-5.3-flash', efforts: ['low'] },
    // { model: 'openrouter/openai/gpt-5.6-luna', efforts: [false, 'low'] },
  ],
  fixtures: readFixtures,
  describe: f => `${f.beat.title} — ${f.articles.length} articles, ${Object.keys(f.votes).length} voted`,
  call: async (mastra, fixture) => {
    const rankings = await rankBatch(mastra, prompt(fixture), new Set(fixture.articles.map(a => a.id)), fixture.beat.slug)
    // `rankBatch` returns [] when every attempt failed — in production that
    // leaves the batch for the next run, here it is a failed run.
    return rankings.length ? rankings : null
  },
  check: rankerFlags,
  metrics: (rankings, fixture) => ({
    agree: voteAgreement(rankings, fixture.votes),
    mean: rankings.reduce((sum, r) => sum + r.score, 0) / rankings.length,
    // How many would be eligible to win this beat — the number the reader feels.
    'over bar': rankings.filter(r => r.score >= fixture.beat.digestThreshold).length,
  }),
  across: runs => ({ spread: scoreSpread(runs) }),
  judgeInput: prompt,
  renderOutput: (rankings, fixture) => {
    const byId = new Map(rankings.map(r => [r.id, r]))
    return fixture.articles
      .map(a => {
        const r = byId.get(a.id)
        return r ? `${a.id} | ${r.score} | ${r.subtopic} | ${r.reason}` : `${a.id} | NOT SCORED`
      })
      .join('\n')
  },
  criteria: [
    'Scores follow the rubric: on-beat articles above off-beat ones, and most of a normal batch below 50. ' +
    'Judge each score against the article and the rubric, not against the other candidates.',
    'Where the reader profile or notes state a preference, the articles it names move — and nothing else does.',
    'Every reason is concrete and says what happened, at most 15 words, with no mention of the reader. ' +
    '"Funding round, no technical content" is the bar; "not relevant" fails it.',
    'Subtopic labels fit the article and come from the beat\'s list.',
  ],
  caveats: fixtures => [
    ...(fixtures.every(f => Object.keys(f.votes).length === 0)
      ? [
        'No reader votes in these fixtures, so `agree` is empty and nothing in this table is ground truth: ' +
        'the judge and `spread` are all there is.',
      ]
      : []),
    '`spread` is how far one entrant\'s scores for the same article move between runs — lower is steadier. ' +
    '`over bar` counts articles at or above the beat\'s digest threshold.',
  ],
}
