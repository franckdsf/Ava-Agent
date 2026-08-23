import { joobProfile, newyProfile, type BotProfile } from './bot-profile.js'
import { JOOB_TOPIC_LIST, type JoobTopicSlug } from './joob-topics.js'
import { NEWY_TOPIC_LIST, type NewyTopicSlug } from './newy-topics.js'
import type { TopicList } from './topics.js'

/**
 * The bots this process runs, one per agent.
 *
 * An agent owns a token, a chat and a tab set
 * ([ADR-0023](../../docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)),
 * and this is where those three are tied together. Everything that used to read
 * `telegramEnv()` from module scope — the outbound transport, topic
 * provisioning, the profile and menu publishers — is constructed against an
 * entry here instead.
 *
 * Nothing *below* the surface is split. One process, one Mastra instance, one
 * database, one migration set, one `memories` table, one
 * `AVA_MODEL_ORCHESTRATOR`. The registry is the seam, and it is deliberately
 * thin: a bot is an identity plus a set of tabs, not a second application.
 */

/**
 * A bot's identity, parameterized by the slugs of its own tabs.
 *
 * The type parameter is what survived making the transport generic. `TopicSlug`
 * used to be `keyof typeof TOPICS` — one closed union, correct while there was
 * one bot — and widening it to `string` would have cost the distinction between
 * a system tab and a beat tab that `BEAT_TOPIC_PREFIX` exists to protect. Each
 * bot declaring its own union keeps `sendToTelegram(text, 'chat')` checkable and
 * makes `sendToTelegram(text, 'jobs')` a type error in Newy's chat.
 */
export interface BotDefinition<Slug extends string = string> {
  /** Stable id. Names the bot in logs and keys its cached environment. */
  id: string
  /**
   * Prefix on this bot's own Telegram variables — `NEWY_TELEGRAM_BOT_TOKEN`,
   * `JOOB_TELEGRAM_BOT_TOKEN`, and the rarely-set `<PREFIX>TELEGRAM_CHAT_ID`
   * override.
   *
   * **What is prefixed is what is genuinely this bot's alone**, which since
   * [ADR-0041](../../docs/decisions/0041-one-deployment-one-reader.md) is the
   * token and nothing else. The reader is one `AVA_TELEGRAM_USER_ID` shared by
   * every bot here — `AVA_` because they belong to the system, not to an agent.
   *
   * Every bot has a prefix, including the first. Newy's variables were bare
   * `TELEGRAM_*` for as long as she was the only bot, and keeping them that way
   * was briefly argued for on the grounds that renaming costs an edit on every
   * deployment — there was one deployment, so that argument was worth very
   * little against a bare name that reads as "the default bot" sitting next to
   * an explicit `JOOB_`. Renamed 2026-08-03. That argument is worth more now
   * that there is a deployment per reader, and it still loses: a rename is one
   * line in each env file, and the prefix is what makes the *unprefixed* names
   * mean "the system".
   */
  envPrefix: string
  /** This bot's tabs, in creation order. Telegram decides display order. */
  topics: TopicList<Slug>
  /** Name and the two descriptions, pushed at boot by `publishProfile()`. */
  profile: BotProfile
}

export const NEWY_BOT: BotDefinition<NewyTopicSlug> = {
  id: 'newy',
  envPrefix: 'NEWY_',
  topics: NEWY_TOPIC_LIST,
  profile: newyProfile,
}

export const JOOB_BOT: BotDefinition<JoobTopicSlug> = {
  id: 'joob',
  envPrefix: 'JOOB_',
  topics: JOOB_TOPIC_LIST,
  profile: joobProfile,
}

/**
 * Every bot, for the paths that must act on all of them — provisioning at boot,
 * and `pnpm telegram:check`.
 *
 * A bot with no token configured is skipped by those paths rather than being
 * absent from here, so the list stays a statement about what this repo runs and
 * not about what one machine happens to have in its `.env`.
 */
export const BOTS: readonly BotDefinition<string>[] = [NEWY_BOT, JOOB_BOT]
