import type { Mastra } from '@mastra/core'
import type { AgentChannels, ChannelHandler } from '@mastra/core/channels'
import { BEAT_COMMANDS } from '../config/beat-commands.js'
import { env, telegramChatId } from '../config/env.js'
import { activeBeats } from '../db/beats.js'
import { pipeline } from '../config/pipeline.js'
import { summary } from '../config/summary.js'
import { TOPICS } from '../config/topics.js'
import { TRANSLATIONS } from '../config/translation.js'
import type { Article } from '../db/types.js'
import { quotedSource } from '../services/quoted-article.js'
import {
  chatIdFromThreadId,
  ensureTopics,
  escapeMarkdown,
  sendToTelegram,
  topicThreadId,
} from '../services/telegram.js'
import type { QuotedMessage } from '../services/telegram-reply.js'
import { publishCommands } from '../services/telegram-topics.js'
import { isBeatCommand, runBeatCommand } from './commands/beats.js'
import { isSummaryCommand, runSummary } from './commands/summarize.js'
import { isTranslationCommand, runTranslation } from './commands/translate.js'

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

  // A catch-all rather than a per-command filter: an unhandled command is
  // invisible to the reader, which is the bug this whole handler exists to fix.
  // Every branch below therefore ends in a message, including the failures.
  sdk.onSlashCommand(async event => {
    await ensureTopics()

    if (isTranslationCommand(event.command)) {
      // Answers in the Translations tab, wherever it was typed — a translated
      // article is several messages and would bury the conversation
      // ([invariant 9](../../AGENTS.md#invariants)). It sends its own messages,
      // as each part of the article comes back.
      await runTranslation(mastra, event, event.command)
      return
    }

    if (isSummaryCommand(event.command)) {
      // Answers in Chat, unlike the translation commands: a summary is one
      // short message, which is the size of thing Chat is for. Sends its own
      // messages — an acknowledgement, then the summary.
      await runSummary(mastra, event)
      return
    }

    if (isBeatCommand(event.command)) {
      // The only commands that write, and they write configuration only —
      // `beats` and `beat_feeds`. See the restated
      // [invariant 8](../../AGENTS.md#invariants). Answers in Chat: each one is
      // a single short message. Sends its own message, including on failure.
      await runBeatCommand(mastra, event, event.command)
      return
    }

    await sendToTelegram(
      event.command === '/start' ? await welcome() : unknown(event.command),
      'chat',
    )
  })

  // The menu Telegram offers when the reader types `/`. Fire-and-forget and
  // deliberately after the handler is registered: a failure here costs the menu,
  // never the commands themselves, and a command that is typed still runs.
  void publishCommands(commandMenu()).catch(error => {
    mastra.getLogger()?.error('Failed to publish the Telegram command menu', error)
  })
}

/**
 * Every command, in the order the menu should show them.
 *
 * Built from the same config the help text is, so a command cannot be offered by
 * the menu and unknown to `/start`, or the reverse. Reading, then managing:
 * a reader scrolling this list is far more often looking for `/summarize` than
 * for `/removefeed`.
 */
function commandMenu(): { command: string; description: string }[] {
  return [
    { command: '/start', description: 'What I do, and how to talk to me' },
    { command: summary.command, description: summary.menuDescription },
    ...Object.entries(TRANSLATIONS).map(([command, definition]) => ({
      command,
      description: definition.menuDescription,
    })),
    ...Object.entries(BEAT_COMMANDS).map(([command, definition]) => ({
      command,
      description: definition.description,
    })),
  ]
}

/**
 * One line per command, for `/start` and for the unknown-command reply.
 *
 * Split in two because the list has outgrown a flat bullet run: reading commands
 * work on an article you swiped, beat commands work on the pipeline itself, and
 * a reader hunting for one is never hunting through the other group. Both halves
 * come from the same config the Telegram menu is built from, so a command cannot
 * be offered in one place and unknown in the other.
 */
function commandList(): string {
  return [
    '**Reading**',
    '- `/start` — this message.',
    `- \`${summary.command}\` — ${summary.help}`,
    ...Object.entries(TRANSLATIONS).map(
      ([command, definition]) => `- \`${command}\` — ${definition.help}`,
    ),
    '',
    '**Beats**',
    ...Object.entries(BEAT_COMMANDS).map(
      ([command, definition]) => `- \`${command}\` — ${definition.help}`,
    ),
  ].join('\n')
}

/**
 * What `/start` answers with — and the only place the three tabs are explained.
 *
 * Built from the live beats and from config, so a new beat, a changed schedule
 * or a new command can't leave a stale description here
 * ([invariant 3](../../AGENTS.md#invariants)).
 *
 * Async now, because the beats it lists are rows rather than a config array. It
 * is still exported for the reason `renderTranslation` and `renderSummary` are:
 * it sends nothing, so it is the only way to check the message without sending
 * one. A single newline inside any entry below is a soft wrap that collapses two
 * blocks into one run-on line, which is invisible in code and obvious through
 * `formatConverter.toAst()`.
 */
export async function welcome(): Promise<string> {
  const live = await activeBeats()
  // A reader whose beats are all archived, or a database seeded with none, gets
  // an invitation rather than an empty bullet list under a "Beats:" heading.
  const beats =
    live.length > 0
      ? live.map(beat => `- ${beat.emoji} ${beat.title}`).join('\n')
      : "- Nothing yet — tell me a subject to follow and I'll set one up."
  const hours = pipeline.digestHours.map(hour => `${String(hour).padStart(2, '0')}:00`)

  return [
    `## Hi, I'm Ava 😊`,
    `I'm here to help you keep up with the topics you care about. Use the ${TOPICS.chat.title} tab to talk with me directly — every other tab is one I push to and don't answer in, so what you're reading stays tidy.`,
    `What I do:`,
    `- **${TOPICS.chat.title}** — chat with me about anything, ask for details, or follow up on an article 📰.\n` +
    `- I keep our conversation in one place so your context stays intact.`,
    `- **One tab per beat** — each subject you follow gets its own 📅, and its digests go there and nowhere else.`,
    `- **${TOPICS.translations.title}** — where ${Object.keys(TRANSLATIONS).join(' and ')} put an article once you've asked for it 📜.`,
    `Beats:`,
    beats,
    `A beat's tab appears the first time it has something to send you, so a brand new one is quiet until then. \`/pause\` closes a tab without deleting anything in it, and \`/resume\` opens it again.`,
    `Digests arrive at ${hours.join(', ')} ${env.AGENT_TIMEZONE}. Each article is delivered as its own message so you can read or save what matters.`,
    `Commands:`,
    commandList(),
    `The reading commands work on a swipe: reply to any article and send \`${summary.command}\`, \`/why\` or a translation on its own. The beat commands don't need one — they take a slug, and \`/beats\` lists them.`,
    `\`/why\` is the one worth knowing about: every beat scores every article it sees and writes down what it made of it, so you can swipe something and ask why it arrived — or swipe one I skipped and see what it scored.`,
    `${Object.keys(TRANSLATIONS).map(command => `\`${command}\``).join(' and ')} answer in your own language, with the English kept in view, in the ${TOPICS.translations.title} tab — a long article arrives as several messages over a few minutes.`,
    `\`${summary.command}\` answers here in ${TOPICS.chat.title}, as one message: the article explained properly rather than compressed. It writes in ${summary.defaultLanguage} unless you name a language after it — \`${summary.command} fr\`, \`${summary.command} ru\`, or the language's own name.`,
    `If you want something specific, just ask — search the archive, show me a recent article, or tell me what interests you 😉.`,
  ].join('\n\n')
}

/** Commands are swallowed before the agent sees them, so an unknown one needs its own reply. */
export function unknown(command: string): string {
  return [
    `${escapeMarkdown(command)} isn't a command I know. What I have:`,
    commandList(),
    `For anything else, just say it in plain words.`,
  ].join('\n\n')
}
