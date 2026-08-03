import type { Mastra } from '@mastra/core'
import type { AgentChannels } from '@mastra/core/channels'
import { JOOB_BOT } from '../config/bots.js'
import { JOB_COMMANDS } from '../config/job-commands.js'
import { JOOB_TOPICS } from '../config/joob-topics.js'
import { joobTelegram } from '../services/joob-telegram.js'
import { escapeMarkdown } from '../services/telegram.js'
import { publishCommands, publishProfile } from '../services/telegram-topics.js'
import { isJobCommand, runJobCommand } from './commands/targets.js'

/**
 * Joob's slash commands, its menu and its profile.
 *
 * A separate module from `channels.ts` rather than a branch inside it: the two
 * agents share the *routing* (`chat-surface.ts`) and share nothing about what
 * they offer. Newy's file carries translations, beats and summaries; none of
 * them means anything here, and a single registrar taking a bot would end up as
 * one long conditional on which bot it was handed.
 *
 * The catch-all is the same trick and exists for the same reason: a leading `/`
 * never reaches the agent — `handleSlashCommandUpdate` claims any message whose
 * first entity is a `bot_command` and `processUpdate` then skips the message
 * path entirely — so an unregistered command is dropped without a trace. Every
 * branch below therefore ends in a message.
 */
export async function registerJoobCommands(
  mastra: Mastra,
  channels: AgentChannels | null,
): Promise<void> {
  if (!channels) return
  await channels.initialize(mastra)
  const sdk = channels.sdk
  if (!sdk) return

  sdk.onSlashCommand(async event => {
    await joobTelegram.ensureTopics()

    if (isJobCommand(event.command)) {
      // Writes `job_searches` and nothing else — configuration a future run
      // reads, which is what the restated invariant 8 permits. Sends its own
      // message, including on failure.
      await runJobCommand(mastra, event, event.command)
      return
    }

    await joobTelegram.sendToTelegram(
      event.command === '/start' ? welcome() : unknown(event.command),
      'chat',
    )
  })

  // Fire-and-forget, and deliberately after the handler is registered: a failure
  // here costs the menu, never the commands themselves.
  void publishCommands(JOOB_BOT, commandMenu()).catch(error => {
    mastra.getLogger()?.error("Failed to publish Joob's Telegram command menu", error)
  })

  // Diffs before writing — `setMyName` is flood-limited, and there are two
  // budgets to exhaust now that there are two bots.
  void publishProfile(JOOB_BOT)
    .then(changed => {
      if (changed.length > 0) {
        mastra.getLogger()?.info(
          `Published Joob's Telegram bot profile: ${changed.map(entry => entry.field).join(', ')}`,
        )
      }
    })
    .catch(error => {
      mastra.getLogger()?.error("Failed to publish Joob's Telegram bot profile", error)
    })
}

/**
 * Every command Joob offers, in menu order.
 *
 * Built from the same config the help text reads, so a command cannot be offered
 * by the menu and unknown to `/start` — the drift `channels.ts` avoids the same
 * way. `/start` first because it is what a new reader reaches for; the rest in
 * the order they are used, which is define, review, remove.
 */
function commandMenu(): { command: string; description: string }[] {
  return [
    { command: '/start', description: 'What I do, and how to talk to me' },
    ...Object.entries(JOB_COMMANDS).map(([command, definition]) => ({
      command,
      description: definition.description,
    })),
  ]
}

/**
 * The same commands as prose, for `/start` and the unknown-command reply.
 *
 * Reads `help` rather than `description`: the menu is read while typing and has
 * a 256-character cap, this is read sitting still. An earlier version reused
 * `description` and lowercased it to make it read as a clause, which turned
 * "What I do" into "what i do" — a pronoun is exactly the kind of thing a
 * blanket transform breaks, and it was invisible until the message was rendered.
 */
function commandList(): string {
  return [
    '- `/start` — this message.',
    ...Object.entries(JOB_COMMANDS).map(
      ([command, definition]) => `- \`${command}\` — ${definition.help}`,
    ),
  ].join('\n')
}

/**
 * What `/start` answers with, and the only place Joob's two tabs are explained.
 *
 * Says outright that the search is not running yet. A welcome that described the
 * finished product would be the first thing a reader saw and the first thing to
 * be wrong — and they would spend a week wondering why nothing arrived.
 *
 * A single newline inside any entry is a soft wrap that collapses two blocks
 * into one run-on line, which is invisible in code and obvious through
 * `formatConverter.toAst()`. Blank lines between blocks, always.
 */
export function welcome(): string {
  return [
    `## Hi, I'm Joob 💼`,
    `I look for work that would actually suit you — and tell you what fits and what doesn't, rather than forwarding everything with your keywords in it.`,
    `Two tabs:`,
    `- **${JOOB_TOPICS.chat.title}** — talk to me here. Tell me what you're after, ask about anything I've sent, or think out loud about a move.\n` +
    `- **${JOOB_TOPICS.jobs.title}** — where matches land, one message each. I push there and don't answer there.`,
    `Start with \`/target\`, in a sentence — *senior frontend in Paris or remote EU, TypeScript, no consultancies*. I'll show you exactly what I understood, and you can correct me by saying it again. **Until you've set one, I have nothing to look for.**`,
    `Then I check the boards every couple of days, score what I find against your CV, and put what clears the bar in **${JOOB_TOPICS.jobs.title}** — each one with the reasons it fits and the places it falls short. A quiet run says so here rather than leaving you guessing.`,
    `I share what I know about you with Newy, in your other chat — one of you, one set of notes. Tell either of us something and we both know it.`,
    `Commands:`,
    commandList(),
  ].join('\n\n')
}

/** Commands are swallowed before the agent sees them, so an unknown one needs its own reply. */
export function unknown(command: string): string {
  return [
    `${escapeMarkdown(command)} isn't a command I know. What I have:`,
    commandList(),
    `For anything else, just say it in plain words.`,
  ].join('\n\n')
}
