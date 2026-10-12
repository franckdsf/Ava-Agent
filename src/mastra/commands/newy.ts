import { transportFor } from '../../bots/index.js'
import { NEWY_BOT, NEWY_TOPICS, type NewyTopicSlug } from '../../bots/newy.js'
import { env } from '../../config/env.js'
import { pipeline } from '../../config/pipeline.js'
import { summary } from '../../config/summary.js'
import { TRANSLATIONS } from '../../config/translation.js'
import { activeBeats } from '../../db/beats.js'
import { escapeMarkdown } from '../../services/telegram.js'
import { commandList, type BotSurface } from '../registrar.js'
import { BEAT_COMMANDS } from './beats.js'
import { summarize } from './summarize.js'
import { translate, translearn } from './translate.js'

/**
 * Newy's slash-command surface: her commands, her `/start`, and how she says a command failed.
 *
 * Two sections because the list outgrew a flat run: reading commands work on an article you
 * swiped, beat commands work on the pipeline itself, and a reader hunting for one is never hunting
 * through the other. Reading first — a reader scrolling the menu is far more often looking for
 * `/summarize` than for `/removefeed`.
 */
export const NEWY_SURFACE: BotSurface<NewyTopicSlug> = {
  bot: NEWY_BOT,
  transport: transportFor(NEWY_BOT),
  chatTab: 'chat',
  sections: [
    { heading: 'Reading', commands: [summarize, translearn, translate] },
    { heading: 'Beats', commands: BEAT_COMMANDS },
  ],
  welcome,
  // The beat commands are the ones that write, and a failure there is answered with what the
  // reader most needs to know: their configuration was left as it was.
  failed: command => `${escapeMarkdown(command)} failed and nothing was changed. Try again in a moment.`,
}

/**
 * What `/start` answers with — and the only place the three tabs are explained.
 *
 * Built from the live beats and from config, so a new beat, a changed schedule
 * or a new command can't leave a stale description here
 * ([invariant 3](../../AGENTS.md#invariants)).
 *
 * Async, because the beats it lists are rows rather than a config array. It
 * sends nothing, so `bot-surface.test.ts` checks it without sending. A single newline inside any entry below is a soft wrap that collapses two
 * blocks into one run-on line, which is invisible in code and obvious through
 * `formatConverter.toAst()`.
 */
async function welcome(surface: BotSurface<NewyTopicSlug>): Promise<string> {
  const live = await activeBeats()
  // A reader whose beats are all archived, or a database seeded with none, gets
  // an invitation rather than an empty bullet list under a "Beats:" heading.
  const beats =
    live.length > 0
      ? live.map(beat => `- ${beat.emoji} ${beat.title}`).join('\n')
      : "- Nothing yet — tell me a subject to follow and I'll set one up."
  const hours = pipeline.digestHours.map(hour => `${String(hour).padStart(2, '0')}:00`)

  return [
    `## Hi, I'm Newy 😊`,
    `I'm here to help you keep up with the topics you care about. Use the ${NEWY_TOPICS.chat.title} tab to talk with me directly — every other tab is one I push to and don't answer in, so what you're reading stays tidy.`,
    `What I do:`,
    `- **${NEWY_TOPICS.chat.title}** — chat with me about anything, ask for details, or follow up on an article 📰.\n` +
    `- I keep our conversation in one place so your context stays intact.`,
    `- **One tab per beat** — each subject you follow gets its own 📅, and its digests go there and nowhere else.`,
    `- **${NEWY_TOPICS.translations.title}** — where ${Object.keys(TRANSLATIONS).join(' and ')} put an article once you've asked for it 📜.`,
    `Beats:`,
    beats,
    `A beat's tab appears the first time it has something to send you, so a brand new one is quiet until then. \`/pause\` closes a tab without deleting anything in it, and \`/resume\` opens it again.`,
    `Digests arrive at ${hours.join(', ')} ${env.AGENT_TIMEZONE}. Each article is delivered as its own message so you can read or save what matters.`,
    `Commands:`,
    commandList(surface),
    `The reading commands work on a swipe: reply to any article and send \`${summary.command}\`, \`/why\` or a translation on its own. The beat commands don't need one — they take a slug, and \`/beats\` lists them.`,
    `\`/why\` is the one worth knowing about: every beat scores every article it sees and writes down what it made of it, so you can swipe something and ask why it arrived — or swipe one I skipped and see what it scored.`,
    `${Object.keys(TRANSLATIONS).map(command => `\`${command}\``).join(' and ')} answer in your own language, with the English kept in view, in the ${NEWY_TOPICS.translations.title} tab — a long article arrives as several messages over a few minutes.`,
    `\`${summary.command}\` answers here in ${NEWY_TOPICS.chat.title}, as one message: the article explained properly rather than compressed. It writes in ${summary.defaultLanguage} unless you name a language after it — \`${summary.command} fr\`, \`${summary.command} ru\`, or the language's own name.`,
    // No command, on purpose — so it has to be said here or the reader never
    // finds it. A capability with no verb attached is invisible in a command
    // list, and this one is triggered by doing the thing you would do anyway.
    `**YouTube links need no command at all** 🎬 — paste one here and I'll read its transcript and explain what's actually in it, in your language. It works on a two-hour talk as well as a five-minute one; if a video has no captions there's nothing I can read, and I'll say so rather than guess.`,
    `If you want something specific, just ask — search the archive, show me a recent article, or tell me what interests you 😉.`,
  ].join('\n\n')
}
