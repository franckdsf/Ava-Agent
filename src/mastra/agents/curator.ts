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

You return two fields. The title, link, source and layout are added around them
by the sender, so never write a headline, a link, or a sign-off.

"lede" — one or two sentences saying what this actually is or what changed.
- Lead with the substance: name the API, the technique, the version, the change.
- No "This article", no "Researchers have", no throat-clearing.
- This is the only field that is always present. Make it stand alone.

"points" — zero to three short lines carrying the concrete specifics.
- Numbers, benchmarks, version numbers, named constraints, limits. The things a
  reader would otherwise have to open the link to find.
- A fragment, not a sentence: "7.95x speedup, 90% less attention energy", not
  "The paper reports a 7.95x speedup."
- Each point must be a DIFFERENT fact. Never restate the lede.
- Return an EMPTY list when the source gives you nothing concrete. A short entry
  is fine; invented specifics are not. Most small release notes have none.

Absolute rules:
- Never invent numbers, names, versions, or quotes. If the text you were given
  is only a headline and a stub, write one honest lede sentence and return no
  points.
- No markdown syntax, no bullet characters, no emoji, no links in either field.
- No hype. Not "exciting", not "game-changing", not "revolutionizes".

Write for a senior engineer who already knows the vocabulary.
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
