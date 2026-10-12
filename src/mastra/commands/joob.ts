import { transportFor } from '../../bots/index.js'
import { JOOB_BOT, JOOB_TOPICS, type JoobTopicSlug } from '../../bots/joob.js'
import { escapeMarkdown } from '../../services/telegram.js'
import { commandList, type BotSurface } from '../registrar.js'
import { CLIENT_COMMANDS } from './clients.js'
import { TARGET_COMMANDS } from './targets.js'

/**
 * Joob's slash-command surface: its commands, its `/start`, and how it says a command failed.
 *
 * One section, unheaded: the job and prospecting commands sit together because ADR-0038 put both
 * halves in one chat on the argument that finding a job and finding a client are two shapes of one
 * thing. The day the two sets start confusing each other is the day the bot splits.
 */
export const JOOB_SURFACE: BotSurface<JoobTopicSlug> = {
  bot: JOOB_BOT,
  transport: transportFor(JOOB_BOT),
  chatTab: 'chat',
  sections: [{ commands: [...TARGET_COMMANDS, ...CLIENT_COMMANDS] }],
  welcome,
  // Names the error: a reader editing their own search is better served by the cause than by a
  // promise that nothing changed — the write may have landed before what failed.
  failed: (command, error) =>
    `\`${escapeMarkdown(command)}\` failed: ${escapeMarkdown(error instanceof Error ? error.message : String(error))}`,
}

/**
 * What `/start` answers with, and the only place Joob's three tabs are explained.
 *
 * **Both halves are named, in one message.** ADR-0038 put prospecting in this chat on the argument
 * that finding a job and finding a client are two shapes of one thing; if that cannot be said in a
 * paragraph a reader follows, the argument was wrong and the bot should split.
 *
 * Says outright that nothing runs until a search is set. A welcome that described the finished
 * product would be the first thing a reader saw and the first thing to be wrong — and they would
 * spend a week wondering why nothing arrived.
 *
 * A single newline inside any entry is a soft wrap that collapses two blocks into one run-on line,
 * which is invisible in code and obvious through `formatConverter.toAst()`. Blank lines between
 * blocks, always.
 */
function welcome(surface: BotSurface<JoobTopicSlug>): string {
  return [
    `## Hi, I'm Joob 💼`,
    `I look for paid work that would actually suit you — roles you could take, and companies that should be hiring you — and I tell you what fits and what doesn't, rather than forwarding everything with your keywords in it.`,
    `Three tabs:`,
    `- **${JOOB_TOPICS.chat.title}** — talk to me here. Tell me what you're after, ask about anything I've sent, or think out loud about a move.\n` +
    `- **${JOOB_TOPICS.jobs.title}** — where job matches land, one message each. I push there and don't answer there.\n` +
    `- **${JOOB_TOPICS.leads.title}** — where companies worth approaching land, with the reason they're worth it *this week* and an opening you could send.`,
    `For roles, start with \`/target\` in a sentence — *senior frontend in Paris or remote EU, TypeScript, no consultancies*. For clients, \`/client\` — *I shoot product photos for DTC skincare brands that just raised*. I'll show you exactly what I understood either way, and you correct me by saying it again. **Until you've set one, I have nothing to look for.**`,
    `Then I check the boards every couple of days and score what I find against your CV; separately I watch for companies with a fresh reason to need you, and look at their site before I say so. Whatever clears the bar lands in its tab with the reasons it fits and the places it falls short. A quiet run says so here rather than leaving you guessing.`,
    `I share what I know about you with Newy, in your other chat — one of you, one set of notes. Tell either of us something and we both know it.`,
    `Commands:`,
    commandList(surface),
  ].join('\n\n')
}
