import { createTelegramAdapter } from '@chat-adapter/telegram'
import { ConsoleLogger } from '@mastra/core/logger'
import { allowedTelegramUserIds, telegramEnv } from '../config/env.js'
import type { BotDefinition } from '../bots/index.js'
import { pipeline } from '../config/pipeline.js'
import { chunkText } from './article.js'
import { beatTopicSlug, type TabSlug } from '../config/topics.js'
import {
  invalidateTopic,
  resolveBeatTopic,
  resolveTopics,
  type BeatTab,
} from './telegram-topics.js'

/**
 * Outbound Telegram only — the push half of the surface.
 *
 * `postMessage` never touches the adapter's `ChatInstance`; only the inbound
 * paths (`handleWebhook`, `startPolling`, and the `process*` handlers) do. That
 * was the open question in [ADR-0002](../../docs/decisions/0002-telegram-via-chat-sdk-adapter-in-polling-mode.md):
 * a cron fire has no incoming message to reply to. It was verified against the
 * compiled adapter and by sending, so the documented fallback to a second
 * Telegram library is not needed — this module and the conversational surface
 * share one adapter package.
 *
 * `mode` is deliberately unset on every instance built here, and that is now an
 * invariant rather than a detail: it selects webhook vs polling for *receiving*,
 * and nothing built here ever receives. Each agent registers its own polling
 * adapter through `channels.adapters`, and exactly one adapter may poll **per
 * bot token** ([invariant 7](../../AGENTS.md#invariants)).
 *
 * **One transport per bot.** This used to be a module of free functions over
 * module-level singletons, which was right while there was one token and one
 * chat. A second agent means a second of each
 * ([ADR-0023](../../docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)),
 * so the adapter and both caches are now instance state and the entry point is
 * `createTelegramTransport`. `escapeMarkdown` and `splitForTelegram` stay free
 * functions: neither one knows which bot it is serving, and neither should.
 */

/**
 * Backslash-escapes the characters that actually open inline markup, so a title
 * containing `*`, `_` or `[` renders literally instead of silently starting
 * emphasis and swallowing the rest of the message.
 *
 * Deliberately narrower than MarkdownV2's escape set. Telegram parses this as
 * markdown, where `.`, `-`, `+` and `#` are only meaningful at the start of a
 * block — escaping them inline is invisible when it works and produces
 * `kotlinx\.atomicfu` and `50\.7` when anything downstream doesn't unescape.
 * Version numbers and hyphenated words are far too common here to risk it.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>~|]/g, '\\$&')
}

/**
 * Splits on the widest boundary that fits, because the adapter *truncates* at
 * Telegram's 4096-character cap rather than splitting — a long digest would
 * lose its tail silently.
 *
 * The splitting itself is `chunkText`, shared with the translator, which needs
 * the identical property at a different ceiling. This wrapper is what names
 * Telegram's cap, so no caller has to know it.
 */
export function splitForTelegram(
  text: string,
  max: number = pipeline.telegramMaxMessageChars,
): string[] {
  return chunkText(text, max)
}

/**
 * Where a message may go: one of this bot's system tabs by slug, or a beat,
 * which resolves to its own tab ([ADR-0021](../../docs/decisions/0021-a-tab-per-beat.md)).
 *
 * A beat is passed as the whole row rather than as a slug because resolving its
 * tab needs the name to create it with, and the alternative — a slug plus a
 * database read inside the transport — would put a `beats` query underneath
 * every send.
 *
 * `Slug` is the bot's own tab union, so a slug belonging to the other bot is a
 * type error rather than a message into the void.
 */
export type SendTarget<Slug extends string> = Slug | BeatTab

/**
 * One destination in the fallback chain: the thread to post to, and what to
 * forget if Telegram rejects it.
 */
interface Hop {
  /** Row to drop when this thread turns out to be gone. Absent for the flat chat. */
  slug?: TabSlug
  /** Set when this hop is a beat's tab, so its memoized id goes with the row. */
  beatSlug?: string
  threadId: string
}

/** The outbound surface for one bot. */
export interface TelegramTransport<Slug extends string> {
  /**
   * Provisions this bot's tabs if they don't exist yet, and returns their thread
   * ids.
   *
   * The first caller pays for it, whoever that is — a digest, an inbound
   * message, or `/start`. Nothing schedules provisioning at boot on purpose:
   * Telegram rejects a `createForumTopic` against a chat the user has never
   * started, so the first *inbound* event is the earliest moment it can succeed.
   */
  ensureTopics(): Promise<Partial<Record<Slug, number>>>
  /**
   * The adapter's thread id for a topic, or for the flat chat when topics are
   * unavailable. `encodeThreadId` is the adapter's own encoding
   * (`telegram:<chatId>[:<threadId>]`) — building that string by hand would
   * break the moment the adapter changes it.
   */
  topicThreadId(topic?: Slug): Promise<string>
  /**
   * The chat a thread id belongs to, via the adapter's own decoder.
   *
   * Used by the inbound router to tell "a tab of this bot's chat" from "some
   * other conversation" without parsing `telegram:<chatId>:<threadId>` by hand.
   * Decoding is pure, so borrowing this outbound instance costs nothing and
   * keeps the format in one place.
   */
  chatIdFromThreadId(threadId: string): string
  /**
   * Sends to this bot's chat, into `target`'s tab when one exists.
   *
   * Chunks are sent in order and awaited individually so Telegram preserves
   * ordering; a mid-send failure throws with earlier chunks already delivered,
   * which the caller must treat as a partial send rather than a no-op.
   *
   * A tab deleted on the phone leaves its row behind and every send to it fails.
   * The first such failure drops the row and moves to the next hop, so a digest
   * still arrives; the tab is recreated on the next run rather than mid-batch,
   * which would split one batch across two tabs.
   */
  sendToTelegram(text: string, target?: SendTarget<Slug>): Promise<number>
  /**
   * Sends a notice that must never affect the run sending it — a run notice, a
   * "couldn't read your CV", a command's "working on it". Resolves false
   * rather than throwing, and logs the failure: a notice that never arrived
   * used to leave nothing to find
   * ([audit F5](../../docs/audit/03-FLAWS.md#-f5--fifteen-silent-failures)).
   *
   * Not for anything the reader is owed — an article, a brief, a lead. A failed
   * delivery must reach its caller so the claim on it is released.
   */
  notify(text: string, target?: SendTarget<Slug>): Promise<boolean>
  /**
   * Sends an article, with its image when there is one.
   *
   * Telegram fetches the image URL itself and rejects anything unreachable, too
   * large, or the wrong shape — and it rejects the *whole message*, not just the
   * picture. Retrying without the image trades a decoration for the article,
   * which is the right way round. Only the first chunk carries the image; a
   * split message shouldn't repeat it.
   *
   * `target` is required, and used to default to `'news'`. A default here is the
   * kind that hides a mistake rather than saving a keystroke: every article
   * belongs to exactly one beat, so a call site that has not said which beat is
   * a call site that has lost track of it — and the symptom would be a digest in
   * the wrong tab, which is what that change existed to fix.
   */
  sendArticle(
    text: string,
    imageUrl: string | null | undefined,
    target: SendTarget<Slug>,
  ): Promise<number>
}

/**
 * Builds one bot's outbound transport.
 *
 * Nothing here touches the environment: the adapter is built on first send so
 * the news pipeline still runs with Telegram unconfigured, and so a second bot
 * that has no token yet costs nothing at import time.
 */
export function createTelegramTransport<Slug extends string>(
  bot: BotDefinition<Slug>,
): TelegramTransport<Slug> {
  let adapter: ReturnType<typeof createTelegramAdapter> | undefined
  /** Mastra's own default logger, so a failed notice lands beside every other log line. */
  const logger = new ConsoleLogger({ name: `telegram:${bot.id}` })

  /** Built on first send so the news pipeline runs with Telegram unconfigured. */
  const client = (): ReturnType<typeof createTelegramAdapter> => {
    adapter ??= createTelegramAdapter({
      botToken: telegramEnv(bot).botToken,
      allowedUserIds: allowedTelegramUserIds(bot),
    })
    return adapter
  }

  /**
   * Memoized because `resolveTopics()` costs a `getMe` plus a table read, and a
   * digest calls it once per article. Topic ids are stable for the life of a
   * process — the only thing that changes them is a tab being deleted, which
   * `invalidateTopic` handles by clearing this alongside the row.
   */
  let topicCache: Promise<Partial<Record<Slug, number>>> | undefined

  /**
   * Beat tabs, resolved one at a time and remembered for the life of the process.
   *
   * Separate from `topicCache` because the two are populated differently: the
   * system tabs are a fixed list resolved in one batch on first use, while beats
   * arrive whenever one first wins an article and there is no moment at which the
   * set of them is known to be complete.
   *
   * **Only successful resolutions go in.** Caching a failure would route a beat to
   * News until the next restart on the strength of one bad `createForumTopic`, and
   * nothing would ever say why; a beat that failed to resolve is simply retried on
   * its next article.
   */
  const beatTopicCache = new Map<string, number>()

  const ensureTopics = (): Promise<Partial<Record<Slug, number>>> => {
    topicCache ??= resolveTopics(bot)
    return topicCache
  }

  /** One beat's tab, memoized, or undefined when there is no tab to be had. */
  const ensureBeatTopic = async (beat: BeatTab): Promise<number | undefined> => {
    const cached = beatTopicCache.get(beat.slug)
    if (cached !== undefined) return cached

    // Asking the system tabs first is what keeps this cheap when Threaded Mode is
    // off: that answer is memoized, while `resolveBeatTopic` would pay for its own
    // `getChat`/`getMe` on every article to learn the same thing.
    if (Object.keys(await ensureTopics()).length === 0) return undefined

    const id = await resolveBeatTopic(bot, beat)
    if (id !== undefined) beatTopicCache.set(beat.slug, id)
    return id
  }

  /**
   * The ordered list of places one message may land, best first.
   *
   * A beat degrades to News and then to the flat chat; a system tab degrades
   * straight to flat. Every chain ends in the flat chat, which is always sendable
   * — that is what lets the send loop treat "ran out of hops" as impossible.
   *
   * A beat whose tab cannot be *created* falls back rather than throwing. The
   * digest turning up in News is a visible, self-explaining symptom, and a far
   * better one than the article not arriving: News is documented as a tab that
   * should be silent, so anything in it is a report that this happened.
   */
  const threadChain = async (target?: SendTarget<Slug>): Promise<Hop[]> => {
    const chatId = telegramEnv(bot).chatId
    const flat: Hop = { threadId: client().encodeThreadId({ chatId }) }
    if (!target) return [flat]

    const hop = (slug: TabSlug, messageThreadId: number, beatSlug?: string): Hop => ({
      slug,
      beatSlug,
      threadId: client().encodeThreadId({ chatId, messageThreadId }),
    })

    if (typeof target === 'string') {
      const id = (await ensureTopics())[target]
      return id === undefined ? [flat] : [hop(target, id), flat]
    }

    const chain: Hop[] = []
    const beatTopic = await ensureBeatTopic(target).catch(() => undefined)
    if (beatTopic !== undefined) {
      chain.push(hop(beatTopicSlug(target.slug), beatTopic, target.slug))
    }

    // The beat fallback is Newy's News tab. A bot without one — Joob — simply
    // has a shorter chain, since `ensureTopics` cannot return a slug it has no
    // definition for.
    const news = (await ensureTopics())['news' as Slug]
    if (news !== undefined) chain.push(hop('news', news))

    chain.push(flat)
    return chain
  }

  const sendToTelegram = async (text: string, target?: SendTarget<Slug>): Promise<number> => {
    const chunks = splitForTelegram(text)
    const chain = await threadChain(target)

    for (const [attempt, hop] of chain.entries()) {
      let sent = 0
      try {
        for (const chunk of chunks) {
          // `markdown` is the formatted path: Telegram parses it server-side into
          // rich blocks — headings, lists, photos — rather than applying a parse mode.
          await client().postMessage(hop.threadId, { markdown: chunk })
          sent += 1
        }
        return chunks.length
      } catch (error) {
        // Only worth moving on before the first chunk lands. Past that the message
        // is already half-delivered into this tab, and restarting it elsewhere
        // would duplicate what arrived.
        if (sent > 0 || attempt === chain.length - 1) throw error
        if (hop.slug) await invalidateTopic(bot, hop.slug)
        if (hop.beatSlug) beatTopicCache.delete(hop.beatSlug)
        else topicCache = undefined
      }
    }

    // Unreachable: every chain ends in the flat chat, which either sends or throws
    // above. Present so the signature needs no non-null assertion.
    return 0
  }

  return {
    ensureTopics,

    async topicThreadId(topic?: Slug): Promise<string> {
      const chatId = telegramEnv(bot).chatId
      if (!topic) return client().encodeThreadId({ chatId })
      const messageThreadId = (await ensureTopics())[topic]
      return client().encodeThreadId(
        messageThreadId === undefined ? { chatId } : { chatId, messageThreadId },
      )
    },

    chatIdFromThreadId(threadId: string): string {
      return client().decodeThreadId(threadId).chatId
    },

    sendToTelegram,

    async notify(text: string, target?: SendTarget<Slug>): Promise<boolean> {
      try {
        await sendToTelegram(text, target)
        return true
      } catch (error) {
        const tab = target === undefined ? 'chat' : typeof target === 'string' ? target : target.slug
        logger.warn(`Notice to ${bot.id}'s ${tab} tab not sent`, {
          error: error instanceof Error ? error.message : String(error),
          text: text.slice(0, 120),
        })
        return false
      }
    },

    async sendArticle(
      text: string,
      imageUrl: string | null | undefined,
      target: SendTarget<Slug>,
    ): Promise<number> {
      if (!imageUrl) return sendToTelegram(text, target)
      try {
        return await sendToTelegram(`![](${imageUrl})\n\n${text}`, target)
      } catch {
        return sendToTelegram(text, target)
      }
    },
  }
}
