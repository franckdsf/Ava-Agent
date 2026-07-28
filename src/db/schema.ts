import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The app's own tables. Mastra manages its `mastra_*` tables independently in
 * the same database — Drizzle owns only what's declared here, so the two never
 * collide. Change a table, then run `pnpm db:generate` to emit a migration.
 */

/** Conditional-GET state, so feeds are re-fetched politely. */
export const feedState = sqliteTable('feed_state', {
  feedUrl: text('feed_url').primaryKey(),
  etag: text('etag'),
  lastModified: text('last_modified'),
  lastFetchedAt: integer('last_fetched_at'),
  lastStatus: text('last_status'),
  lastError: text('last_error'),
})

/**
 * One row per story. The id is a hash of the canonical link, so the same story
 * arriving from two feeds — or matching two categories — collides and is kept
 * once. That collision *is* the global dedupe.
 */
export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    categorySlug: text('category_slug').notNull(),
    feedUrl: text('feed_url').notNull(),
    source: text('source').notNull(),
    title: text('title').notNull(),
    link: text('link').notNull(),
    /** Short, for the ranker — it sees hundreds of these per run and must stay cheap. */
    excerpt: text('excerpt'),
    /**
     * Full article body when the feed ships one (`content:encoded`), stripped to
     * plain text. Only the handful of items that survive ranking are ever read
     * from here, but it is captured at ingest because the feed is the cheapest
     * source — re-fetching the article later costs a request and often fails.
     */
    content: text('content'),
    /**
     * Lead image, sent as a URL for Telegram to fetch — nothing is downloaded
     * or hosted here. Null for most sources: of 16 feeds only DeepMind,
     * Smashing and Android Developers publish one reliably, so every consumer
     * must treat an image as absent by default.
     *
     * Written at ingest from the feed, or later by the compose step once an
     * og:image has passed the site-chrome and repeated-URL checks. Anything
     * stored here is therefore already vetted and is trusted on re-delivery.
     */
    imageUrl: text('image_url'),
    publishedAt: integer('published_at'),
    discoveredAt: integer('discovered_at').notNull(),

    /** Groups near-duplicate headlines across outlets into one story. */
    clusterId: text('cluster_id'),

    // Ranking output — null until the ranker has seen it.
    score: integer('score'),
    subtopic: text('subtopic'),
    reason: text('reason'),
    rankedAt: integer('ranked_at'),

    // Delivery output — null until actually sent.
    deliveredAt: integer('delivered_at'),
    deliveryKind: text('delivery_kind', { enum: ['digest', 'breaking'] }),
  },
  table => [
    index('idx_items_unranked').on(table.categorySlug, table.rankedAt, table.discoveredAt),
    index('idx_items_undelivered').on(table.categorySlug, table.deliveredAt, table.score),
    index('idx_items_cluster').on(table.clusterId),
  ],
)

/**
 * 👍/👎 from Telegram. Feeds the per-category interest profile.
 *
 * `title` and `source` are copied from the item at vote time rather than joined
 * back to it, and that denormalization is load-bearing: items are pruned at
 * `retentionDays` but votes are kept forever, so a row that joined to `items`
 * for its title would go silently unreadable the moment its article aged out —
 * taking the reader's taste with it. These two columns are the entire signal the
 * ranker consumes (`renderInterestProfile` emits `- title (source)`), so storing
 * them makes a vote self-contained and permanent.
 *
 * Unbounded growth is fine here in a way it is not for `items`: this table grows
 * only when a human presses a button, at ~100 bytes a press, while items arrive
 * automatically by the hundred every day.
 */
export const feedback = sqliteTable(
  'feedback',
  {
    /**
     * Still the item's id, so re-voting overwrites — and it stays meaningful
     * after the item is gone, since nothing joins on it any more.
     */
    itemId: text('item_id').primaryKey(),
    categorySlug: text('category_slug').notNull(),
    /** Snapshot of the article, so the vote outlives it. */
    title: text('title').notNull(),
    source: text('source').notNull(),
    vote: text('vote', { enum: ['up', 'down'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  table => [index('idx_feedback_category').on(table.categorySlug, table.createdAt)],
)

/**
 * Telegram forum topics provisioned in the private chat — the "tabs".
 *
 * Keyed by `(chatId, slug)` rather than slug alone because a topic id is only
 * meaningful inside one chat: point `TELEGRAM_CHAT_ID` at a different chat and
 * the old rows must not be reused as if they were valid there.
 *
 * `messageThreadId` is Telegram's, not ours — we can create a topic but never
 * choose its id, so this table is a cache of what Telegram assigned. A row going
 * stale (topic deleted on the phone) is expected, not exceptional.
 */
export const telegramTopics = sqliteTable(
  'telegram_topics',
  {
    chatId: text('chat_id').notNull(),
    slug: text('slug').notNull(),
    messageThreadId: integer('message_thread_id').notNull(),
    /**
     * The tab name Telegram was last told, so a renamed `TOPICS` entry can be
     * pushed with `editForumTopic` rather than silently applying only to tabs
     * created afterwards. There is no `getForumTopic` to read it back with, so
     * remembering what we sent is the only way to know whether it has drifted.
     *
     * Nullable for rows written before names were tracked. Null reads as
     * "unknown", which costs exactly one rename on the next resolve.
     */
    name: text('name'),
    createdAt: integer('created_at').notNull(),
  },
  table => [primaryKey({ columns: [table.chatId, table.slug] })],
)

export type TelegramTopicRow = typeof telegramTopics.$inferSelect

export type Item = typeof items.$inferSelect
export type NewItem = typeof items.$inferInsert
export type FeedStateRow = typeof feedState.$inferSelect
export type FeedbackRow = typeof feedback.$inferSelect

export type DeliveryKind = NonNullable<Item['deliveryKind']>
export type Vote = FeedbackRow['vote']
