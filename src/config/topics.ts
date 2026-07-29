/**
 * The tabs in the private chat with the bot.
 *
 * Config, not code: adding a tab means adding an entry here; needing to touch
 * the topics service or the delivery step would mean the abstraction is wrong.
 *
 * These are the *system* tabs, and they are static on purpose — one per kind of
 * traffic, decided here. Beats used to sit alongside them in the same style of
 * config array and no longer do: they are rows the reader can create at runtime
 * ([ADR-0019](../../docs/decisions/0019-beats-as-reader-owned-data.md)), so a
 * per-beat tab cannot be an entry in a frozen object. `telegram_topics` is
 * already keyed by `(chatId, slug)` with no reference to this list, which is
 * what will let both kinds share it.
 *
 * Order here is only the order they are *created*. It is not the order Telegram
 * shows them: the client sorts tabs by most recent message, so News floats up at
 * 08:00/13:00/19:00 and Chat floats up whenever Ava answers. Verified against
 * the live chat 2026-07-28 — Chat, created first, sat below News until a reply
 * landed in it. Nothing in this file can pin a tab to a position, and no Bot API
 * method reorders them, so don't rearrange these entries expecting it to.
 *
 * Renaming a `title` or `emoji` *does* reach an existing tab: `resolveTopics()`
 * pushes it with `editForumTopic`. Changing a `slug` does not — that orphans the
 * row and creates a second tab.
 */

export interface TopicDefinition {
  /** Stable key. Persisted, so renaming one orphans its row — add a new slug instead. */
  slug: string
  /**
   * Prefixed to `title` on the tab.
   *
   * A plain unicode character, which is *not* what `iconCustomEmojiId` takes —
   * that one is a sticker id Telegram renders as the tab's icon, this one is
   * simply the first character of the tab's name. This is the one that works
   * without a premium sticker id.
   */
  emoji: string
  /** Shown on the tab, after `emoji`. Also how prose refers to the tab. */
  title: string
  /**
   * Custom emoji id for the tab icon, or null for Telegram's default.
   *
   * These are *custom emoji* ids, not unicode emoji — `getForumTopicIconStickers`
   * lists the ones a bot may use for free. Left null because the default icon is
   * fine and a wrong id makes `createForumTopic` fail outright.
   */
  iconCustomEmojiId: string | null
}

export const TOPICS = {
  /** Conversational surface. Ava answers here. */
  chat: {
    slug: 'chat',
    emoji: '💬',
    title: 'Chat',
    iconCustomEmojiId: null,
  },
  /** Push-only. Scheduled digests land here and nothing reads from it. */
  news: {
    slug: 'news',
    emoji: '📰',
    title: 'News',
    iconCustomEmojiId: null,
  },
  /**
   * Push-only, like News. `/translearn` and `/translate` answer here.
   *
   * Third in this list, which decides creation order and nothing else — see the
   * note at the top of this file. Telegram sorts tabs by most recent message, so
   * this one floats to the top the moment a translation lands in it and sinks
   * again as digests arrive. There is no API for pinning it third.
   *
   * Its own tab rather than Chat because a translated article is several
   * thousand characters over several messages, and dropping that into the middle
   * of a conversation buries whatever was being discussed. Same reasoning that
   * put digests in News: one tab, one kind of traffic
   * ([invariant 9](../../AGENTS.md#invariants)). Ava still never answers here —
   * a message typed in this tab is moved to Chat like one typed in News.
   */
  translations: {
    slug: 'translations',
    emoji: '📜',
    title: 'Translations',
    iconCustomEmojiId: null,
  },
} as const satisfies Record<string, TopicDefinition>

export type TopicSlug = keyof typeof TOPICS

export const TOPIC_LIST: readonly TopicDefinition[] = Object.values(TOPICS)

/**
 * What the tab is actually called on Telegram.
 *
 * Kept out of `title` because the two are read by different audiences: this is
 * the only thing Telegram sees, while `title` is what Ava's instructions and the
 * `/start` welcome interpolate — and `the "💬 Chat" tab` reads worse in a prompt
 * than `the "Chat" tab`.
 */
export function topicTabName(topic: TopicDefinition): string {
  return `${topic.emoji} ${topic.title}`
}
