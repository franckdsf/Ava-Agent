import type { BotProfile } from '../config/bot-profile.js'
import type { TopicDefinition, TopicList } from '../config/topics.js'
import type { BotDefinition } from './index.js'

/**
 * Newy — what she is before anyone talks to her: her token's prefix, her tabs, her profile.
 *
 * Data only, and a leaf on purpose: workflows and commands import this to reach her transport, so
 * it cannot import them back. What she *does* is built from it elsewhere — her agent in
 * `src/mastra/agents/newy.ts`, her commands and `/start` in `src/mastra/commands/`.
 */

/**
 * The tabs in Newy's chat.
 *
 * Split out of `topics.ts` when Joob got its own bot and its own chat
 * ([ADR-0023](../../docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)).
 * The slugs are unchanged and must stay that way: they are the primary key in
 * `telegram_topics` alongside the chat id, so renaming one orphans its row and
 * creates a second tab. The file moved; the data did not.
 *
 * Joob owning a tab whose slug is also `chat` is not a collision — see the note
 * on `beatTopicSlug` in `topics.ts`.
 */
export const NEWY_TOPICS = {
  /** Conversational surface. Newy answers here. */
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
   * note at the top of `topics.ts`. Telegram sorts tabs by most recent message,
   * so this one floats to the top the moment a translation lands in it and sinks
   * again as digests arrive. There is no API for pinning it third.
   *
   * Its own tab rather than Chat because a translated article is several
   * thousand characters over several messages, and dropping that into the middle
   * of a conversation buries whatever was being discussed. Same reasoning that
   * put digests in News: one tab, one kind of traffic
   * ([invariant 9](../../AGENTS.md#invariants)). Newy still never answers here —
   * a message typed in this tab is moved to Chat like one typed in News.
   */
  translations: {
    slug: 'translations',
    emoji: '📜',
    title: 'Translations',
    iconCustomEmojiId: null,
  },
} as const satisfies Record<string, TopicDefinition>

export type NewyTopicSlug = keyof typeof NEWY_TOPICS

const NEWY_TOPIC_LIST: TopicList<NewyTopicSlug> = Object.values(NEWY_TOPICS)

/** Her name and the two descriptions, pushed at boot by `publishProfile()`. See `BotProfile`. */
const newyProfile: BotProfile = {
  name: 'Newy 📰',

  shortDescription:
    'Your personal news assistant — curated digests, plus a chat that remembers ' +
    'what matters to you.',

  description:
    'Newy tracks your beats in the background — ranking, summarizing and ' +
    'delivering the news that matters to you, no digging required. Ask her ' +
    "anything about what she's found: she'll search past articles, pull up the " +
    'full text, and explain what a story actually says. She remembers what you ' +
    'tell her about yourself over time, so answers get more personal the longer ' +
    'you talk. She can also sketch a quick diagram when a concept has moving ' +
    'parts worth seeing.',
}

export const NEWY_BOT: BotDefinition<NewyTopicSlug> = {
  id: 'newy',
  envPrefix: 'NEWY_',
  topics: NEWY_TOPIC_LIST,
  profile: newyProfile,
}
