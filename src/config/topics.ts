/**
 * The tabs in the private chat with the bot.
 *
 * Config, not code — same reasoning as `CATEGORIES` in `categories.ts`. Adding a
 * tab means adding an entry here; needing to touch the topics service or the
 * delivery step would mean the abstraction is wrong.
 *
 * Order is the order they are created, which is the order Telegram shows them.
 */

export interface TopicDefinition {
  /** Stable key. Persisted, so renaming one orphans its row — add a new slug instead. */
  slug: string
  /** Shown on the tab. */
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
    title: 'Chat',
    iconCustomEmojiId: null,
  },
  /** Push-only. Scheduled digests land here and nothing reads from it. */
  news: {
    slug: 'news',
    title: 'News',
    iconCustomEmojiId: null,
  },
} as const satisfies Record<string, TopicDefinition>

export type TopicSlug = keyof typeof TOPICS

export const TOPIC_LIST: readonly TopicDefinition[] = Object.values(TOPICS)
