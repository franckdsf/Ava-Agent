import { CATEGORIES } from '../../config/categories.js'
import type { Item } from '../../db/types.js'
import { articleBody, capText } from '../../services/article.js'
import { quotedSource } from '../../services/quoted-article.js'
import { escapeMarkdown } from '../../services/telegram.js'

/**
 * What a slash command was pointed at, and how it names it.
 *
 * Split out of `commands/translate.ts` when `/summarize` appeared, for the same
 * reason `services/quoted-article.ts` was split out of `channels.ts`: two
 * commands answering the same swipe must not answer it differently. A reader who
 * swipes a digest and types `/translate`, then swipes the same digest and types
 * `/summarize`, is pointing at one article — so the body they get, and the
 * heading it arrives under, are decided here once.
 *
 * Read-only, like everything on this surface
 * ([invariant 8](../../../AGENTS.md#invariants)): it reads `items`, may fetch a
 * page the feed shipped no body for, and writes nothing.
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

/** Where the text came from, which decides how the message is titled. */
export type Source =
  | { kind: 'article'; text: string; article: Item }
  | { kind: 'text'; text: string }

/**
 * The article behind a swipe-to-reply, or the quoted message's own text.
 *
 * The article is the case the commands exist for. The quoted text is the last
 * resort and a real one: an article whose body cannot be had still has a digest
 * summarizing it, and a reply Ava wrote is worth working on too.
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
      return { kind: 'article', text: capText(text, maxChars), article: quoted.article }
    }
  }

  const text = quoted.quoted.text.trim()
  return text ? { kind: 'text', text: capText(text, maxChars) } : undefined
}

/**
 * The linked title, carrying its beat's emoji the way a delivered article does.
 *
 * The one part of these messages the model is never allowed to write: a model
 * that emits its own markdown eventually emits a broken link, and the URL is the
 * part that has to be exactly right.
 */
export function articleHeading(article: Item): string {
  const emoji = CATEGORIES.find(category => category.slug === article.categorySlug)?.emoji
  return `## ${emoji ? `${emoji} ` : ''}[${escapeMarkdown(article.title)}](${article.link})`
}
