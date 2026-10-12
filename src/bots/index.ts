import type { BotProfile } from '../config/bot-profile.js'
import type { TopicList } from '../config/topics.js'
import { createTelegramTransport, type TelegramTransport } from '../services/telegram.js'
import { JOOB_BOT } from './joob.js'
import { NEWY_BOT } from './newy.js'

/**
 * The bots this process runs, one per agent.
 *
 * An agent owns a token, a chat and a tab set
 * ([ADR-0023](../../docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)),
 * and a file beside this one ties those three together for each. Everything that
 * acts on a bot — the outbound transport, topic provisioning, the profile and menu
 * publishers — is constructed against a definition rather than written per bot.
 *
 * Nothing *below* the surface is split. One process, one Mastra instance, one
 * database, one migration set, one `memories` table, one
 * `AVA_MODEL_ORCHESTRATOR`. A bot is an identity plus a set of tabs, not a second
 * application.
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

/**
 * Every bot, for the paths that must act on all of them — provisioning at boot,
 * and `pnpm telegram:check`.
 *
 * A bot with no token configured is skipped by those paths rather than being
 * absent from here, so the list stays a statement about what this repo runs and
 * not about what one machine happens to have in its `.env`.
 */
export const BOTS: readonly BotDefinition<string>[] = [NEWY_BOT, JOOB_BOT]

const transports = new Map<string, TelegramTransport<string>>()

/**
 * A bot's outbound transport — one per bot per process.
 *
 * Memoised because the caches inside the transport are the point: a digest
 * resolves the tab set once per process, not once per article, and a second
 * transport for the same bot would be correct but would pay for the tabs again.
 * That is why each bot used to have a named singleton file; this is those files
 * written once.
 *
 * Nothing is constructed eagerly — the adapter is built on first send — so a
 * module that takes its transport at import stays free while the bot's token is
 * unset, which is the normal state for Joob until it is provisioned.
 */
export function transportFor<Slug extends string>(bot: BotDefinition<Slug>): TelegramTransport<Slug> {
  let transport = transports.get(bot.id)
  if (!transport) {
    transport = createTelegramTransport(bot) as TelegramTransport<string>
    transports.set(bot.id, transport)
  }
  return transport as unknown as TelegramTransport<Slug>
}
