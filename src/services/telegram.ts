import { createTelegramAdapter } from '@chat-adapter/telegram'
import { allowedTelegramUserIds, telegramEnv } from '../config/env.js'
import { pipeline } from '../config/pipeline.js'
import type { TopicSlug } from '../config/topics.js'
import { invalidateTopic, resolveTopics } from './telegram-topics.js'

/**
 * Outbound Telegram only — the push half of the surface.
 *
 * `postMessage` never touches the adapter's `ChatInstance`; only the inbound
 * paths (`handleWebhook`, `startPolling`, and the `process*` handlers) do. That
 * was the open question in [ADR-0002](../../docs/decisions/0002-telegram-via-chat-sdk-adapter-in-polling-mode.md):
 * a cron fire has no incoming message to reply to. It was verified against the
 * compiled adapter and by sending, so the documented fallback to a second
 * Telegram library is not needed — this module and the conversational surface
 * share one adapter package.
 *
 * `mode` is deliberately unset: it selects webhook vs polling for *receiving*,
 * and this instance never receives. When the orchestrator lands it registers
 * its own adapter through `channels.adapters`, and only that one polls.
 */

let adapter: ReturnType<typeof createTelegramAdapter> | undefined

/** Built on first send so the news pipeline runs with Telegram unconfigured. */
function client(): ReturnType<typeof createTelegramAdapter> {
  adapter ??= createTelegramAdapter({
    botToken: telegramEnv().TELEGRAM_BOT_TOKEN,
    allowedUserIds: allowedTelegramUserIds(),
  })
  return adapter
}

/**
 * Backslash-escapes the characters that actually open inline markup, so a title
 * containing `*`, `_` or `[` renders literally instead of silently starting
 * emphasis and swallowing the rest of the message.
 *
 * Deliberately narrower than MarkdownV2's escape set. Telegram parses this as
 * markdown, where `.`, `-`, `+` and `#` are only meaningful at the start of a
 * block — escaping them inline is invisible when it works and produces
 * `kotlinx\.atomicfu` and `50\.7` when anything downstream doesn't unescape.
 * Version numbers and hyphenated words are far too common here to risk it.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>~|]/g, '\\$&')
}

/**
 * Splits on the widest boundary that fits, because the adapter *truncates* at
 * Telegram's 4096-character cap rather than splitting — a long digest would
 * lose its tail silently. Paragraphs first, then lines, then a hard slice.
 */
export function splitForTelegram(
  text: string,
  max: number = pipeline.telegramMaxMessageChars,
): string[] {
  const chunks: string[] = []
  let current = ''

  const flush = () => {
    if (current) chunks.push(current)
    current = ''
  }

  const append = (piece: string, separator: string) => {
    const candidate = current ? `${current}${separator}${piece}` : piece
    if (candidate.length <= max) {
      current = candidate
      return
    }
    flush()
    current = piece
  }

  for (const paragraph of text.split('\n\n')) {
    if (paragraph.length <= max) {
      append(paragraph, '\n\n')
      continue
    }
    for (const line of paragraph.split('\n')) {
      if (line.length <= max) {
        append(line, '\n')
        continue
      }
      flush()
      for (let index = 0; index < line.length; index += max) {
        chunks.push(line.slice(index, index + max))
      }
    }
  }

  flush()
  return chunks
}

/**
 * Memoized because `resolveTopics()` costs a `getMe` plus a table read, and a
 * digest calls it once per article. Topic ids are stable for the life of a
 * process — the only thing that changes them is a tab being deleted, which
 * `invalidateTopic` handles by clearing this alongside the row.
 */
let topicCache: Promise<Partial<Record<TopicSlug, number>>> | undefined

/**
 * Provisions the tabs if they don't exist yet, and returns their thread ids.
 *
 * The first caller pays for it, whoever that is — a digest, an inbound message,
 * or `/start`. Nothing schedules provisioning at boot on purpose: Telegram
 * rejects a `createForumTopic` against a chat the user has never started, so the
 * first *inbound* event is the earliest moment it can succeed.
 */
export function ensureTopics(): Promise<Partial<Record<TopicSlug, number>>> {
  topicCache ??= resolveTopics()
  return topicCache
}

/**
 * The adapter's thread id for a topic, or for the flat chat when topics are
 * unavailable. `encodeThreadId` is the adapter's own encoding
 * (`telegram:<chatId>[:<threadId>]`) — building that string by hand would break
 * the moment the adapter changes it.
 */
export async function topicThreadId(topic?: TopicSlug): Promise<string> {
  const chatId = telegramEnv().TELEGRAM_CHAT_ID
  if (!topic) return client().encodeThreadId({ chatId })
  const messageThreadId = (await ensureTopics())[topic]
  return client().encodeThreadId(
    messageThreadId === undefined ? { chatId } : { chatId, messageThreadId },
  )
}

/**
 * The chat a thread id belongs to, via the adapter's own decoder.
 *
 * Used by the inbound router to tell "a tab of the configured chat" from "some
 * other conversation" without parsing `telegram:<chatId>:<threadId>` by hand.
 * Decoding is pure, so borrowing this outbound instance costs nothing and keeps
 * the format in one place.
 */
export function chatIdFromThreadId(threadId: string): string {
  return client().decodeThreadId(threadId).chatId
}

/**
 * Sends to the configured digest chat, into `topic`'s tab when one exists.
 *
 * Chunks are sent in order and awaited individually so Telegram preserves
 * ordering; a mid-send failure throws with earlier chunks already delivered,
 * which the caller must treat as a partial send rather than a no-op.
 *
 * A tab deleted on the phone leaves its row behind and every send to it fails.
 * The first such failure drops the row and re-sends flat, so a digest still
 * arrives; the tab is recreated on the next run rather than mid-batch, which
 * would split one batch across two tabs.
 */
export async function sendToTelegram(text: string, topic?: TopicSlug): Promise<number> {
  const chunks = splitForTelegram(text)
  const threadId = await topicThreadId(topic)
  for (const [index, chunk] of chunks.entries()) {
    try {
      // `markdown` is the formatted path: Telegram parses it server-side into
      // rich blocks — headings, lists, photos — rather than applying a parse mode.
      await client().postMessage(threadId, { markdown: chunk })
    } catch (error) {
      // Only worth retrying flat on the first chunk. Past that the message is
      // already half-delivered into the tab and restarting it elsewhere would
      // duplicate what landed.
      if (!topic || index > 0) throw error
      await invalidateTopic(topic)
      topicCache = undefined
      return sendToTelegram(text)
    }
  }
  return chunks.length
}

/**
 * Sends an article, with its image when there is one.
 *
 * Telegram fetches the image URL itself and rejects anything unreachable, too
 * large, or the wrong shape — and it rejects the *whole message*, not just the
 * picture. Retrying without the image trades a decoration for the article,
 * which is the right way round. Only the first chunk carries the image; a split
 * message shouldn't repeat it.
 */
export async function sendArticle(
  text: string,
  imageUrl?: string | null,
  topic: TopicSlug = 'news',
): Promise<number> {
  if (!imageUrl) return sendToTelegram(text, topic)
  try {
    return await sendToTelegram(`![](${imageUrl})\n\n${text}`, topic)
  } catch {
    return sendToTelegram(text, topic)
  }
}
