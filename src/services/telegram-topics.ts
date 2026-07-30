import {
  beatTabName,
  beatTopicSlug,
  TOPIC_LIST,
  topicTabName,
  type TabSlug,
  type TopicSlug,
} from '../config/topics.js'
import { botProfile, profileOverflows } from '../config/bot-profile.js'
import { telegramEnv } from '../config/env.js'
import { forgetTopic, rememberTopic, renameTopic, topicIds } from '../db/topics.js'

/**
 * Forum topics in the private chat — the tabs.
 *
 * `@chat-adapter/telegram` 4.35 routes *messages* to a topic (it folds
 * `messageThreadId` into its thread id and writes `message_thread_id` on every
 * send path), but it wraps no topic *lifecycle* method. So creation goes
 * straight to the Bot API here rather than through a second Telegram library.
 * See [docs/telegram-bot-api.md](../../docs/telegram-bot-api.md).
 *
 * Topics in private chats need Bot API 9.3/9.4 *and* Threaded Mode enabled in
 * BotFather. That toggle is not reachable from the API, so this module never
 * assumes it is on: `resolveTopics()` degrades to flat delivery instead of
 * failing, because a digest arriving in the wrong place beats no digest.
 */

interface BotApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

/**
 * Telegram answers 200 with `{ok: false}` for application errors, so checking
 * the HTTP status alone silently yields `undefined` and the failure surfaces
 * somewhere unrelated. Always read `ok`.
 */
async function callBotApi<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(
    `https://api.telegram.org/bot${telegramEnv().TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    },
  )
  const body = (await response.json()) as BotApiResponse<T>
  if (!body.ok) throw new Error(`${method} failed: ${body.description ?? 'unknown error'}`)
  return body.result as T
}

/**
 * Publishes the command menu — the list Telegram shows when a reader types `/`.
 *
 * Straight to the Bot API for the reason topic lifecycle is: the adapter wraps
 * no `setMyCommands`. It is not the same thing as *handling* a command, which
 * `channels.ts` does with a catch-all; this only decides what is offered. A
 * command absent from here still works when typed.
 *
 * Pushed on every boot rather than once, because it is a full replacement and
 * the source of truth is the config. Telegram caps `description` at 256
 * characters and rejects the whole call if any entry is longer or if a command
 * name is not lowercase — so a bad entry costs the *entire* menu, not one row.
 */
export async function publishCommands(
  commands: readonly { command: string; description: string }[],
): Promise<void> {
  await callBotApi('setMyCommands', {
    // Telegram wants them without the leading slash.
    commands: commands.map(entry => ({
      command: entry.command.replace(/^\//, ''),
      description: entry.description,
    })),
  })
}

/**
 * One field of the bot's public profile: what config wants, and what Telegram
 * currently has. `method` is what would push it.
 */
export interface ProfileField {
  field: keyof typeof botProfile
  method: 'setMyName' | 'setMyShortDescription' | 'setMyDescription'
  /** The Bot API's parameter name, which is not the config key for two of three. */
  param: 'name' | 'short_description' | 'description'
  want: string
  have: string
}

/**
 * The three profile fields, paired with the Bot API's own names for them.
 *
 * The mapping is spelled out rather than derived because the two vocabularies
 * disagree: `shortDescription` is `short_description` on the wire and lives on a
 * `BotShortDescription`, and a naming convention that happens to work for two of
 * three fields is the kind that breaks silently on the fourth.
 */
const PROFILE_FIELDS: readonly Omit<ProfileField, 'want' | 'have'>[] = [
  { field: 'name', method: 'setMyName', param: 'name' },
  { field: 'shortDescription', method: 'setMyShortDescription', param: 'short_description' },
  { field: 'description', method: 'setMyDescription', param: 'description' },
]

/**
 * Reads the live profile and reports which fields config disagrees with.
 *
 * Read-only — three GETs, no writes — so it is safe against the live bot at any
 * time, which is what lets `pnpm telegram:check` show pending changes without
 * making them.
 *
 * Telegram returns an empty string for a field that was never set, so a fresh
 * bot reports all three as drifted and a fully-provisioned one reports none.
 */
export async function profileDrift(): Promise<ProfileField[]> {
  const drifted: ProfileField[] = []

  for (const entry of PROFILE_FIELDS) {
    const current = await callBotApi<Record<string, string>>(
      // `getMyName` from `setMyName`, and so on for all three.
      entry.method.replace(/^set/, 'get'),
    )
    const have = current[entry.param] ?? ''
    const want = botProfile[entry.field]
    if (have !== want) drifted.push({ ...entry, want, have })
  }

  return drifted
}

/**
 * Brings the bot's name and descriptions in line with `src/config/bot-profile.ts`.
 *
 * Called at boot beside `publishCommands`, so a container brought up against a
 * fresh bot token provisions its own identity — the point being that the only
 * BotFather step left is Threaded Mode, which no API can set.
 *
 * **Reads before it writes, unlike `publishCommands`.** A full replacement is the
 * right shape for the menu and the wrong one here: `setMyName` is flood-limited
 * hard enough that a restart loop would exhaust it, and the failure would be a
 * bot that cannot rename itself for the rest of the day. Diffing costs three GETs
 * and makes the steady state zero writes.
 *
 * Returns what it changed, so the caller can log a real provisioning event rather
 * than "profile published" on every boot. An over-long field is skipped with the
 * others still pushed — Telegram rejects each call separately here, so unlike the
 * command menu one bad field costs only itself.
 */
export async function publishProfile(): Promise<ProfileField[]> {
  const overflows = profileOverflows()
  if (overflows.length > 0) {
    throw new Error(`Bot profile is not sendable: ${overflows.join('; ')}`)
  }

  const drifted = await profileDrift()
  for (const entry of drifted) {
    await callBotApi(entry.method, { [entry.param]: entry.want })
  }
  return drifted
}

interface BotIdentity {
  id: number
  username?: string
  has_topics_enabled?: boolean
}

interface ChatInfo {
  type: string
  is_forum?: boolean
}

/** How this chat came to support topics — reported by `pnpm telegram:check`. */
export type TopicRoute = 'private-threaded-mode' | 'supergroup-forum' | 'unavailable'

/**
 * Whether the target chat can hold topics at all.
 *
 * Two *different* Telegram features share one wire format, and which flag
 * matters depends entirely on the chat type:
 *
 * - **Supergroup forum** (since 2022, universally available): the group has
 *   Topics switched on in its own settings, and `getChat` reports `is_forum`.
 * - **Private chat** (Bot API 9.3/9.4, 2026): the *bot* has Threaded Mode
 *   enabled in BotFather, reported as `has_topics_enabled` on `getMe` — not on
 *   the chat partner, and not on `getChat`. Verified by probe 2026-07-27.
 *
 * Checking only the private-chat flag silently disables tabs in a group, which
 * is the fallback for anyone who can't reach the BotFather toggle.
 */
export async function topicRoute(): Promise<TopicRoute> {
  const chat = await callBotApi<ChatInfo>('getChat', {
    chat_id: telegramEnv().TELEGRAM_CHAT_ID,
  })
  if (chat.type === 'supergroup' || chat.type === 'group') {
    return chat.is_forum === true ? 'supergroup-forum' : 'unavailable'
  }
  const me = await callBotApi<BotIdentity>('getMe')
  return me.has_topics_enabled === true ? 'private-threaded-mode' : 'unavailable'
}

interface ForumTopic {
  message_thread_id: number
  name: string
}

/**
 * Ensures every topic in `TOPICS` exists and is named what config says, and
 * returns the thread ids by slug.
 *
 * Returns an empty map when topics are unavailable — Threaded Mode off, or an
 * older Bot API. Callers treat that as "send flat".
 *
 * Creation is not idempotent on Telegram's side: calling `createForumTopic`
 * twice makes two identically-named tabs. The persisted id is therefore the
 * authority, and a topic is only created when no row exists for it.
 */
export async function resolveTopics(): Promise<Partial<Record<TopicSlug, number>>> {
  const chatId = telegramEnv().TELEGRAM_CHAT_ID

  if ((await topicRoute()) === 'unavailable') return {}

  const known = await topicIds(chatId)
  const resolved: Record<string, number> = {}

  for (const topic of TOPIC_LIST) {
    resolved[topic.slug] = await ensureTopic(
      chatId,
      topic.slug,
      topicTabName(topic),
      topic.iconCustomEmojiId,
      known[topic.slug],
    )
  }

  return resolved
}

/**
 * Creates a tab if its row is missing, renames it if config has moved on, and
 * returns Telegram's id for it either way.
 *
 * `existing` is passed in rather than read here so the caller decides how many
 * table reads a batch costs: `resolveTopics` reads the whole map once for three
 * tabs, while a beat resolves one at a time.
 *
 * The persisted row is the authority on existence, because `createForumTopic` is
 * not idempotent — calling it twice makes two identically-named tabs, and there
 * is no method that reads a topic back to check. That asymmetry is the whole
 * reason this table exists.
 */
async function ensureTopic(
  chatId: string,
  slug: TabSlug,
  name: string,
  iconCustomEmojiId: string | null,
  existing: { messageThreadId: number; name: string | null } | undefined,
): Promise<number> {
  if (existing !== undefined) {
    if (existing.name !== name) {
      await callBotApi('editForumTopic', {
        chat_id: chatId,
        message_thread_id: existing.messageThreadId,
        name,
      })
      await renameTopic(chatId, slug, name)
    }
    return existing.messageThreadId
  }

  const created = await callBotApi<ForumTopic>('createForumTopic', {
    chat_id: chatId,
    name,
    ...(iconCustomEmojiId ? { icon_custom_emoji_id: iconCustomEmojiId } : {}),
  })
  await rememberTopic(chatId, slug, created.message_thread_id, name)
  return created.message_thread_id
}

/** The bits of a beat a tab is made from. `Beat` satisfies it; so does a seed. */
export interface BeatTab {
  slug: string
  emoji: string
  title: string
}

/**
 * Ensures one beat's tab exists, and returns its thread id.
 *
 * Called on the delivery path rather than at `/follow`, so a tab appears the
 * moment a beat first wins an article and never before
 * ([ADR-0021](../../docs/decisions/0021-a-tab-per-beat.md)). A beat whose
 * discovery found no usable feeds, or whose ranker never clears the threshold,
 * costs no tab at all — which matters because `/follow` is cheap to type and a
 * dead tab cannot be tidied away from here.
 *
 * Throws like `resolveTopics` does. The caller decides what a failure means; for
 * delivery it means falling back to News, which is why this is not swallowed
 * here — a beat silently losing its tab forever is worse than one loud error.
 */
export async function resolveBeatTopic(beat: BeatTab): Promise<number | undefined> {
  const chatId = telegramEnv().TELEGRAM_CHAT_ID
  if ((await topicRoute()) === 'unavailable') return undefined

  const slug = beatTopicSlug(beat.slug)
  const known = await topicIds(chatId)
  return ensureTopic(chatId, slug, beatTabName(beat), null, known[slug])
}

/**
 * What `setBeatTopicOpen` was able to do. Three outcomes, not a boolean: two of
 * these are perfectly normal and mean different things to the reader, and
 * collapsing them told the owner of a real tab that they had none.
 */
export type BeatTabToggle =
  /** Telegram accepted it — the tab is now closed, or open again. */
  | 'changed'
  /** The beat has never delivered, so there is no tab to close. Not an error. */
  | 'no-tab'
  /** This chat type has no close/reopen. Also not an error — see below. */
  | 'unsupported'

/**
 * Closes or reopens a beat's tab, following `/pause` and `/resume`.
 *
 * A closed topic keeps everything in it readable and refuses new messages, which
 * is exactly what a paused beat is: nothing is deleted, and the reader can still
 * scroll what it sent ([ADR-0019](../../docs/decisions/0019-beats-as-reader-owned-data.md)
 * made pause a soft delete for the same reason).
 *
 * **`closeForumTopic` does not exist for private-chat topics — probed
 * 2026-07-29.** Against the live bot with `has_topics_enabled: true`, both
 * `closeForumTopic` and `reopenForumTopic` answer
 * `Bad Request: the chat is not a supergroup forum`, while `editForumTopic` on
 * the same chat and the same id answers `TOPIC_ID_INVALID` — so renaming is
 * supported there and closing simply is not. Bot API 9.3's release notes list the
 * methods extended to private chats and close/reopen are absent from that list,
 * which now reads as deliberate rather than as an omission. The call is kept
 * because the supergroup-forum route is a real deployment of this bot (it is the
 * fallback for anyone who cannot reach the BotFather toggle), and there it works.
 *
 * **Never creates a tab.** A beat paused before it ever delivered has no row, and
 * making one just to close it would leave an empty tab that only the pause
 * produced.
 */
export async function setBeatTopicOpen(beat: BeatTab, open: boolean): Promise<BeatTabToggle> {
  const chatId = telegramEnv().TELEGRAM_CHAT_ID
  const existing = (await topicIds(chatId))[beatTopicSlug(beat.slug)]
  if (existing === undefined) return 'no-tab'

  try {
    await callBotApi(open ? 'reopenForumTopic' : 'closeForumTopic', {
      chat_id: chatId,
      message_thread_id: existing.messageThreadId,
    })
    return 'changed'
  } catch (error) {
    // Matched on the text because Telegram has no error code for it. Narrow on
    // purpose: any other failure is a real one and must still reach the caller.
    if (error instanceof Error && /not a supergroup forum/i.test(error.message)) {
      return 'unsupported'
    }
    throw error
  }
}

/**
 * Forgets a topic whose id Telegram has rejected, so the next run re-creates it.
 *
 * Deleting a tab on the phone leaves the row behind, and every later send to it
 * fails identically. Callers that catch a send failure call this and retry flat;
 * self-healing on the *next* run is deliberate — recreating a tab mid-digest
 * would scatter one batch across two tabs.
 */
export async function invalidateTopic(slug: TabSlug): Promise<void> {
  await forgetTopic(telegramEnv().TELEGRAM_CHAT_ID, slug)
}
