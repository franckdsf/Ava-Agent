import type { ChannelHandler } from '@mastra/core/channels'
import type { Article } from '../db/types.js'
import { quotedSource } from '../services/quoted-article.js'
import type { QuotedMessage } from '../services/telegram-reply.js'

/**
 * The inbound half of the tab split: Newy only ever speaks in the Chat tab.
 *
 * [ADR-0010](../../docs/decisions/0010-ava-answers-only-in-the-chat-tab.md).
 * Two separate things had to be built for that, because Telegram messages reach
 * the agent by two different paths:
 *
 * - **Ordinary messages** arrive as a Chat SDK direct message, and the default
 *   handler answers in whichever thread they came from. `routeToChatTab` swaps
 *   the thread for the Chat tab's before handing it on.
 * - **Anything starting with `/`** never reaches the agent at all. Verified in
 *   `@chat-adapter/telegram` 4.35: `handleSlashCommandUpdate` claims any message
 *   whose first entity is a `bot_command` and returns `true`, which makes
 *   `processUpdate` skip `handleIncomingMessageUpdate` entirely — and with no
 *   `onSlashCommand` handler registered, the Chat SDK iterates an empty handler
 *   list and drops it. `/start` was silently doing nothing.
 *
 * `withQuotedMessage` wraps the first of those; the second is `registrar.ts`. A swipe-to-reply is the only way
 * to point at a specific digest, and the message it points at reaches the process
 * but not the model — see [ADR-0013](../../docs/decisions/0013-swipe-to-reply-as-article-context.md).
 */

/** The message type a channel handler is handed, without importing the Chat SDK. */
type InboundMessage = Parameters<ChannelHandler>[1]

/** One line of the context note, and whether it belongs inside the quote. */
type NoteLine = { text: string; quoted?: boolean }

/**
 * Puts the message a reader swiped-to-reply on in front of their question.
 *
 * Telegram's reply is the only way to say *that one* about a digest that scrolled
 * past hours ago, and none of it survives to the model on its own: the agent is
 * handed the reply's own text and nothing else. This prepends what they pointed
 * at, hedged — a reply is a gesture, not necessarily the subject of the question,
 * and a note that insists otherwise makes her answer about the wrong thing.
 *
 * When the quoted message carries a link to a stored article, the note names the
 * article's id outright. That is free precision: the id *is* a hash of the
 * canonical link ([invariant 5](../../AGENTS.md#invariants)), so a URL she can
 * see is an id she can read, and she calls `read-article` instead of searching
 * for words that may not be in the piece.
 *
 * Read-only throughout, so [invariant 8](../../AGENTS.md#invariants) holds: one
 * primary-key lookup per link, nothing written.
 */
export function withQuotedMessage(handler: ChannelHandler): ChannelHandler {
  return async (thread, message, defaultHandler) => {
    const source = await quotedSource(message.raw)
    if (!source) return handler(thread, message, defaultHandler)

    const lines = noteLines(source.quoted, source.article)
    return handler(thread, withContext(message, lines), defaultHandler)
  }
}

function noteLines(quoted: QuotedMessage, article: Article | null): NoteLine[] {
  const lines: NoteLine[] = [
    {
      text:
        'The reader is replying to an earlier message, quoted below. It may or may ' +
        'not be what they are asking about — treat it as context, and use it only ' +
        'where their question needs it.',
    },
    // Blank lines would stringify as empty blockquote paragraphs.
    ...quoted.text
      .split('\n')
      .filter(text => text.trim())
      .map(text => ({ text, quoted: true })),
  ]

  if (quoted.fragment) {
    lines.push({ text: `They highlighted this part of it: "${quoted.fragment}"` })
  }

  if (article) {
    lines.push({
      text:
        `That message is a stored article — "${article.title}" (${article.source}). ` +
        `Call "read-article" with id ${article.id} before answering anything about it.`,
    })
  }

  return lines
}

/**
 * Returns a copy of the message with the note in front of what the reader typed.
 *
 * A copy, not a mutation, because the adapter caches the message object it
 * parsed *before* handing it over (`cacheMessage` in `dist/index.js`) — editing
 * it in place would rewrite what the cache holds.
 *
 * Both representations are set from one source. `formatted` is the one that
 * matters: Mastra builds the model's input as `stringifyMarkdown(formatted) ||
 * text`, so a note written only to `text` is silently dropped whenever the
 * adapter parsed an AST, which it always does.
 */
function withContext(message: InboundMessage, lines: NoteLine[]): InboundMessage {
  const clone: InboundMessage = Object.assign(Object.create(Object.getPrototypeOf(message)), message)
  clone.text = [...lines.map(line => (line.quoted ? `> ${line.text}` : line.text)), message.text]
    .filter(Boolean)
    .join('\n\n')
  if (message.formatted) {
    clone.formatted = {
      ...message.formatted,
      children: [...noteBlocks(lines), ...message.formatted.children],
    }
  }
  return clone
}

/** The note as mdast, with consecutive quoted lines folded into one blockquote. */
function noteBlocks(lines: NoteLine[]): InboundMessage['formatted']['children'] {
  const paragraph = (value: string) => ({
    type: 'paragraph' as const,
    children: [{ type: 'text' as const, value }],
  })

  const blocks: InboundMessage['formatted']['children'] = []
  for (const line of lines) {
    if (!line.quoted) {
      blocks.push(paragraph(line.text))
      continue
    }
    const previous = blocks.at(-1)
    if (previous?.type === 'blockquote') previous.children.push(paragraph(line.text))
    else blocks.push({ type: 'blockquote', children: [paragraph(line.text)] })
  }
  return blocks
}
