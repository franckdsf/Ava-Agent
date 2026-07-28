import { and, eq } from 'drizzle-orm'
import { db, migrate } from './client.js'
import { telegramTopics } from './schema.js'

/** What was provisioned for one topic: Telegram's id, and the name we gave it. */
export interface ProvisionedTopic {
  messageThreadId: number
  /** Null for rows written before names were tracked — the name is unknown, not empty. */
  name: string | null
}

/** Provisioned topics for one chat, keyed by slug. */
export async function topicIds(chatId: string): Promise<Record<string, ProvisionedTopic>> {
  await migrate()
  const rows = await db()
    .select({
      slug: telegramTopics.slug,
      messageThreadId: telegramTopics.messageThreadId,
      name: telegramTopics.name,
    })
    .from(telegramTopics)
    .where(eq(telegramTopics.chatId, chatId))
  return Object.fromEntries(
    rows.map(row => [row.slug, { messageThreadId: row.messageThreadId, name: row.name }]),
  )
}

/** Upsert, because re-provisioning after a topic is deleted must replace the id. */
export async function rememberTopic(
  chatId: string,
  slug: string,
  messageThreadId: number,
  name: string,
): Promise<void> {
  await migrate()
  await db()
    .insert(telegramTopics)
    .values({ chatId, slug, messageThreadId, name, createdAt: Date.now() })
    .onConflictDoUpdate({
      target: [telegramTopics.chatId, telegramTopics.slug],
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
export async function renameTopic(chatId: string, slug: string, name: string): Promise<void> {
  await migrate()
  await db()
    .update(telegramTopics)
    .set({ name })
    .where(and(eq(telegramTopics.chatId, chatId), eq(telegramTopics.slug, slug)))
}

/** Drops a row whose topic no longer exists, so the next run re-creates it. */
export async function forgetTopic(chatId: string, slug: string): Promise<void> {
  await migrate()
  await db()
    .delete(telegramTopics)
    .where(and(eq(telegramTopics.chatId, chatId), eq(telegramTopics.slug, slug)))
}
