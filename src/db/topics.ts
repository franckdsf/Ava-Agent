import { and, eq } from 'drizzle-orm'
import { db, migrate } from './client.js'
import { telegramTopics } from './schema.js'

/**
 * Provisioned tabs, keyed by `(botId, chatId, slug)`.
 *
 * Every function here takes the bot as well as the chat. A chat id alone does
 * not identify a conversation: in a private chat Telegram's `chat.id` is the
 * *user's* id, so two bots talking to the same person see the same value and
 * would share rows. See the note on `telegramTopics` in `schema.ts` for what
 * that broke.
 */

/** What was provisioned for one topic: Telegram's id, and the name we gave it. */
export interface ProvisionedTopic {
  messageThreadId: number
  /** Null for rows written before names were tracked — the name is unknown, not empty. */
  name: string | null
}

/** Provisioned topics for one bot in one chat, keyed by slug. */
export async function topicIds(
  botId: string,
  chatId: string,
): Promise<Record<string, ProvisionedTopic>> {
  await migrate()
  const rows = await db()
    .select({
      slug: telegramTopics.slug,
      messageThreadId: telegramTopics.messageThreadId,
      name: telegramTopics.name,
    })
    .from(telegramTopics)
    .where(and(eq(telegramTopics.botId, botId), eq(telegramTopics.chatId, chatId)))
  return Object.fromEntries(
    rows.map(row => [row.slug, { messageThreadId: row.messageThreadId, name: row.name }]),
  )
}

/** Upsert, because re-provisioning after a topic is deleted must replace the id. */
export async function rememberTopic(
  botId: string,
  chatId: string,
  slug: string,
  messageThreadId: number,
  name: string,
): Promise<void> {
  await migrate()
  await db()
    .insert(telegramTopics)
    .values({ botId, chatId, slug, messageThreadId, name, createdAt: Date.now() })
    .onConflictDoUpdate({
      target: [telegramTopics.botId, telegramTopics.chatId, telegramTopics.slug],
      set: { messageThreadId, name, createdAt: Date.now() },
    })
}

/**
 * Records a rename, leaving the id and the original `createdAt` alone.
 *
 * Separate from `rememberTopic` because the two answer different questions: that
 * one means "this tab now exists with this id", this one means "Telegram has
 * accepted the new name". Folding them together would reset `createdAt` on every
 * title edit.
 */
export async function renameTopic(
  botId: string,
  chatId: string,
  slug: string,
  name: string,
): Promise<void> {
  await migrate()
  await db()
    .update(telegramTopics)
    .set({ name })
    .where(
      and(
        eq(telegramTopics.botId, botId),
        eq(telegramTopics.chatId, chatId),
        eq(telegramTopics.slug, slug),
      ),
    )
}

/** Drops a row whose topic no longer exists, so the next run re-creates it. */
export async function forgetTopic(
  botId: string,
  chatId: string,
  slug: string,
): Promise<void> {
  await migrate()
  await db()
    .delete(telegramTopics)
    .where(
      and(
        eq(telegramTopics.botId, botId),
        eq(telegramTopics.chatId, chatId),
        eq(telegramTopics.slug, slug),
      ),
    )
}
