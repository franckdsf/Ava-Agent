import type { NewyTopicSlug } from '../../bots/newy.js'
import { summary } from '../../config/summary.js'
import { escapeMarkdown } from '../../services/telegram.js'
import { summarizeSource } from '../agents/summarizer.js'
import {
  articleHeading,
  quotedArticleSource,
  type Source,
} from './article-context.js'
import type { Command, CommandContext } from './command.js'

/**
 * `/summarize [language]` — the swiped article explained at length.
 *
 * See [ADR-0018](../../../docs/decisions/0018-summarize-command.md). It is a
 * command rather than a tool on Newy for the two reasons the translation commands
 * are ([ADR-0017](../../../docs/decisions/0017-translation-commands.md)): a
 * slash command never reaches the agent, and the swipe survives on `event.raw`
 * so the message a reader replied to is readable here exactly as it is on the
 * message path.
 *
 * Read-only over the pipeline, like everything else on this surface
 * ([invariant 8](../../../AGENTS.md#invariants)): it reads `items`, may fetch a
 * page the feed shipped no body for, and writes nothing. It does not read
 * `memories` at all — the language is typed, not remembered.
 */

/**
 * Where a summary lands: Chat, with every other reader-triggered reply.
 *
 * **Not its own tab, and that is a decision rather than an omission.** A
 * translation got one because it is several thousand characters over several
 * messages and would bury a conversation
 * ([invariant 9](../../../AGENTS.md#invariants)); a summary is a few hundred
 * words in a single message, which is exactly the size of thing Chat is for.
 * `/start`, the unknown-command reply and `nothingToTranslate` already answer
 * here on the same reasoning.
 *
 * The cost, stated plainly: this message is pushed with `postMessage` rather
 * than produced through Newy's channel, so it never enters the Chat thread's
 * memory and she does not know she "said" it. A reader who follows up with
 * "what did you mean by the second point?" is asking about something she cannot
 * see. That is already true of every other command reply, and the fix — routing
 * it through her — is what this command exists to avoid.
 */
const SUMMARY_TAB = 'chat' as const

export const summarize = {
  name: summary.command,
  description: 'Summarize the article you swiped, in any language',
  help:
    'a detailed summary of the article. In English by default — add a language ' +
    'to get it in that one: `/summarize fr`.',
  // Sends its own messages — an acknowledgement, then the summary — and catches
  // its own failure, which has a wording of its own.
  run: async ctx => {
    await runSummary(ctx)
  },
} satisfies Command<NewyTopicSlug>

/**
 * Runs `/summarize` end to end.
 *
 * Never throws on a model failure — that has its own message below. Anything
 * else is caught by `runCommand`, so every path ends in a message.
 */
async function runSummary({ mastra, event, transport, args }: CommandContext<NewyTopicSlug>): Promise<void> {
  const requested = args
  if (requested && !summary.languageArgument.test(requested)) {
    await transport.sendToTelegram(notALanguage(requested), SUMMARY_TAB)
    return
  }

  const source = await quotedArticleSource(event.raw, summary.maxSourceChars)
  if (!source) {
    await transport.sendToTelegram(nothingToSummarize(), SUMMARY_TAB)
    return
  }

  await transport.sendToTelegram(starting(source, requested), SUMMARY_TAB)

  try {
    const result = await summarizeSource(mastra, {
      text: source.text,
      language: requested || summary.defaultLanguage,
      kind: 'article',
    })
    await transport.sendToTelegram(renderSummary(source, result.paragraphs, result.language), SUMMARY_TAB)
  } catch (error) {
    mastra.getLogger()?.error('Summary failed', { language: requested || null, error })
    await transport.sendToTelegram(failed(), SUMMARY_TAB)
  }
}

/**
 * One message: the article's heading, the summary, and a footer naming the
 * source and the language it came back in.
 *
 * Structure from the template, prose from the model — the same split the digest
 * writer and the translator use, and for the same reason: a model that writes
 * its own markdown eventually breaks a link, and the article's URL must be
 * exactly right.
 *
 * The language belongs in the footer rather than in an acknowledgement because
 * it is the only report of what the model actually resolved the argument to.
 * `/summarize protuguese` comes back footed "English", which tells the reader
 * what happened without the command having to reject anything.
 *
 * Exported because it is the only part of this file that can be checked without
 * sending: pure, and the piece most likely to be wrong. A message whose blocks
 * collapse into one run-on line is invisible in code and obvious through
 * `formatConverter.toAst()`.
 */
export function renderSummary(source: Source, paragraphs: string[], language: string): string {
  // Not escaped. The model writes markdown here on purpose — paragraphs, `- `
  // bullets, bold lead-ins, inline code — and `escapeMarkdown` would backslash
  // every one of those characters, which is what made the first version of the
  // translation message unreadable. The article's link is still not the model's
  // to write; it is templated below.
  const body = paragraphs
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .join('\n\n')

  const footer = [
    ...(source.kind === 'article' ? [source.article.source, source.subtopic] : []),
    language.trim(),
  ]
    .filter((value): value is string => Boolean(value))
    .map(escapeMarkdown)
    .join(' · ')

  // Blank lines, not newlines: a single newline is a soft wrap in markdown and
  // collapses into the previous line when Telegram renders it.
  return [
    ...(source.kind === 'article' ? [articleHeading(source.article, source.emoji), ''] : []),
    body,
    ...(footer ? ['', `_${footer}_`] : []),
  ].join('\n')
}

/**
 * Sent before the call, and it is not decoration.
 *
 * This is one model call over up to `summary.maxSourceChars` of article, and it
 * has no partial output to send on the way — unlike a translation, which covers
 * its own latency by delivering part 1 while part 2 is still running. So the
 * reader stares at nothing for the whole call, the adapter's typing indicator
 * expires after ~5s, and this path cannot stream because a slash command is
 * answered with `postMessage` rather than through the agent's channel. A reader
 * who sees nothing concludes the bot is broken.
 *
 * Naming the language back as it was typed is the useful half: it confirms the
 * argument was read as an argument, which is the one thing about this command
 * that is easy to get wrong from the outside.
 */
function starting(source: Source, requested: string): string {
  const what = source.kind === 'article' ? `_${escapeMarkdown(source.article.title)}_` : 'your text'
  return `⏳ Summarizing ${what}${requested ? `, in \`${requested}\`` : ''}.`
}

/**
 * The replies when there is nothing to work on.
 *
 * English, like `/start` and the unknown-command reply: these are the bot
 * talking about itself, and the language the reader wanted is either untyped or
 * unusable on both of these paths.
 */
function nothingToSummarize(): string {
  return [
    `${escapeMarkdown(summary.command)} needs an article to work on.`,
    `Swipe to reply on an article and send ${escapeMarkdown(summary.command)} on its own for ` +
      `${summary.defaultLanguage}, or name a language after it: \`${summary.command} fr\`.`,
    `_${escapeMarkdown(summary.command)} — ${summarize.help}_`,
  ].join('\n\n')
}

/** Said when the argument is not shaped like a language — a pasted article, usually. */
function notALanguage(requested: string): string {
  return [
    `${escapeMarkdown(summary.command)} takes a language, and that doesn't look like one.`,
    `Send it on its own for ${summary.defaultLanguage}, or name a language — a code like ` +
      `\`fr\` or \`ru\`, or its name: \`${summary.command} russian\`.`,
    `The article itself comes from a swipe: reply to one and send the command on its own.`,
  ].join('\n\n')
}

/** Said after a failure. Nothing partial exists to point at — it is one call. */
function failed(): string {
  return 'The summary failed and nothing was sent. Try again in a moment.'
}
