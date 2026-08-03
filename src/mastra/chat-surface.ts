import type { AgentChannels, ChannelHandler } from '@mastra/core/channels'
import type { BotDefinition } from '../config/bots.js'
import { telegramChatId } from '../config/env.js'
import type { TelegramTransport } from '../services/telegram.js'

/**
 * The inbound half of the tab split, shared by every agent that talks.
 *
 * One agent, one bot, one chat, and inside that chat exactly one tab it answers
 * in ([invariant 9](../../AGENTS.md#invariants)). Newy answers in her Chat tab
 * and Joob in its own; the mechanics are identical, so they live here rather
 * than being written twice
 * ([ADR-0023](../../docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)).
 *
 * What is *not* here is anything about what an agent does with a message.
 * `withQuotedMessage` stays in `channels.ts` because it resolves an **article**
 * from a swipe, which is Newy's alone — Joob will want the job-shaped equivalent
 * and it will not be the same function.
 */

/** Everything routing needs to know about one agent's Telegram surface. */
export interface ChatSurface<Slug extends string> {
  bot: BotDefinition<Slug>
  transport: TelegramTransport<Slug>
  /** The slug of the one tab this agent answers in. */
  chatTab: Slug
}

/**
 * Sends every inbound message to this agent's chat tab, wherever it was typed.
 *
 * Swapping the thread rather than refusing to answer elsewhere keeps one
 * conversation: the Mastra thread is keyed on the thread id we pass, so memory
 * stays on the chat tab instead of forking per tab the reader wanders into.
 *
 * Degrades to the default handler — answer in place — for anything it can't
 * redirect: another chat, an unconfigured chat id, or topics unavailable (the
 * chat tab resolves to the flat chat, which is where the message already is).
 *
 * Cross-agent traffic is not a case this has to handle. Each agent registers its
 * own adapter against its own token, so a message sent to Joob's bot is never
 * offered to Newy's handlers at all; the chat-id check below is about telling
 * *this* bot's chat from some other conversation it has been added to.
 */
export function routeToChatTab<Slug extends string>(
  surface: ChatSurface<Slug>,
  channels: () => AgentChannels | null | undefined,
): ChannelHandler {
  return async (thread, message, defaultHandler) => {
    const target = await chatTabFor(surface, thread.id)
    if (!target || target === thread.id) return defaultHandler(thread, message)

    const sdk = channels()?.sdk
    if (!sdk) return defaultHandler(thread, message)

    // `sdk.thread()` is the documented way to get a Thread outside an inbound
    // event. It rebuilds everything the default handler reads off it — DM flag,
    // channel id, state — from the id alone.
    return defaultHandler(sdk.thread(target), message)
  }
}

/** This agent's chat tab thread id, or undefined when the thread isn't its to move. */
async function chatTabFor<Slug extends string>(
  surface: ChatSurface<Slug>,
  threadId: string,
): Promise<string | undefined> {
  const chatId = telegramChatId(surface.bot)
  if (!chatId || surface.transport.chatIdFromThreadId(threadId) !== chatId) return undefined
  return surface.transport.topicThreadId(surface.chatTab)
}
