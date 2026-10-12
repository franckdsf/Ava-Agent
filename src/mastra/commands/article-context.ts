import { verdictsForArticle } from '../../db/articles.js'
import { getBeat } from '../../db/beats.js'
import type { Article } from '../../db/types.js'
import { articleBody, capText } from '../../services/article.js'
import { quotedSource } from '../../services/quoted-article.js'
import { escapeMarkdown } from '../../services/telegram.js'

/**
 * What a slash command was pointed at, and how it names it.
 *
 * Split out of `commands/translate.ts` when `/summarize` appeared, for the same
 * reason `services/quoted-article.ts` was split out of Newy's inbound handler: two
 * commands answering the same swipe must not answer it differently. A reader who
 * swipes a digest and types `/translate`, then swipes the same digest and types
 * `/summarize`, is pointing at one article — so the body they get, and the
 * heading it arrives under, are decided here once.
 *
 * Read-only, like everything on this surface
 * ([invariant 8](../../../AGENTS.md#invariants)): it reads `articles` and
 * `beats`, may fetch a page the feed shipped no body for, and writes nothing.
 */

/**
 * The slash-command event, narrowed to what a command handler needs.
 *
 * `raw` is the untouched Telegram message the adapter passes straight through
 * (verified in `@chat-adapter/telegram` 4.35), which is the whole reason a
 * command works on a swipe: `reply_to_message` survives on it exactly as it does
 * on the message path. `text` is whatever the reader typed after the command,
 * and what that *means* is each command's own business — the text to translate
 * for `/translate`, the target language for `/summarize`.
 */
export interface SlashCommandEvent {
  command: string
  text: string
  raw: unknown
}

/**
 * Where the text came from, which decides how the message is titled.
 *
 * `emoji` is resolved here rather than looked up when the heading is rendered.
 * It used to come from a config array, which a synchronous `articleHeading`
 * could read for free; a beat is a row now, and making the heading async would
 * cost `renderTranslation` and `renderSummary` their purity — the property that
 * lets both be checked against the real format converter without sending
 * anything. Resolving it on the way in keeps the render pure and the lookup in
 * the one place that is already doing I/O.
 *
 * `subtopic` moved for the same reason and from the same place: it was a column
 * on the article until a story could belong to several beats, and it is now the
 * delivering beat's own label for it. Both are the delivering beat's view of the
 * article — which is the right one, since that is the beat whose tab the reader
 * swiped in.
 *
 * Both are null when the article was never delivered, or when its beat has since
 * been deleted outright. The heading simply carries no emoji then, and the
 * footer no subtopic.
 */
export type Source =
  | {
      kind: 'article'
      text: string
      article: Article
      emoji: string | null
      subtopic: string | null
    }
  | { kind: 'text'; text: string }

/**
 * The article behind a swipe-to-reply, or the quoted message's own text.
 *
 * The article is the case the commands exist for. The quoted text is the last
 * resort and a real one: an article whose body cannot be had still has a digest
 * summarizing it, and a reply Newy wrote is worth working on too.
 *
 * Returns undefined when the reader swiped nothing, or swiped something with no
 * text in it at all — the caller turns that into a usage message rather than
 * silence.
 */
export async function quotedArticleSource(
  raw: unknown,
  maxChars: number,
): Promise<Source | undefined> {
  const quoted = await quotedSource(raw)
  if (!quoted) return undefined

  if (quoted.article) {
    const body = await articleBody(quoted.article)
    const text = body.text ?? quoted.article.excerpt ?? quoted.quoted.text
    if (text.trim()) {
      const beatSlug = quoted.article.deliveredBeat
      const [emoji, subtopic] = await Promise.all([
        beatEmoji(beatSlug),
        beatSubtopic(quoted.article.id, beatSlug),
      ])
      return {
        kind: 'article',
        text: capText(text, maxChars),
        article: quoted.article,
        emoji,
        subtopic,
      }
    }
  }

  const text = quoted.quoted.text.trim()
  return text ? { kind: 'text', text: capText(text, maxChars) } : undefined
}

/** The emoji of the beat that sent an article, or null when nothing did. */
async function beatEmoji(slug: string | null): Promise<string | null> {
  if (!slug) return null
  return (await getBeat(slug))?.emoji ?? null
}

/**
 * The subtopic the delivering beat filed an article under.
 *
 * Several beats may have scored it and labelled it differently; only the one
 * that sent it is the label the reader saw on the message they swiped.
 */
async function beatSubtopic(articleId: string, slug: string | null): Promise<string | null> {
  if (!slug) return null
  const verdicts = await verdictsForArticle(articleId)
  return verdicts.find(verdict => verdict.beatSlug === slug)?.subtopic ?? null
}

/**
 * The linked title, carrying its beat's emoji the way a delivered article does.
 *
 * The one part of these messages the model is never allowed to write: a model
 * that emits its own markdown eventually emits a broken link, and the URL is the
 * part that has to be exactly right.
 *
 * Stays synchronous and pure — see the note on `Source.emoji`.
 */
export function articleHeading(article: Article, emoji: string | null): string {
  return `## ${emoji ? `${emoji} ` : ''}[${escapeMarkdown(article.title)}](${article.link})`
}
