/**
 * The vocabulary of tabs, shared by every bot.
 *
 * This file used to hold Newy's three tabs as well, and the two things came
 * apart when Joob got its own bot and its own chat
 * ([ADR-0023](../../docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)).
 * What is left here is what is true of a tab whoever owns it: the shape of a
 * definition, how a name is rendered, and the beat namespace. **Newy's own tabs
 * are in `newy-topics.ts`**, Joob's in `joob-topics.ts`, and each bot's set
 * reaches the transport through `bots.ts`.
 *
 * A tab set is still static per bot and decided in config — adding a tab means
 * adding an entry to that bot's file. Beats are the exception and always were:
 * they are rows the reader creates at runtime
 * ([ADR-0019](../../docs/decisions/0019-beats-as-reader-owned-data.md)), so a
 * per-beat tab cannot be an entry in a frozen object. `telegram_topics` is keyed
 * by `(botId, chatId, slug)` with no reference to any list, which is what lets
 * system tabs, beat tabs and *two bots* share one table — see `beatTopicSlug`
 * below and [ADR-0021](../../docs/decisions/0021-a-tab-per-beat.md). The bot id
 * is load-bearing rather than tidy: in a private chat the chat id is the
 * reader's user id, so both bots see the same one.
 *
 * Order within a bot's set is only the order its tabs are *created*. It is not
 * the order Telegram shows them: the client sorts tabs by most recent message,
 * so News floats up at 08:00/13:00/19:00 and Chat floats up whenever Newy
 * answers. Verified against the live chat 2026-07-28 — Chat, created first, sat
 * below News until a reply landed in it. Nothing in config can pin a tab to a
 * position, and no Bot API method reorders them, so don't rearrange entries
 * expecting it to.
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

/**
 * One bot's tab set, with its slugs still narrowed to a union.
 *
 * The type parameter is what keeps `sendToTelegram(text, 'chat')` checkable
 * after the transport stopped knowing which bot it serves. `TopicDefinition` has
 * to declare `slug` as a plain `string` — a bot's topic object is checked
 * against it, so typing it as `keyof typeof …` would be circular — and a bare
 * `readonly TopicDefinition[]` would widen it right back, losing the one thing
 * that keeps a system tab distinguishable from a beat's at the type level.
 */
export type TopicList<Slug extends string> = readonly (TopicDefinition & { slug: Slug })[]

/**
 * What the tab is actually called on Telegram.
 *
 * Kept out of `title` because the two are read by different audiences: this is
 * the only thing Telegram sees, while `title` is what an agent's instructions and
 * the `/start` welcome interpolate — and `the "💬 Chat" tab` reads worse in a
 * prompt than `the "Chat" tab`.
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
 * digests into the Translations tab, or Newy answering in a beat's tab. The
 * prefix cannot itself collide, because `slugPattern` forbids a colon.
 *
 * Note that two bots owning the same slug is *not* a collision — the primary key
 * carries the **bot id**, which is what separates them. It is deliberately not
 * the chat id: on a private chat both bots see the reader's user id as the chat
 * id, so that column separates nothing. Only slugs within one bot's chat can
 * clash, which is what this prefix is for.
 */
export const BEAT_TOPIC_PREFIX = 'beat:'

/** A beat's storage slug — `beat:formula-1`, never a bare `formula-1`. */
export type BeatTabSlug = `${typeof BEAT_TOPIC_PREFIX}${string}`

/** Anything that owns a tab in one bot's chat: one of its system topics, or a beat. */
export type TabSlug<Slug extends string = string> = Slug | BeatTabSlug

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
