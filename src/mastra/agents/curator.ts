import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { memoryConfig } from '../../config/memory.js'
import { pipeline } from '../../config/pipeline.js'
import type { Beat } from '../../db/beats.js'
import type { FeedbackSignal } from '../../db/feedback.js'
import { memoriesForCuration, type Memory } from '../../db/memories.js'
import type { Article, ArticleRanking, PendingArticle } from '../../db/types.js'
import { withRetry } from '../../services/structured-output.js'

/**
 * One ranker and one article writer for every beat — not one pair per beat.
 *
 * This used to build two agents per entry in `CATEGORIES` and register them all
 * on the Mastra instance at import time, which meant a beat that did not exist
 * when the process booted had no agent: `mastra.getAgent('rust-ranker')` threw.
 * That was survivable while beats were a git-reviewable array and unworkable the
 * moment the reader can add one by talking to Newy
 * ([ADR-0019](../../../docs/decisions/0019-beats-as-reader-owned-data.md)).
 *
 * **The rubric moved from the instructions into the prompt**, and that is the
 * whole of the change. ADR-0008 already drew this line for the feedback profile
 * — "passed in the prompt, not in the instructions, so it cannot go stale
 * between restarts" — and a rubric the reader edits mid-conversation now needs
 * exactly the same treatment. What is left in the instructions is the part that
 * is true of ranking itself, whatever the beat.
 *
 * Mastra 1.52 does support `instructions: ({requestContext}) => …`, which would
 * have kept the rubric in the instructions and resolved it per call. It is not
 * used here: it buys nothing over passing the same text in the prompt, and it
 * would put a database read on a code path that has no way to report a failure.
 *
 * Ranking and writing stay separate agents, for the reason they always were:
 * ranking sees hundreds of articles per run and must be cheap, writing sees a
 * handful and must be good.
 */

export const rankerId = 'beat-ranker'
export const articleWriterId = 'beat-article-writer'

const ranker = new Agent({
  id: rankerId,
  name: 'Beat Ranker',
  model: env.AVA_MODEL_RSS_RANKER,
  instructions: `
You score news articles for one beat at a time.

Every batch arrives with the beat it is for, the rubric that defines what that
beat is, and the exact list of subtopic labels you may use. Those three change
from batch to batch. Read them each time — never carry a rubric or a label set
over from a previous batch.

Return one JSON object whose only key is "rankings": an array with one entry per
article, in the order you were given them. Never rename that key and never wrap
the array in anything else.

For every article you are given, return:
- "id": echoed back exactly as provided. Never invent or alter an id.
- "score": 0-100 relevance against the rubric you were given.
- "subtopic": exactly one label from the list you were given for this beat.
- "reason": at most 15 words, concrete. Say what happened, not "this is relevant".

Rules:
- Score every article you are given. Never skip, merge, or reorder them.
- Judge the article on its own merits; scores are absolute, not a ranking against
  the rest of the batch. Most articles in a normal batch should score below 50.
- When the interest profile shows the reader downvoting a pattern, penalize it.
  When it shows upvotes, reward that pattern. Recent votes matter more.
- A headline you cannot evaluate from the title and excerpt scores below 40.

A "reason" is written for every article, not only the ones that will be sent.
The reader can ask why something was passed over, and your reason is the whole of
the answer they get — so a low score deserves as specific a sentence as a high
one. "Funding round, no technical content" is useful; "not relevant" is not.

Two things about the reader arrive with each batch, and they are not equally
strong evidence.

"Reader interest profile" is their own 👍/👎 on articles already sent to them.
That is direct: they judged those, on this beat.

"What is known about the reader" is notes written down while talking with them,
dated, oldest first, a later note about the same thing superseding an earlier
one. Two kinds sit in that list and they carry very different weight.

A note where they said what they want — more of a subject, less of one, that
something is or is not part of their work — is an instruction. Apply it hard and
apply it narrowly: move the articles it actually names, well past the range you
would move them on the rubric alone, and leave the rest of the batch alone.

Every other note is background: their job, their tools, their city, what they are
building right now. It only separates articles the rubric already scores alike —
one touching their work beats an equally on-beat article touching nothing of
theirs.

- The rubric decides whether an article belongs on this beat. Background notes
  never change that answer; an off-beat article does not become relevant because
  it mentions something from their life.
- The notes are about the reader, not about this beat, and the reader is the same
  person on every beat. A note saying they do not want a subject applies here
  even if this beat is not where they said it.
- Most notes have nothing to do with most batches. Ignoring one is the normal
  outcome, not a failure, and background alone is never a reason to move a score.
- Never mention the reader, their notes, or their votes in a "reason". A reason
  says what the article is, so it still reads correctly months later.
- A note may say which language the reader speaks or how they like to be
  addressed. That governs conversations elsewhere, never your output: score and
  write every reason in English whatever language a note is written in.
`.trim(),
})

const articleWriter = new Agent({
  id: articleWriterId,
  name: 'Beat Article Writer',
  model: env.AVA_MODEL_RSS_SUMMARIZER,
  instructions: `
You summarize one article at a time for a reader following a particular beat.
The beat is named with each article; it tells you what the reader cares about,
not what to write about.

The sender adds the title, link, source, and layout. Never output those.

Return two fields:

"lede" — one or two sentences explaining what this is and why it matters.
- Start with the topic in plain language before diving into implementation details.
- Assume the reader is technically skilled but may not know this specific project, paper, library, or technique.
- Explain the problem being solved and the main change or contribution.
- Mention the technical name (API, model, molecule, library, technique, version) naturally.
- Do not say "This article", "The researchers", or similar filler.

"points" — zero to three short supporting details.
- Use readable sentences or short phrases, not compressed fragments.
- Include concrete facts: benchmarks, versions, compatibility, limitations, architecture changes, dates.
- Each point must add a new fact not already explained in the lede.
- Do not repeat the lede.
- Return [] when there are no useful specifics.

Style:
- Write for a passionated person who knows the field but does not know every new project.
- Optimize for understanding, not maximum compression.
- Avoid hype and marketing language.
- Do not invent details.

Language:
- Write "lede" and "points" in English. Always, and whatever language you would
  otherwise reach for.
- An article written in another language is still summarized in English. So is a
  beat whose title or rubric is not in English.
- A summary arriving in any other language is a broken message, not a translated
  one. The reader asks for a translation with a command of their own, and that
  command does not go through you.
`.trim(),
})

/** The curator agents, keyed by id, ready to register on the Mastra instance. */
export const curatorAgents: Record<string, Agent> = {
  [rankerId]: ranker,
  [articleWriterId]: articleWriter,
}

export function renderInterestProfile(signals: FeedbackSignal[]): string {
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

/**
 * What Newy has written down about the reader, rendered for the ranker.
 *
 * The 👍/👎 profile above says what they thought of articles; this says who they
 * are — and the two answer different halves of "would they want this?". A vote
 * can only teach the ranker about a pattern it has already sent, so a beat with
 * no votes yet has nothing but the rubric. The notes are the signal that exists
 * from the first run
 * ([ADR-0016](../../../docs/decisions/0016-reader-notes-in-the-ranker.md)).
 *
 * **Not scoped to the beat, and that is deliberate.** "No Android articles" is a
 * statement about the reader, not about one tab, so it reaches every ranker —
 * including a beat created after the note was written. A note that stops being
 * true is superseded by a later one rather than edited, which is the mechanism
 * `memories` already has.
 *
 * **Never throws.** A failed read here would take down a whole curation run over
 * the part of it that is an enhancement; ranking without the notes is exactly how
 * the pipeline behaved before they existed.
 *
 * Dates and oldest-first ordering are carried through rather than stripped: "left
 * Acme (2025-11)" then "joined Globex (2026-03)" only reads as a job change in
 * that order, and a ranker that reads it as two current employers weights the
 * wrong company.
 */
export async function renderReaderProfile(): Promise<string> {
  let notes: { long: Memory[]; short: Memory[] }
  try {
    notes = await memoriesForCuration()
  } catch {
    return 'Unavailable this run. Judge on the rubric and the votes alone.'
  }

  const line = (note: Memory) => `- ${note.happenedOn} — ${note.fact}`
  if (notes.long.length === 0 && notes.short.length === 0) {
    return 'Nothing recorded yet. Judge on the rubric and the votes alone.'
  }

  return [
    notes.long.length ? `Lasting:\n${notes.long.map(line).join('\n')}` : '',
    notes.short.length
      ? `Recent (last ${memoryConfig.shortTermDays} days):\n${notes.short.map(line).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function renderArticlesForRanking(articles: PendingArticle[]): string {
  return articles
    .map(article =>
      [
        `id: ${article.id}`,
        `source: ${article.source}`,
        `title: ${article.title}`,
        article.excerpt ? `excerpt: ${article.excerpt}` : null,
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

/**
 * The ranker's prompt for one beat's batch.
 *
 * The rubric and the subtopic labels travel here rather than in the
 * instructions — see this file's header. The two profiles arrive already
 * rendered, because rendering them reads the database and this stays a pure
 * function: `pnpm bench` sends a frozen batch through it, swapping only the model.
 */
export function renderRankingPrompt(input: {
  beat: Pick<Beat, 'title' | 'rubric' | 'subtopics'>
  profile: string
  reader: string
  articles: PendingArticle[]
}): string {
  return [
    `## Beat: ${input.beat.title}`,
    '',
    '## Rubric',
    input.beat.rubric,
    '',
    `## Subtopic labels (choose exactly one per article)`,
    input.beat.subtopics.join(', '),
    '',
    '## Reader interest profile',
    input.profile,
    '',
    '## What is known about the reader',
    input.reader,
    '',
    `## Articles to score (${input.articles.length})`,
    renderArticlesForRanking(input.articles),
  ].join('\n')
}

/**
 * Scores one beat's batch. One call, retried.
 *
 * Returns an empty list rather than throwing when every attempt failed, as
 * `scoreBatch` does for jobs: the caller leaves the batch unranked so the next
 * run picks it up whole. An id the model echoes that was not in the batch is
 * dropped here.
 */
export async function rankBatch(
  mastra: Mastra,
  prompt: string,
  batchIds: Set<string>,
  beatSlug: string,
): Promise<ArticleRanking[]> {
  const agent = mastra.getAgent(rankerId)
  const ranking = await withRetry<z.infer<typeof rankingSchema>>(
    pipeline.modelAttempts,
    () => agent.generate(prompt, { structuredOutput: { schema: rankingSchema } }),
    (attempt, error) =>
      mastra
        .getLogger()
        ?.warn(`Beat ranker attempt ${attempt}/${pipeline.modelAttempts} failed for ${beatSlug}`, error),
  )
  return (ranking?.rankings ?? []).filter(verdict => batchIds.has(verdict.id))
}

const summarySchema = z.object({
  lede: z.string(),
  points: z.array(z.string()),
})

export function renderArticleForWriter(beat: Beat, article: Article, reason: string | null, body: string): string {
  return [
    `beat: ${beat.title}`,
    `title: ${article.title}`,
    `source: ${article.source}`,
    reason ? `why it ranked: ${reason}` : null,
    '',
    body ? `article:\n${body}` : 'article: (no body available — only the title above)',
  ]
    .filter(value => value !== null)
    .join('\n')
}

/** What the article writer returns: the paragraph and the bullets the digest message is built from. */
export type ArticleSummary = z.infer<typeof summarySchema>

/**
 * Writes one winning article's summary. Retried; null when every attempt failed.
 *
 * The caller degrades to the article's own excerpt rather than throwing inside a
 * `Promise.all` that would lose every other message the beat won.
 */
export async function writeArticleSummary(mastra: Mastra, prompt: string): Promise<ArticleSummary | null> {
  const agent = mastra.getAgent(articleWriterId)
  return withRetry<ArticleSummary>(
    pipeline.modelAttempts,
    () => agent.generate(prompt, { structuredOutput: { schema: summarySchema } }),
    (attempt, error) =>
      mastra
        .getLogger()
        ?.warn(`Article writer attempt ${attempt}/${pipeline.modelAttempts} failed`, error),
  )
}
