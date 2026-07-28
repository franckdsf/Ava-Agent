import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { CATEGORIES, getCategory } from '../../config/categories.js'
import { env } from '../../config/env.js'
import { pipeline } from '../../config/pipeline.js'
import { recentFeedback, type FeedbackSignal } from '../../db/feedback.js'
import {
  insertDiscovered,
  isSharedFeedImage,
  listDeliverable,
  listUnranked,
  markDelivered,
  saveClusters,
  saveImageUrl,
  saveRankings,
} from '../../db/items.js'
import type { Item } from '../../db/schema.js'
import type { ItemRanking } from '../../db/types.js'
import { fetchArticleText, fetchOgImage, looksLikeSiteChrome } from '../../services/article.js'
import { clusterItems, dedupeByCluster } from '../../services/cluster.js'
import { fetchCategoryFeeds } from '../../services/rss.js'
import { escapeMarkdown, sendArticle } from '../../services/telegram.js'
import { articleWriterId, rankerId } from '../agents/curator.js'

/**
 * One workflow for every beat. `categorySlug` is the only input, so adding a
 * category adds schedules and changes nothing here.
 *
 * ingest → cluster → rank → compose. Each stage is deterministic except the two
 * LLM calls, which is deliberate: a scheduled job that lets a model choose its
 * own control flow is how you get surprise bills and duplicate messages.
 */

const categoryInput = z.object({ categorySlug: z.string() })

const ingested = categoryInput.extend({
  discovered: z.number(),
  feedErrors: z.array(z.string()),
})

const clustered = ingested.extend({
  pending: z.number(),
  stories: z.number(),
})

const ranked = clustered.extend({
  scored: z.number(),
})

const composed = ranked.extend({
  messages: z.array(
    z.object({
      itemId: z.string(),
      text: z.string(),
      imageUrl: z.string().nullable(),
    }),
  ),
})

const delivered = composed.extend({
  sent: z.number(),
  sendErrors: z.array(z.string()),
})

const ingest = createStep({
  id: 'ingest',
  inputSchema: categoryInput,
  outputSchema: ingested,
  execute: async ({ inputData }) => {
    const category = getCategory(inputData.categorySlug)
    const results = await fetchCategoryFeeds(category)
    const discovered = await insertDiscovered(results.flatMap(result => result.items))
    return {
      categorySlug: category.slug,
      discovered,
      feedErrors: results
        .filter(result => result.error)
        .map(result => `${result.feedUrl}: ${result.error}`),
    }
  },
})

const cluster = createStep({
  id: 'cluster',
  inputSchema: ingested,
  outputSchema: clustered,
  execute: async ({ inputData }) => {
    const pending = await listUnranked(inputData.categorySlug, pipeline.maxItemsPerRankingRun)
    const assignments = clusterItems(pending.map(item => ({ id: item.id, title: item.title })))
    await saveClusters(assignments)
    return {
      ...inputData,
      pending: pending.length,
      stories: new Set(assignments.map(a => a.clusterId)).size,
    }
  },
})

function renderInterestProfile(signals: FeedbackSignal[]): string {
  if (signals.length === 0) return 'No feedback recorded yet. Judge on the rubric alone.'
  const line = (signal: FeedbackSignal) => `- ${signal.title} (${signal.source})`
  const liked = signals.filter(s => s.vote === 'up').map(line)
  const disliked = signals.filter(s => s.vote === 'down').map(line)
  return [
    liked.length ? `Recently marked USEFUL:\n${liked.join('\n')}` : '',
    disliked.length ? `Recently marked NOT USEFUL:\n${disliked.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function renderItemsForRanking(items: Item[]): string {
  return items
    .map(item =>
      [
        `id: ${item.id}`,
        `source: ${item.source}`,
        `title: ${item.title}`,
        item.excerpt ? `excerpt: ${item.excerpt}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n---\n\n')
}

const rankingSchema = z.object({
  rankings: z.array(
    z.object({
      id: z.string(),
      score: z.number().min(0).max(100),
      subtopic: z.string(),
      reason: z.string(),
    }),
  ),
})

const rank = createStep({
  id: 'rank',
  inputSchema: clustered,
  outputSchema: ranked,
  execute: async ({ inputData, mastra }) => {
    const category = getCategory(inputData.categorySlug)
    const pending = await listUnranked(category.slug, pipeline.maxItemsPerRankingRun)
    if (pending.length === 0) return { ...inputData, scored: 0 }

    // Only one item per story reaches the model; the rest are resolved below so
    // they don't accumulate as permanently unranked.
    const assignments = pending.map(item => ({
      id: item.id,
      clusterId: item.clusterId ?? item.id,
    }))
    const representatives = dedupeByCluster(pending, assignments)
    const representativeIds = new Set(representatives.map(item => item.id))

    const agent = mastra.getAgent(rankerId(category.slug))
    const profile = renderInterestProfile(
      await recentFeedback(category.slug, pipeline.feedbackWindow),
    )

    const response = await agent.generate(
      [
        '## Reader interest profile',
        profile,
        '',
        `## Items to score (${representatives.length})`,
        renderItemsForRanking(representatives),
      ].join('\n'),
      { structuredOutput: { schema: rankingSchema } },
    )

    const returned = response.object?.rankings ?? []
    // Guard against a model echoing an id that wasn't in the batch.
    const verdicts: ItemRanking[] = returned.filter(r => representativeIds.has(r.id))

    // Everything the model didn't score — cluster duplicates, plus any item it
    // silently dropped — is settled at zero so it never delivers and never
    // re-enters the batch. The representative carries the story.
    const scoredIds = new Set(verdicts.map(v => v.id))
    const duplicates: ItemRanking[] = pending
      .filter(item => !scoredIds.has(item.id))
      .map(item => ({
        id: item.id,
        score: 0,
        subtopic: item.subtopic ?? category.subtopics[0] ?? 'general',
        reason: representativeIds.has(item.id)
          ? 'Not scored by ranker; skipped this run.'
          : 'Duplicate coverage of a story already in this batch.',
      }))

    await saveRankings([...verdicts, ...duplicates])
    return { ...inputData, scored: verdicts.length }
  },
})

/**
 * The body handed to the summarizer. The feed's own content is preferred — it
 * is already paid for and usually cleaner than a scraped page — and the article
 * is only fetched when the feed shipped nothing. The excerpt is the floor:
 * thin, but the writer is told to stay brief rather than pad.
 */
async function articleBody(item: Item): Promise<string> {
  if (item.content) return item.content
  return (await fetchArticleText(item.link)) ?? item.excerpt ?? ''
}

function renderItemForWriter(item: Item, body: string): string {
  return [
    `title: ${item.title}`,
    `source: ${item.source}`,
    item.reason ? `why it ranked: ${item.reason}` : null,
    '',
    body ? `article:\n${body}` : 'article: (no body available — only the title above)',
  ]
    .filter(value => value !== null)
    .join('\n')
}

const summarySchema = z.object({
  lede: z.string(),
  points: z.array(z.string()),
})

/**
 * Telegram parses `rich_message.markdown` server-side, so this markdown becomes
 * real blocks: a heading, a paragraph, a bullet list. Structure comes from the
 * template and prose from the model — a summarizer asked to emit its own
 * markdown eventually emits a broken link, and the URL is the one part of the
 * message that must be exactly right.
 *
 * The image is deliberately *not* included here; `deliver` prepends it so a URL
 * Telegram refuses can be dropped without rebuilding the message.
 */
function renderMessage(
  category: ReturnType<typeof getCategory>,
  item: Item,
  summary: z.infer<typeof summarySchema>,
): string {
  const footer = [item.source, item.subtopic]
    .filter((value): value is string => Boolean(value))
    .map(escapeMarkdown)
    .join(' · ')

  // A model that returns an empty point still shouldn't produce an empty bullet.
  const points = summary.points.map(point => point.trim()).filter(Boolean)

  // Blank lines, not newlines: a single newline is a soft wrap in markdown and
  // collapses into the previous line when Telegram renders it.
  return [
    `## ${category.emoji} [${escapeMarkdown(item.title)}](${item.link})`,
    '',
    summary.lede.trim(),
    ...(points.length > 0 ? ['', ...points.map(point => `- ${escapeMarkdown(point)}`)] : []),
    '',
    `_${footer}_`,
  ].join('\n')
}

/**
 * The feed's own image wins. og:image is only consulted when the feed had none,
 * and survives two checks: it must not look like site chrome, and no sibling
 * item from the same feed may already carry it. Either signal means a site-wide
 * banner, which is worse than showing no image at all.
 */
async function resolveImage(item: Item): Promise<string | null> {
  if (item.imageUrl) return item.imageUrl

  const candidate = await fetchOgImage(item.link)
  if (!candidate) return null
  if (looksLikeSiteChrome(candidate)) return null
  if (await isSharedFeedImage(item.feedUrl, candidate, item.id)) return null

  // Recorded so the next item from this feed can recognise a repeat.
  await saveImageUrl(item.id, candidate)
  return candidate
}

const compose = createStep({
  id: 'compose',
  inputSchema: ranked,
  outputSchema: composed,
  execute: async ({ inputData, mastra }) => {
    const category = getCategory(inputData.categorySlug)
    const deliverable = await listDeliverable(
      category.slug,
      category.digestThreshold,
      category.maxItemsPerDigest,
    )

    if (deliverable.length === 0) return { ...inputData, messages: [] }

    const agent = mastra.getAgent(articleWriterId(category.slug))

    // Handful of items, independent calls — run them together rather than
    // serially so a slow article fetch doesn't stack up across the batch.
    const messages = await Promise.all(
      deliverable.map(async item => {
        const response = await agent.generate(renderItemForWriter(item, await articleBody(item)), {
          structuredOutput: { schema: summarySchema },
        })
        const summary = response.object ?? { lede: response.text.trim(), points: [] }
        return {
          itemId: item.id,
          text: renderMessage(category, item, summary),
          imageUrl: await resolveImage(item),
        }
      }),
    )

    return { ...inputData, messages }
  },
})

const deliver = createStep({
  id: 'deliver',
  inputSchema: composed,
  outputSchema: delivered,
  execute: async ({ inputData }) => {
    let sent = 0
    const sendErrors: string[] = []

    // Sequential and one item at a time: Telegram preserves the order messages
    // arrive in, and marking each article as it lands means a failure halfway
    // through doesn't re-send the ones that already got there.
    for (const message of inputData.messages) {
      try {
        await sendArticle(message.text, message.imageUrl)
        await markDelivered([message.itemId], 'digest')
        sent += 1
      } catch (err) {
        sendErrors.push(`${message.itemId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return { ...inputData, sent, sendErrors }
  },
})

export const curateCategory = createWorkflow({
  id: 'curate-category',
  inputSchema: categoryInput,
  outputSchema: delivered,
  // One schedule per category per digest hour, derived from config so a new
  // category or a changed cadence needs no edit here.
  schedule: CATEGORIES.flatMap(category =>
    pipeline.digestHours.map(hour => ({
      id: `${category.slug}-${String(hour).padStart(2, '0')}00`,
      cron: `0 ${hour} * * *`,
      timezone: env.AGENT_TIMEZONE,
      inputData: { categorySlug: category.slug },
    })),
  ),
})
  .then(ingest)
  .then(cluster)
  .then(rank)
  .then(compose)
  .then(deliver)
  .commit()
