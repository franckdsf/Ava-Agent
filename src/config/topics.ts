/**
 * The tabs in the private chat with the bot.
 *
 * Config, not code — same reasoning as `CATEGORIES` in `categories.ts`. Adding a
 * tab means adding an entry here; needing to touch the topics service or the
 * delivery step would mean the abstraction is wrong.
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
