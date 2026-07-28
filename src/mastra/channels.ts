import type { Mastra } from '@mastra/core'
import type { AgentChannels, ChannelHandler } from '@mastra/core/channels'
import { CATEGORIES } from '../config/categories.js'
import { env, telegramChatId } from '../config/env.js'
import { pipeline } from '../config/pipeline.js'
import { TOPICS } from '../config/topics.js'
import type { Item } from '../db/types.js'
import { itemForLink } from '../services/rss.js'
import {
  chatIdFromThreadId,
  ensureTopics,
  escapeMarkdown,
  sendToTelegram,
  topicThreadId,
} from '../services/telegram.js'
import { type QuotedMessage, quotedMessage } from '../services/telegram-reply.js'

/**
 * The inbound half of the tab split: Ava only ever speaks in the Chat tab.
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
 * `withQuotedMessage` wraps the first of those. A swipe-to-reply is the only way
 * to point at a specific digest, and the message it points at reaches the process
 * but not the model — see [ADR-0013](../../docs/decisions/0013-swipe-to-reply-as-article-context.md).
 */

/**
 * Sends every inbound message to the Chat tab, wherever it was typed.
 *
 * Swapping the thread rather than refusing to answer elsewhere keeps one
 * conversation: the Mastra thread is keyed on the thread id we pass, so memory
 * stays on the Chat tab instead of forking per tab the reader wanders into.
 *
 * Degrades to the default handler — answer in place — for anything it can't
 * redirect: another chat, an unconfigured chat id, or topics unavailable (the
 * Chat tab resolves to the flat chat, which is where the message already is).
 */
export function routeToChatTab(
  channels: () => AgentChannels | null | undefined,
): ChannelHandler {
  return async (thread, message, defaultHandler) => {
    const target = await chatTabFor(thread.id)
    if (!target || target === thread.id) return defaultHandler(thread, message)

    const sdk = channels()?.sdk
    if (!sdk) return defaultHandler(thread, message)

    // `sdk.thread()` is the documented way to get a Thread outside an inbound
    // event. It rebuilds everything the default handler reads off it — DM flag,
    // channel id, state — from the id alone.
    return defaultHandler(sdk.thread(target), message)
  }
}

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
    const quoted = quotedMessage(message.raw)
    if (!quoted) return handler(thread, message, defaultHandler)

    const lines = noteLines(quoted, await quotedArticle(quoted.links))
    return handler(thread, withContext(message, lines), defaultHandler)
  }
}

/**
 * The stored article a quoted message points at, if any.
 *
 * First hit wins: a digest carries exactly one link and it is the article's, so
 * anything after it is a link Ava wrote into a later message. How a URL becomes
 * a row is `itemForLink`'s business, not this module's — all that is decided
 * here is how many of a quoted message's links are worth trying.
 */
async function quotedArticle(links: string[]): Promise<Item | null> {
  for (const link of links.slice(0, pipeline.quotedLinkLookups)) {
    const item = await itemForLink(link)
    if (item) return item
  }
  return null
}

function noteLines(quoted: QuotedMessage, article: Item | null): NoteLine[] {
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

/** The Chat tab's thread id, or undefined when this thread isn't ours to move. */
async function chatTabFor(threadId: string): Promise<string | undefined> {
  const chatId = telegramChatId()
  if (!chatId || chatIdFromThreadId(threadId) !== chatId) return undefined
  return topicThreadId('chat')
}

/**
 * Registers the slash commands, once the Chat SDK instance exists.
 *
 * `channels.sdk` is null until `initialize()` resolves, and Mastra starts that
 * itself while registering the agent — so this awaits the same promise rather
 * than starting a second one (`initialize` returns the in-flight one). The
 * argument is ignored on that path; it is passed for the case where this call
 * somehow gets there first.
 *
 * There is a sliver of a window between polling starting and this landing, in
 * which a `/start` is dropped. That is the status quo for every command today,
 * and it closes on the next one.
 */
export async function registerChatCommands(
  mastra: Mastra,
  channels: AgentChannels | null,
): Promise<void> {
  if (!channels) return
  await channels.initialize(mastra)
  const sdk = channels.sdk
  if (!sdk) return

  // A catch-all rather than a `/start` filter: an unhandled command is invisible
  // to the reader, which is the bug this whole handler exists to fix.
  sdk.onSlashCommand(async event => {
    await ensureTopics()
    await sendToTelegram(event.command === '/start' ? welcome() : unknown(event.command), 'chat')
  })
}

/**
 * What `/start` answers with — and the only place the two tabs are explained.
 *
 * Built from config so a new beat or a changed schedule can't leave a stale
 * description here ([invariant 3](../../AGENTS.md#invariants)).
 */
function welcome(): string {
  const beats = CATEGORIES.map(category => `- ${category.emoji} ${category.title}`).join('\n')
  const hours = pipeline.digestHours.map(hour => `${String(hour).padStart(2, '0')}:00`)

  return [
    `## Hi, I'm Ava 😊`,
    `I'm here to help you keep up with the topics you care about. Use the Chat tab to talk with me directly and the News tab to receive scheduled digests — I won't reply in News so the digests stay tidy.`,
    `What I do:`,
    `- **${TOPICS.chat.title}** — chat with me about anything, ask for details, or follow up on an article 📰.\n` +
    `- I keep our conversation in one place so your context stays intact.`,
    `- **${TOPICS.news.title}** — I push curated digests on a schedule 📅; I don't answer there.`,
    `Beats:`,
    beats,
    `Digests arrive at ${hours.join(', ')} ${env.AVA_TIMEZONE}. Each article is delivered as its own message so you can read or save what matters.`,
    `If you want something specific, just ask — search the archive, show me a recent article, or tell me what interests you 😉.`,
  ].join('\n\n')
}

/** Commands are swallowed before the agent sees them, so an unknown one needs its own reply. */
function unknown(command: string): string {
  return (
    `${escapeMarkdown(command)} isn't a command I know — I only have /start.\n\n` +
    `Just say it in plain words instead.`
  )
}
