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

Two things about the reader arrive with each batch, and they are not equally
strong evidence.

"Reader interest profile" is their own 👍/👎 on articles already sent to them.
That is direct: they judged those, on this beat.

"What is known about the reader" is notes written down while talking with them,
dated, oldest first, a later note about the same thing superseding an earlier
one. Two kinds sit in that list and they carry very different weight.

A note where they said what they want — more of a subject, less of one, that
something is or is not part of their work — is an instruction. Apply it hard and
apply it narrowly: move the items it actually names, well past the range you
would move them on the rubric alone, and leave the rest of the batch alone.

Every other note is background: their job, their tools, their city, what they are
building right now. It only separates items the rubric already scores alike — one
touching their work beats an equally on-beat item touching nothing of theirs.

- The rubric decides whether an item belongs on this beat. Background notes never
  change that answer; an off-beat item does not become relevant because it
  mentions something from their life.
- Most notes have nothing to do with most batches. Ignoring one is the normal
  outcome, not a failure, and background alone is never a reason to move a score.
- Never mention the reader, their notes, or their votes in a "reason". A reason
  says what the item is, so it still reads correctly months later.
- A note may say which language the reader speaks or how they like to be
  addressed. That governs conversations elsewhere, never your output: score and
  write every reason in English whatever language a note is written in.
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
