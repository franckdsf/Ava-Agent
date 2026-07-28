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
 * What Ava knows about the reader. One row per fact, in her own words.
 *
 * Split into two tiers by how long the fact stays true, not by how it was
 * learned. `long` is biography — a name, where they live, what they do, a
 * standing preference. `short` is episodic — what they ate, what they were
 * working on this week — and is only shown for `memoryConfig.shortTermDays`.
 *
 * **Nothing here is ever rewritten to stay current, and that is the design.** A
 * fact that stops being true is not corrected; the new fact is recorded with its
 * own date and both are rendered oldest-first, so "dark hair (2025-01)" followed
 * by "blond hair (2026-01)" reads as a change rather than a contradiction. An
 * update-in-place would keep the current value and lose that it ever changed,
 * which is the more interesting half. Deletion exists only for a fact that was
 * never true ([ADR-0014](../../docs/decisions/0014-two-tier-memory-for-ava.md)).
 *
 * No reader column. The bot has one reader by construction — an allowlist of
 * user ids, one chat id, a single replica — so a `resource` here would be a
 * constant in every row. Adding one is the migration to run on the day a second
 * reader exists, not before.
 */
export const memories = sqliteTable(
  'memories',
  {
    /**
     * Hash of the normalized fact, so re-stating something already known
     * collides rather than accumulating a near-duplicate line in the prompt.
     * Same device as `items.id`: derive the key from the content that must be
     * unique, and the dedupe needs no bookkeeping.
     *
     * It only catches *verbatim* repeats — "Their name is Franck" and "The
     * reader is called Franck" are two rows. The prompt is the real guard there,
     * since Ava is shown everything she already knows before she decides to
     * write anything.
     */
    id: text('id').primaryKey(),
    tier: text('tier', { enum: ['short', 'long'] }).notNull(),
    /** One self-contained fact, third person. Capped at `memoryConfig.factMaxChars`. */
    fact: text('fact').notNull(),
    /**
     * When the fact was true, which is not always when it was recorded — "I ate
     * at Kodawari on Saturday" said on Monday is Saturday's memory. Supplied by
     * Ava when the reader dates it, otherwise the moment it was written.
     *
     * This is what orders the rendered block, so it is the column that carries
     * the whole supersedes-by-recency reading.
     */
    happenedAt: integer('happened_at').notNull(),
    /**
     * When the row was written. Bookkeeping, and deliberately the column the
     * short-term window measures against: a fact learned today about something
     * six months ago should survive its first month in the notes rather than
     * being invisible the moment it lands.
     */
    createdAt: integer('created_at').notNull(),
  },
  table => [index('idx_memories_tier').on(table.tier, table.happenedAt)],
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
export type MemoryRow = typeof memories.$inferSelect

export type DeliveryKind = NonNullable<Item['deliveryKind']>
export type Vote = FeedbackRow['vote']
export type MemoryTier = MemoryRow['tier']
