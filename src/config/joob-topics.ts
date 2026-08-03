import type { TopicDefinition, TopicList } from './topics.js'

/**
 * The tabs in Joob's chat.
 *
 * Two, against Newy's three, and the gap is the interesting part: Joob has no
 * per-search tab. Beats are different subjects and earn one each
 * ([ADR-0021](../../docs/decisions/0021-a-tab-per-beat.md)); searches are slices
 * of one field, and a strip of eleven near-identical tabs is worse than one good
 * one ([ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)).
 * Every match lands in Jobs with its search named in the footer.
 *
 * Sharing the `chat` slug with Newy is not a collision — `telegram_topics` is
 * keyed `(chatId, slug)` and these are different chats. See the note on
 * `beatTopicSlug` in `topics.ts`.
 */

export const JOOB_TOPICS = {
  /** Conversational surface. Joob answers here and nowhere else. */
  chat: {
    slug: 'chat',
    emoji: '💬',
    title: 'Chat',
    iconCustomEmojiId: null,
  },
  /**
   * Push-only. Every posting that clears its search's bar arrives here, one
   * message each, whichever search won it.
   *
   * One tab for every search on purpose — see the note above. The search is
   * named in the footer, which is the slot a beat's subtopic occupies in a
   * digest, so a reader can still tell why something arrived without a tab per
   * query.
   */
  jobs: {
    slug: 'jobs',
    emoji: '💼',
    title: 'Jobs',
    iconCustomEmojiId: null,
  },
} as const satisfies Record<string, TopicDefinition>

export type JoobTopicSlug = keyof typeof JOOB_TOPICS

export const JOOB_TOPIC_LIST: TopicList<JoobTopicSlug> = Object.values(JOOB_TOPICS)
