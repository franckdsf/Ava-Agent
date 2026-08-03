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
 * A beat — one subject the reader follows, with the standard its curator judges
 * against.
 *
 * This was `CATEGORIES` in `src/config/categories.ts`, a git-reviewable array.
 * It is a table now because the reader adds beats by talking to Newy rather than
 * by editing code ([ADR-0019](../../docs/decisions/0019-beats-as-reader-owned-data.md)).
 * `src/config/seed-beats.ts` still exists, but it is a *seed* applied once to an
 * empty table — editing it does not reach a beat that already exists.
 *
 * Nothing here is a foreign key target in SQLite terms, deliberately: a beat is
 * soft-deleted with `archivedAt` rather than removed, so its articles, its
 * scores, its votes and its Telegram tab all survive being switched off. That
 * makes "pause this beat" and "delete this beat" the same operation at two
 * depths, and neither one loses history.
 */
export const beats = sqliteTable(
  'beats',
  {
    /** Stable key, used in `article_beats`, `feedback`, and the tab's topic slug. */
    slug: text('slug').primaryKey(),
    title: text('title').notNull(),
    /** Prefixed to the title on the beat's Telegram tab, and on every digest heading. */
    emoji: text('emoji').notNull(),
    /**
     * What makes a curator expert: the standard the ranker judges against.
     *
     * Passed **in the prompt, not baked into agent instructions**, which is the
     * same reasoning ADR-0008 gave for the feedback profile — instructions are
     * fixed at construction and a rubric the reader can edit mid-conversation
     * would go stale until the next restart.
     */
    rubric: text('rubric').notNull(),
    /**
     * The label set the ranker must choose from, as a JSON array. Sectioning
     * comes free from ranking rather than costing a second model call.
     *
     * A JSON column rather than a child table because nothing ever queries by
     * subtopic — it is read whole, written whole, and rendered into a prompt.
     */
    subtopics: text('subtopics', { mode: 'json' }).$type<string[]>().notNull(),
    /**
     * 0–100. At or above this, an article may win this beat and be delivered.
     * Null means `pipeline.defaultDigestThreshold`, so retuning the default
     * retunes every beat that never overrode it — which is the point of the
     * null rather than a copied number.
     */
    digestThreshold: integer('digest_threshold'),
    /** Hard cap per digest, so a busy news day can't produce a wall of text. Null → default. */
    maxItemsPerDigest: integer('max_items_per_digest'),
    createdAt: integer('created_at').notNull(),
    /** Set to switch the beat off: no ingest, no ranking, no delivery, tab closed. */
    archivedAt: integer('archived_at'),
  },
  table => [index('idx_beats_active').on(table.archivedAt)],
)

/**
 * Which feeds a beat pulls from.
 *
 * **A feed URL may appear on several beats, and that is now load-bearing.** When
 * beats were hand-written no two shared a feed, which hid a real bug:
 * `feed_state` is keyed by URL globally, so the second beat to fetch a shared
 * feed got a 304 and saw nothing. Ingest therefore fetches each *distinct* URL
 * once and fans the entries out to every beat subscribing to it — the index on
 * `feedUrl` is what that fan-out reads.
 */
export const beatFeeds = sqliteTable(
  'beat_feeds',
  {
    beatSlug: text('beat_slug').notNull(),
    feedUrl: text('feed_url').notNull(),
    /** Shown as the attribution in digests. */
    source: text('source').notNull(),
    /** Single-purpose feeds pin a subtopic instead of paying for classification. */
    subtopic: text('subtopic'),
    addedAt: integer('added_at').notNull(),
    /** Soft delete, same reasoning as `beats.archivedAt` — the articles it brought in stay. */
    archivedAt: integer('archived_at'),
    /**
     * Who archived this subscription, and why.
     *
     * The soft delete alone was enough while `/removefeed` was the only way to
     * archive one. The weekly review changes that: it archives feeds that earn
     * nothing, and it later brings them back to re-test them. Without this
     * column those two things are indistinguishable from a feed the reader
     * removed on purpose — and resurrecting *that* one a month later, silently,
     * is the kind of behaviour that makes a bot untrustworthy.
     *
     * Null means archived before this column existed, and is read as `reader`:
     * the safe assumption, since it is the one that never resurrects anything.
     */
    archivedReason: text('archived_reason', {
      enum: ['reader', 'underperforming', 'unreachable'],
    }),
    /**
     * How many times the review has archived this feed for underperforming.
     *
     * The backoff counter. A feed brought back, given a month, and found wanting
     * again would otherwise cycle forever — costing a fetch on every digest for
     * a week, every time. Past `feedReview.maxTrials` it stays archived and the
     * reader can still re-add it by hand, which is the deliberate act this is
     * meant to require.
     */
    trials: integer('trials'),
  },
  table => [
    primaryKey({ columns: [table.beatSlug, table.feedUrl] }),
    index('idx_beat_feeds_url').on(table.feedUrl),
  ],
)

/**
 * One row per story. The id is a hash of the canonical link, so the same story
 * arriving from two feeds — or matching two beats — collides and is kept once.
 * That collision *is* the global dedupe ([invariant 5](../../AGENTS.md#invariants)).
 *
 * Renamed from `items`, which said nothing about what a row is. Everything else
 * in the codebase already called these articles — `read-article`,
 * `fetchArticleText`, the article writer — so `items` was the outlier.
 *
 * **Ranking is not here.** A story can sit on several beats and score
 * differently on each, so `score`, `subtopic`, `reason`, `rankedAt` and
 * `clusterId` live on `article_beats`. What stays here is what is true about the
 * story regardless of who is reading it — and delivery, because a story is sent
 * to exactly one beat (see `deliveredBeat`).
 *
 * A useful consequence: this table is now written once at ingest and then only
 * on delivery. It used to take a `score` and a `rankedAt` write on every run,
 * which is the whole reason the `articles_fts` update trigger is scoped to the
 * text columns.
 */
export const articles = sqliteTable(
  'articles',
  {
    id: text('id').primaryKey(),
    /** The feed this story was first seen in. Not the beat — several may carry it. */
    feedUrl: text('feed_url').notNull(),
    source: text('source').notNull(),
    title: text('title').notNull(),
    link: text('link').notNull(),
    /** Short, for the ranker — it sees hundreds of these per run and must stay cheap. */
    excerpt: text('excerpt'),
    /**
     * Full article body when the feed ships one (`content:encoded`), stripped to
     * plain text. Only the handful of articles that survive ranking are ever read
     * from here, but it is captured at ingest because the feed is the cheapest
     * source — re-fetching the article later costs a request and often fails.
     */
    content: text('content'),
    /**
     * Lead image, sent as a URL for Telegram to fetch — nothing is downloaded
     * or hosted here. Null for most sources: of the seeded feeds only DeepMind,
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

    // Delivery output — null until actually sent.
    deliveredAt: integer('delivered_at'),
    /**
     * The beat that won the story.
     *
     * A story is scored on every beat that carries it and sent on exactly one:
     * the highest scorer among those clearing their own threshold. That is why
     * delivery is a column here and not on `article_beats` — "which beat sent
     * this" has one answer, and the losing beats keep their score and their
     * reason so the near-miss is still readable.
     */
    deliveredBeat: text('delivered_beat'),
    deliveryKind: text('delivery_kind', { enum: ['digest', 'breaking'] }),
  },
  table => [
    index('idx_articles_undelivered').on(table.deliveredAt, table.discoveredAt),
    index('idx_articles_feed_image').on(table.feedUrl, table.imageUrl),
  ],
)

/**
 * One row per (story, beat): what this beat's curator made of this story.
 *
 * This is the table that lets a story belong to more than one beat without being
 * stored — or delivered — twice. A row exists from the moment ingest links the
 * story to a beat; the ranking columns fill in when that beat's curator runs.
 *
 * `reason` is worth more than it looks. The ranker writes one for **every**
 * article it scores, not just the winners, so this table holds a one-line
 * account of why each story was passed over. Nothing read it until now.
 */
export const articleBeats = sqliteTable(
  'article_beats',
  {
    articleId: text('article_id').notNull(),
    beatSlug: text('beat_slug').notNull(),

    /**
     * Groups near-duplicate headlines so one story doesn't reach the ranker
     * three times over.
     *
     * Per beat, not per article, because clustering runs over *one beat's*
     * pending batch — the same story lands in different neighbourhoods on
     * different beats, and a single global column would have two runs
     * overwriting each other.
     */
    clusterId: text('cluster_id'),

    // Ranking output — null until this beat's ranker has seen it.
    score: integer('score'),
    subtopic: text('subtopic'),
    /** At most 15 words, concrete. Written for winners and near-misses alike. */
    reason: text('reason'),
    rankedAt: integer('ranked_at'),
  },
  table => [
    primaryKey({ columns: [table.articleId, table.beatSlug] }),
    index('idx_article_beats_unranked').on(table.beatSlug, table.rankedAt),
    index('idx_article_beats_score').on(table.beatSlug, table.score),
    index('idx_article_beats_cluster').on(table.beatSlug, table.clusterId),
  ],
)

/**
 * 👍/👎 from Telegram. Feeds the per-beat interest profile.
 *
 * `title` and `source` are copied from the article at vote time rather than
 * joined back to it, and that denormalization is load-bearing: articles are
 * pruned at `retentionDays` but votes are kept forever, so a row that joined to
 * `articles` for its title would go silently unreadable the moment its story
 * aged out — taking the reader's taste with it. These two columns are the entire
 * signal the ranker consumes (`renderInterestProfile` emits `- title (source)`),
 * so storing them makes a vote self-contained and permanent.
 *
 * Unbounded growth is fine here in a way it is not for `articles`: this table
 * grows only when a human presses a button, at ~100 bytes a press, while
 * articles arrive automatically by the hundred every day.
 */
export const feedback = sqliteTable(
  'feedback',
  {
    /**
     * Still the article's id, so re-voting overwrites — and it stays meaningful
     * after the article is gone, since nothing joins on it any more.
     */
    articleId: text('article_id').primaryKey(),
    /** The beat the reader was reading when they voted, not every beat it scored on. */
    beatSlug: text('beat_slug').notNull(),
    /** Snapshot of the article, so the vote outlives it. */
    title: text('title').notNull(),
    source: text('source').notNull(),
    vote: text('vote', { enum: ['up', 'down'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  table => [index('idx_feedback_beat').on(table.beatSlug, table.createdAt)],
)

/**
 * What Newy knows about the reader. One row per fact, in her own words.
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
 * **Notes are not scoped to a beat, deliberately.** "No Android articles" is a
 * statement about the reader, and the reader is the same person on every beat —
 * a per-beat note would let the same preference be true in one tab and false in
 * the next. A note that stops being true is superseded by a later one, which is
 * the mechanism this table already has.
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
     * Same device as `articles.id`: derive the key from the content that must be
     * unique, and the dedupe needs no bookkeeping.
     *
     * It only catches *verbatim* repeats — "Their name is Franck" and "The
     * reader is called Franck" are two rows. The prompt is the real guard there,
     * since Newy is shown everything she already knows before she decides to
     * write anything.
     */
    id: text('id').primaryKey(),
    tier: text('tier', { enum: ['short', 'long'] }).notNull(),
    /** One self-contained fact, third person. Capped at `memoryConfig.factMaxChars`. */
    fact: text('fact').notNull(),
    /**
     * When the fact was true, which is not always when it was recorded — "I ate
     * at Kodawari on Saturday" said on Monday is Saturday's memory. Supplied by
     * Newy when the reader dates it, otherwise the moment it was written.
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
     * The tab name Telegram was last told, so a renamed topic can be pushed with
     * `editForumTopic` rather than silently applying only to tabs created
     * afterwards. There is no `getForumTopic` to read it back with, so
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

export type Beat = typeof beats.$inferSelect
export type NewBeat = typeof beats.$inferInsert
export type BeatFeedRow = typeof beatFeeds.$inferSelect
export type Article = typeof articles.$inferSelect
export type NewArticle = typeof articles.$inferInsert
export type ArticleBeatRow = typeof articleBeats.$inferSelect
export type FeedStateRow = typeof feedState.$inferSelect
export type FeedbackRow = typeof feedback.$inferSelect
export type MemoryRow = typeof memories.$inferSelect

export type DeliveryKind = NonNullable<Article['deliveryKind']>
export type Vote = FeedbackRow['vote']
export type MemoryTier = MemoryRow['tier']
