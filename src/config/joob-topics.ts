import type { TopicDefinition, TopicList } from './topics.js'

/**
 * The tabs in Joob's chat.
 *
 * Three, and none of them per-search: Joob has no per-search or per-profile tab.
 * Beats are different subjects and earn one each
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
  /**
   * Push-only. Companies that might want to *hire* the reader, rather than roles
   * the reader might apply for
   * ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
   *
   * A third tab rather than a third bot, and the test was whether these are two
   * agents or one agent with two concerns. A job, a freelance mission and a
   * client who should be hiring the reader are three shapes of *find me paid
   * work* — same person, same cadence, same portfolio — so
   * [ADR-0023](../../docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)'s
   * split does not apply, while invariant 9's *one tab, one kind of traffic*
   * plainly does.
   *
   * It stays separate from Jobs because the two are read in different moods and
   * demand different actions: a job is something to apply to, a lead is someone
   * to write to. Mixing them would make the Jobs tab unreadable in exactly the
   * way a tab per beat was invented to prevent.
   */
  leads: {
    slug: 'leads',
    emoji: '🎯',
    title: 'Leads',
    iconCustomEmojiId: null,
  },
} as const satisfies Record<string, TopicDefinition>

export type JoobTopicSlug = keyof typeof JOOB_TOPICS

export const JOOB_TOPIC_LIST: TopicList<JoobTopicSlug> = Object.values(JOOB_TOPICS)
