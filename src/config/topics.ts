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
 * keyed by `(chatId, slug)` with no reference to this list, which is what lets
 * both kinds share it — see `beatTopicSlug` below and
 * [ADR-0021](../../docs/decisions/0021-a-tab-per-beat.md).
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
  /**
   * Push-only, and since [ADR-0021](../../docs/decisions/0021-a-tab-per-beat.md)
   * a *fallback* rather than the destination.
   *
   * Every delivered article belongs to exactly one beat (`articles.deliveredBeat`)
   * and goes to that beat's own tab. This one receives a digest only when the
   * beat's tab could not be resolved — creation refused, or the row is being
   * re-made after the reader deleted the tab. It should be silent in normal
   * operation, and a message arriving here is worth investigating.
   *
   * Kept in this list rather than retired because it holds every digest sent
   * before beats had tabs, and because a fallback that is a real tab reads
   * better than one that dumps into the flat chat.
   */
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

/**
 * `slug` is narrowed back to `TopicSlug` here. `TopicDefinition` has to declare
 * it as a plain `string` — the interface is what `TOPICS` is checked against, so
 * typing it as `keyof typeof TOPICS` would be circular — and a bare
 * `readonly TopicDefinition[]` would widen it right back and lose the one thing
 * that keeps a system tab distinguishable from a beat's at the type level.
 */
export const TOPIC_LIST: readonly (TopicDefinition & { slug: TopicSlug })[] =
  Object.values(TOPICS)

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

/**
 * Namespace for a beat's row in `telegram_topics`.
 *
 * Beat slugs are reader-supplied by way of the namer, and `beatCommands.slugPattern`
 * happily accepts `news`, `chat` and `translations` — `/follow the news` really
 * can produce one. Without a namespace that beat would share a primary key with
 * a system tab, and the first one to resolve would hand the other its thread id:
 * digests into the Translations tab, or Ava answering in a beat's tab. The
 * prefix cannot itself collide, because `slugPattern` forbids a colon.
 */
export const BEAT_TOPIC_PREFIX = 'beat:'

/** A beat's storage slug — `beat:formula-1`, never a bare `formula-1`. */
export type BeatTabSlug = `${typeof BEAT_TOPIC_PREFIX}${string}`

/** Anything that owns a tab: one of the three system topics, or a beat. */
export type TabSlug = TopicSlug | BeatTabSlug

export function beatTopicSlug(beatSlug: string): BeatTabSlug {
  return `${BEAT_TOPIC_PREFIX}${beatSlug}`
}

/**
 * Telegram's cap on a forum topic name.
 *
 * Worth enforcing rather than trusting: a beat's title comes from the namer, so
 * it is model output, and `createForumTopic` rejects an over-long name outright
 * rather than truncating. That failure would cost the beat its tab for the life
 * of the process and quietly route it to News instead — the one outcome this
 * whole change exists to avoid.
 */
export const TAB_NAME_MAX_CHARS = 128

/**
 * What a beat's tab is called on Telegram.
 *
 * Deliberately the same shape as `topicTabName` — emoji, space, title — so the
 * tab strip reads as one list rather than as system tabs plus something else.
 * `beats.emoji` exists for this; it is the same character the digest heading and
 * `/beats` already use, so a beat looks the same everywhere it appears.
 */
export function beatTabName(beat: { emoji: string; title: string }): string {
  return `${beat.emoji} ${beat.title}`.slice(0, TAB_NAME_MAX_CHARS)
}
