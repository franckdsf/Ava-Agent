import type { Mastra } from '@mastra/core'
import type { AgentChannels, ChannelHandler } from '@mastra/core/channels'
import { CATEGORIES } from '../config/categories.js'
import { env, telegramChatId } from '../config/env.js'
import { pipeline } from '../config/pipeline.js'
import { TOPICS } from '../config/topics.js'
import {
  chatIdFromThreadId,
  ensureTopics,
  escapeMarkdown,
  sendToTelegram,
  topicThreadId,
} from '../services/telegram.js'

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
    `## Hi, I'm Ava`,
    `Two tabs, and they don't mix:`,
    `- **${TOPICS.chat.title}** — here. Talk to me.\n` +
      `- **${TOPICS.news.title}** — digests only, pushed on a schedule. I don't answer there.`,
    `Beats:`,
    beats,
    `Delivered at ${hours.join(', ')} ${env.AVA_TIMEZONE}, one message per article.`,
    `Ask me what came in, search everything I've ingested, or anything else entirely.`,
  ].join('\n\n')
}

/** Commands are swallowed before the agent sees them, so an unknown one needs its own reply. */
function unknown(command: string): string {
  return (
    `${escapeMarkdown(command)} isn't a command I know — I only have /start.\n\n` +
    `Just say it in plain words instead.`
  )
}
