import { Agent } from '@mastra/core/agent'
import { CATEGORIES, type CategoryDefinition } from '../../config/categories.js'
import { env } from '../../config/env.js'

/**
 * One implementation, parameterized per category — never one agent class per
 * beat. A category's expertise comes from its rubric (baked into instructions)
 * and its interest profile (recent 👍/👎, passed fresh in the prompt so it
 * can't go stale between restarts).
 *
 * Ranking and writing are separate agents on purpose: ranking sees hundreds of
 * items per run and must be cheap, writing sees a handful and must be good.
 */

export const rankerId = (slug: string) => `${slug}-ranker`
export const articleWriterId = (slug: string) => `${slug}-article-writer`

function createRanker(category: CategoryDefinition): Agent {
  return new Agent({
    id: rankerId(category.slug),
    name: `${category.title} Ranker`,
    model: env.AVA_MODEL_RSS_RANKER,
    instructions: `
You score news items for a single beat: ${category.title}.

${category.rubric}

For every item you are given, return:
- "id": echoed back exactly as provided. Never invent or alter an id.
- "score": 0-100 relevance against the rubric above.
- "subtopic": exactly one of: ${category.subtopics.join(', ')}.
- "reason": at most 15 words, concrete. Say what happened, not "this is relevant".

Rules:
- Score every item you are given. Never skip, merge, or reorder them.
- Judge the item on its own merits; scores are absolute, not a ranking against
  the rest of the batch. Most items in a normal batch should score below 50.
- When the interest profile shows the reader downvoting a pattern, penalize it.
  When it shows upvotes, reward that pattern. Recent votes matter more.
- A headline you cannot evaluate from the title and excerpt scores below 40.
`.trim(),
  })
}

function createArticleWriter(category: CategoryDefinition): Agent {
  return new Agent({
    id: articleWriterId(category.slug),
    name: `${category.title} Article Writer`,
    model: env.AVA_MODEL_RSS_SUMMARIZER,
    instructions: `
You summarize one article at a time for a reader following this beat:
${category.title}.

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
`.trim(),
  })
}

/** Every curator agent, keyed by id, ready to register on the Mastra instance. */
export const curatorAgents: Record<string, Agent> = Object.fromEntries(
  CATEGORIES.flatMap(category => [
    [rankerId(category.slug), createRanker(category)],
    [articleWriterId(category.slug), createArticleWriter(category)],
  ]),
)
