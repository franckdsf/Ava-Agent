import { TOPIC_LIST, topicTabName, type TopicSlug } from '../config/topics.js'
import { telegramEnv } from '../config/env.js'
import { forgetTopic, rememberTopic, renameTopic, topicIds } from '../db/topics.js'

/**
 * Forum topics in the private chat — the tabs.
 *
 * `@chat-adapter/telegram` 4.35 routes *messages* to a topic (it folds
 * `messageThreadId` into its thread id and writes `message_thread_id` on every
 * send path), but it wraps no topic *lifecycle* method. So creation goes
 * straight to the Bot API here rather than through a second Telegram library.
 * See [docs/telegram-bot-api.md](../../docs/telegram-bot-api.md).
 *
 * Topics in private chats need Bot API 9.3/9.4 *and* Threaded Mode enabled in
 * BotFather. That toggle is not reachable from the API, so this module never
 * assumes it is on: `resolveTopics()` degrades to flat delivery instead of
 * failing, because a digest arriving in the wrong place beats no digest.
 */

interface BotApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

/**
 * Telegram answers 200 with `{ok: false}` for application errors, so checking
 * the HTTP status alone silently yields `undefined` and the failure surfaces
 * somewhere unrelated. Always read `ok`.
 */
async function callBotApi<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(
    `https://api.telegram.org/bot${telegramEnv().TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    },
  )
  const body = (await response.json()) as BotApiResponse<T>
  if (!body.ok) throw new Error(`${method} failed: ${body.description ?? 'unknown error'}`)
  return body.result as T
}

interface BotIdentity {
  id: number
  username?: string
  has_topics_enabled?: boolean
}

interface ChatInfo {
  type: string
  is_forum?: boolean
}

/** How this chat came to support topics — reported by `pnpm telegram:check`. */
export type TopicRoute = 'private-threaded-mode' | 'supergroup-forum' | 'unavailable'

/**
 * Whether the target chat can hold topics at all.
 *
 * Two *different* Telegram features share one wire format, and which flag
 * matters depends entirely on the chat type:
 *
 * - **Supergroup forum** (since 2022, universally available): the group has
 *   Topics switched on in its own settings, and `getChat` reports `is_forum`.
 * - **Private chat** (Bot API 9.3/9.4, 2026): the *bot* has Threaded Mode
 *   enabled in BotFather, reported as `has_topics_enabled` on `getMe` — not on
 *   the chat partner, and not on `getChat`. Verified by probe 2026-07-27.
 *
 * Checking only the private-chat flag silently disables tabs in a group, which
 * is the fallback for anyone who can't reach the BotFather toggle.
 */
export async function topicRoute(): Promise<TopicRoute> {
  const chat = await callBotApi<ChatInfo>('getChat', {
    chat_id: telegramEnv().TELEGRAM_CHAT_ID,
  })
  if (chat.type === 'supergroup' || chat.type === 'group') {
    return chat.is_forum === true ? 'supergroup-forum' : 'unavailable'
  }
  const me = await callBotApi<BotIdentity>('getMe')
  return me.has_topics_enabled === true ? 'private-threaded-mode' : 'unavailable'
}

interface ForumTopic {
  message_thread_id: number
  name: string
}

/**
 * Ensures every topic in `TOPICS` exists and is named what config says, and
 * returns the thread ids by slug.
 *
 * Returns an empty map when topics are unavailable — Threaded Mode off, or an
 * older Bot API. Callers treat that as "send flat".
 *
 * Creation is not idempotent on Telegram's side: calling `createForumTopic`
 * twice makes two identically-named tabs. The persisted id is therefore the
 * authority, and a topic is only created when no row exists for it.
 */
export async function resolveTopics(): Promise<Partial<Record<TopicSlug, number>>> {
  const chatId = telegramEnv().TELEGRAM_CHAT_ID

  if ((await topicRoute()) === 'unavailable') return {}

  const known = await topicIds(chatId)
  const resolved: Record<string, number> = {}

  for (const topic of TOPIC_LIST) {
    const name = topicTabName(topic)
    const existing = known[topic.slug]
    if (existing !== undefined) {
      resolved[topic.slug] = existing.messageThreadId
      if (existing.name !== name) {
        await callBotApi('editForumTopic', {
          chat_id: chatId,
          message_thread_id: existing.messageThreadId,
          name,
        })
        await renameTopic(chatId, topic.slug, name)
      }
      continue
    }
    const created = await callBotApi<ForumTopic>('createForumTopic', {
      chat_id: chatId,
      name,
      ...(topic.iconCustomEmojiId ? { icon_custom_emoji_id: topic.iconCustomEmojiId } : {}),
    })
    await rememberTopic(chatId, topic.slug, created.message_thread_id, name)
    resolved[topic.slug] = created.message_thread_id
  }

  return resolved
}

/**
 * Forgets a topic whose id Telegram has rejected, so the next run re-creates it.
 *
 * Deleting a tab on the phone leaves the row behind, and every later send to it
 * fails identically. Callers that catch a send failure call this and retry flat;
 * self-healing on the *next* run is deliberate — recreating a tab mid-digest
 * would scatter one batch across two tabs.
 */
export async function invalidateTopic(slug: TopicSlug): Promise<void> {
  await forgetTopic(telegramEnv().TELEGRAM_CHAT_ID, slug)
}
