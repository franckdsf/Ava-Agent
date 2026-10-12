import type { Mastra } from '@mastra/core'
import type { AgentChannels } from '@mastra/core/channels'
import { escapeMarkdown } from '../services/telegram.js'
import { publishCommands, publishProfile } from '../services/telegram-topics.js'
import type { ChatSurface } from './chat-surface.js'
import { runCommand, type Command } from './commands/command.js'

/**
 * Every bot's slash commands, its menu and its profile — written once, from the bot's surface.
 *
 * **Why a catch-all at all.** A leading `/` never reaches the agent: verified in
 * `@chat-adapter/telegram` 4.35, `handleSlashCommandUpdate` claims any message whose first entity is
 * a `bot_command` and returns `true`, which makes `processUpdate` skip the message path entirely —
 * and with no `onSlashCommand` handler registered the Chat SDK iterates an empty list and drops it.
 * `/start` was once silently doing nothing. So every branch below ends in a message.
 *
 * **Why one registrar.** There used to be one per bot, and they were the same code around a
 * different `if` chain; a fix to one did not reach the other. What differs between bots is data —
 * its commands, its `/start`, its failure wording — and lives on its surface
 * ([04-BLUEPRINT Part 1](../../docs/audit/04-BLUEPRINT.md#part-1--a-bot-is-a-definition-f3-f12)).
 */

/** A bot's commands, grouped as `/start` and the unknown-command reply list them. */
export interface CommandSection<Slug extends string = string> {
  /** Shown bold above the group. A bot with one group needs none. */
  heading?: string
  commands: Command<Slug>[]
}

/** Everything about one bot that its slash-command surface is built from. */
export interface BotSurface<Slug extends string = string> extends ChatSurface<Slug> {
  /** In menu order, which is also the order `/start` lists them. */
  sections: CommandSection<Slug>[]
  /** What `/start` answers with. Takes the surface so it can embed `commandList`. */
  welcome(surface: BotSurface<Slug>): Promise<string> | string
  /** The bot's own wording for a command that threw. */
  failed(command: string, error: unknown): string
}

/**
 * Registers the slash commands, once the Chat SDK instance exists, then publishes the menu and the
 * profile.
 *
 * `channels.sdk` is null until `initialize()` resolves, and Mastra starts that itself while
 * registering the agent — so this awaits the same promise rather than starting a second one
 * (`initialize` returns the in-flight one). Null channels — the bot's token is unset — return
 * immediately, which is the normal state for a bot until it is provisioned.
 *
 * There is a sliver of a window between polling starting and this landing, in which a `/start` is
 * dropped. That is the status quo for every command, and it closes on the next one.
 */
export async function registerBot<Slug extends string>(
  mastra: Mastra,
  surface: BotSurface<Slug>,
  channels: AgentChannels | null,
): Promise<void> {
  if (!channels) return
  const byName = commandsByName(surface)
  await channels.initialize(mastra)
  const sdk = channels.sdk
  if (!sdk) return

  sdk.onSlashCommand(async event => {
    await surface.transport.ensureTopics()

    const command = byName.get(event.command)
    if (command) {
      await runCommand(
        command,
        {
          mastra,
          event,
          bot: surface.bot,
          transport: surface.transport,
          chatTab: surface.chatTab,
          args: event.text.trim(),
        },
        surface.failed,
      )
      return
    }

    await surface.transport.sendToTelegram(
      event.command === '/start' ? await surface.welcome(surface) : unknown(surface, event.command),
      surface.chatTab,
    )
  })

  // The menu Telegram offers when the reader types `/`. Fire-and-forget and deliberately after the
  // handler is registered: a failure here costs the menu, never the commands themselves.
  void publishCommands(surface.bot, commandMenu(surface)).catch(error => {
    mastra.getLogger()?.error(`Failed to publish the Telegram command menu for ${surface.bot.id}`, error)
  })

  // Name and descriptions, from the bot's definition. Same disposition as the menu — a bot whose
  // profile page is stale still delivers — and the same reason for being here: a container brought
  // up against a fresh token should provision itself, leaving BotFather's Threaded Mode as the only
  // manual step. Diffs before writing, because `setMyName` is flood-limited per token.
  void publishProfile(surface.bot)
    .then(changed => {
      if (changed.length > 0) {
        mastra.getLogger()?.info(
          `Published the Telegram profile for ${surface.bot.id}: ${changed.map(entry => entry.field).join(', ')}`,
        )
      }
    })
    .catch(error => {
      mastra.getLogger()?.error(`Failed to publish the Telegram profile for ${surface.bot.id}`, error)
    })
}

/**
 * Every command by name — and the guard that a name is taken once. Two sections offering the same
 * command would leave one of them unreachable with nothing to say so, so it throws at boot instead.
 */
function commandsByName<Slug extends string>(surface: BotSurface<Slug>): Map<string, Command<Slug>> {
  const byName = new Map<string, Command<Slug>>()
  for (const command of surface.sections.flatMap(section => section.commands)) {
    if (command.name === '/start' || byName.has(command.name)) {
      throw new Error(`${surface.bot.id} offers ${command.name} twice`)
    }
    byName.set(command.name, command)
  }
  return byName
}

/** The `/` menu: `/start` first, because it is what a new reader reaches for, then every section. */
export function commandMenu(surface: BotSurface): { command: string; description: string }[] {
  return [
    { command: '/start', description: 'What I do, and how to talk to me' },
    ...surface.sections.flatMap(section =>
      section.commands.map(command => ({ command: command.name, description: command.description })),
    ),
  ]
}

/**
 * One line per command, for `/start` and the unknown-command reply.
 *
 * Reads `help` rather than `description`: the menu is read while typing and has a 256-character cap,
 * this is read sitting still. Built from the same objects the menu is, so a command cannot be offered
 * in one place and unknown in the other.
 */
export function commandList(surface: BotSurface): string {
  return surface.sections
    .map((section, index) =>
      [
        ...(section.heading ? [`**${section.heading}**`] : []),
        ...(index === 0 ? ['- `/start` — this message.'] : []),
        ...section.commands.map(command => `- \`${command.name}\` — ${command.help}`),
      ].join('\n'),
    )
    .join('\n\n')
}

/** Commands are swallowed before the agent sees them, so an unknown one needs its own reply. */
export function unknown(surface: BotSurface, command: string): string {
  return [
    `${escapeMarkdown(command)} isn't a command I know. What I have:`,
    commandList(surface),
    `For anything else, just say it in plain words.`,
  ].join('\n\n')
}
