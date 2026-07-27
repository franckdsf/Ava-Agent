import { and, eq } from 'drizzle-orm'
import { db, migrate } from './client.js'
import { telegramTopics } from './schema.js'

/** Provisioned topic ids for one chat, keyed by slug. */
export async function topicIds(chatId: string): Promise<Record<string, number>> {
  await migrate()
  const rows = await db()
    .select({ slug: telegramTopics.slug, messageThreadId: telegramTopics.messageThreadId })
    .from(telegramTopics)
    .where(eq(telegramTopics.chatId, chatId))
  return Object.fromEntries(rows.map(row => [row.slug, row.messageThreadId]))
}

/** Upsert, because re-provisioning after a topic is deleted must replace the id. */
export async function rememberTopic(
  chatId: string,
  slug: string,
  messageThreadId: number,
): Promise<void> {
  await migrate()
  await db()
    .insert(telegramTopics)
    .values({ chatId, slug, messageThreadId, createdAt: Date.now() })
    .onConflictDoUpdate({
      target: [telegramTopics.chatId, telegramTopics.slug],
      set: { messageThreadId, createdAt: Date.now() },
    })
}

/** Drops a row whose topic no longer exists, so the next run re-creates it. */
export async function forgetTopic(chatId: string, slug: string): Promise<void> {
  await migrate()
  await db()
    .delete(telegramTopics)
    .where(and(eq(telegramTopics.chatId, chatId), eq(telegramTopics.slug, slug)))
}
