import type { Mastra } from '@mastra/core'
import type { BotDefinition } from '../../bots/index.js'
import { commands } from '../../config/commands.js'
import type { TelegramTransport } from '../../services/telegram.js'
import type { SlashCommandEvent } from './article-context.js'

/**
 * A slash command is one object: its name, the three texts a reader sees about it, and its
 * handler — so the menu, `/start` and the unknown-command reply are all derived from the same
 * entry and cannot disagree about it
 * ([04-BLUEPRINT Part 2](../../../docs/audit/04-BLUEPRINT.md#part-2--a-command-is-a-definition-beside-its-handler-f12)).
 */

/** What a command is handed: the event, and the bot it arrived on. */
export interface CommandContext<Slug extends string = string> {
  mastra: Mastra
  event: SlashCommandEvent
  bot: BotDefinition<Slug>
  transport: TelegramTransport<Slug>
  /** The tab this bot answers in — where a reply goes unless the command names another. */
  chatTab: Slug
  /** What the reader typed after the command, trimmed. */
  args: string
}

export interface Command<Slug extends string = string> {
  name: `/${string}`
  /** One short sentence for Telegram's command menu: at most 256 characters, rendered literally. */
  description: string
  /** One line for `/start` and the unknown-command reply. Markdown is fine. */
  help: string
  /** Shown when the arguments don't parse. Absent on a command whose argument is optional. */
  usage?: string
  /** Where a returned reply is sent. The bot's chat tab when absent. */
  tab?: Slug
  /**
   * The holding message for a command that calls a model, sent if the reply takes longer than
   * `commands.ackAfterMs`. Absent on a command that only reads or writes a row — announcing those
   * would be noise.
   */
  working?: string
  /**
   * The reply as a string, which the runner sends to `tab`; or nothing, when the command sends its
   * own messages (a translation arrives as several, as each part comes back).
   */
  run(ctx: CommandContext<Slug>): Promise<string | void>
}

/**
 * Runs one command so that **every branch ends in a message**.
 *
 * A slash command is swallowed before the agent sees it, so one that fails silently is
 * indistinguishable from one that was never registered — that is why the catch is here, once,
 * rather than in each handler. `failed` is the bot's own wording for it.
 *
 * **The acknowledgement is a race between a timer and the reply**, and both orderings matter: a
 * fast reply stays one message, a slow one promises before it answers. The ack is awaited before
 * the reply is sent, because two sends racing could deliver the answer first and the promise to
 * answer second. The adapter dispatches slash commands without awaiting them, so a slow command
 * never blocks the bot's other traffic — only the reader's understanding of what is happening.
 */
export async function runCommand<Slug extends string>(
  command: Command<Slug>,
  ctx: CommandContext<Slug>,
  failed: (command: string, error: unknown) => string,
): Promise<void> {
  const tab = command.tab ?? ctx.chatTab
  const working = command.working
  let acknowledged: Promise<unknown> | null = null
  const timer = working
    ? setTimeout(() => {
        acknowledged = ctx.transport.notify(working, tab)
      }, commands.ackAfterMs)
    : null
  const settle = async () => {
    if (timer) clearTimeout(timer)
    if (acknowledged) await acknowledged
  }

  try {
    const reply = await command.run(ctx)
    await settle()
    if (typeof reply === 'string') await ctx.transport.sendToTelegram(reply, tab)
  } catch (error) {
    await settle()
    ctx.mastra.getLogger()?.error('Slash command failed', { bot: ctx.bot.id, command: command.name, error })
    // `notify`, not `sendToTelegram`: if Telegram itself is what failed, this must not throw
    // out of the handler — it logs instead.
    await ctx.transport.notify(failed(command.name, error), tab)
  }
}
