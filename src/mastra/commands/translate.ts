import type { Mastra } from '@mastra/core'
import { TRANSLATIONS, type TranslationCommand, translation } from '../../config/translation.js'
import { capText, chunkText } from '../../services/article.js'
import { escapeMarkdown, sendToTelegram } from '../../services/telegram.js'
import { translateChunk } from '../agents/translator.js'
import {
  articleHeading,
  quotedArticleSource,
  type SlashCommandEvent,
  type Source,
} from './article-context.js'

/**
 * `/translearn` and `/translate` — the article in the reader's own language,
 * with the English kept in view.
 *
 * See [ADR-0017](../../../docs/decisions/0017-translation-commands.md). Two
 * properties of the surrounding system make this a command rather than a tool
 * on Ava:
 *
 * - **A slash command never reaches the agent.** The adapter routes any message
 *   whose first entity is a `bot_command` to `processSlashCommand` and skips the
 *   message path entirely, so this runs in the catch-all handler in
 *   `channels.ts` rather than as something Ava decides to call.
 * - **The swipe still survives.** `handleSlashCommandUpdate` passes the untouched
 *   Telegram payload through as `event.raw` (verified in `@chat-adapter/telegram`
 *   4.35), so the message a reader replied to is readable here exactly as it is
 *   on the message path — same parser, same link-to-item lookup, same id.
 *
 * Read-only over the pipeline, like everything else on this surface
 * ([invariant 8](../../../AGENTS.md#invariants)): it reads `items` and
 * `memories`, may fetch a page the feed shipped no body for, and writes nothing.
 */

/** True when this command is one of the translation commands. */
export function isTranslationCommand(command: string): command is TranslationCommand {
  return command in TRANSLATIONS
}

/**
 * Where a translation lands: its own tab, never the conversation.
 *
 * A translated article is several thousand characters over several messages,
 * and putting that in Chat buries whatever was being discussed — the same
 * reasoning that keeps digests in News ([invariant 9](../../../AGENTS.md#invariants)).
 *
 * The reader typed the command somewhere else, so this *is* an answer arriving
 * in a tab they are not looking at. That is the intended behaviour and Telegram
 * handles it: the tab floats to the top of the list with an unread badge the
 * moment the first message lands. The one reply that stays in the conversation
 * is `nothingToTranslate` — no translation exists, so there is nothing to file.
 */
const TRANSLATION_TAB = 'translations' as const

/**
 * Runs one translation command end to end, sending as it goes.
 *
 * Parts are translated **in sequence and sent as each lands**, rather than
 * assembled and sent at the end. That costs nothing — the calls were always
 * going to be sequential, since each carries forward the language the first one
 * resolved — and it buys the two things a long translation needs most: the
 * reader sees the opening of the article in seconds instead of waiting out the
 * whole piece against a typing indicator that expired after five, and a failure
 * in part three leaves parts one and two delivered rather than losing
 * everything.
 *
 * Never throws. A command that fails silently is the bug the catch-all handler
 * in `channels.ts` exists to prevent, so every path here ends in a message.
 */
export async function runTranslation(
  mastra: Mastra,
  event: SlashCommandEvent,
  command: TranslationCommand,
): Promise<void> {
  const source = await resolveSource(event)
  if (!source) {
    await sendToTelegram(nothingToTranslate(command), 'chat')
    return
  }

  const parts = chunkText(source.text, translation.sourceChunkChars)
  await sendToTelegram(starting(source, parts.length), TRANSLATION_TAB)

  let language: string | undefined
  let sent = 0

  for (const [index, part] of parts.entries()) {
    try {
      const result = await translateChunk(mastra, {
        text: part,
        definition: TRANSLATIONS[command],
        language,
        part: { index: index + 1, total: parts.length },
      })
      language ??= result.language.trim() || undefined
      await sendToTelegram(
        renderTranslation(source, result.paragraphs, { index: index + 1, total: parts.length }),
        TRANSLATION_TAB,
      )
      sent += 1
    } catch (error) {
      mastra.getLogger()?.error('Translation failed', { command, part: index + 1, error })
      // With the partial output, not in Chat: "the rest is missing" only means
      // something next to the parts that did arrive.
      await sendToTelegram(failed(sent, parts.length), TRANSLATION_TAB)
      return
    }
  }
}

/**
 * What to translate, in the order the reader most likely meant.
 *
 * Text typed after the command wins outright — that is an explicit instruction,
 * and it is also the only path that works with no swipe at all. Everything after
 * it is the shared swipe resolution, so this and `/summarize` cannot disagree
 * about what the article is.
 *
 * **The argument means something different here than it does to `/summarize`,**
 * where it names the target language. That divergence is deliberate and it is
 * the reason these two commands cannot share one argument parser: `/translate`
 * has a language already (the reader's, from Ava's notes) and no other use for
 * free text, while `/summarize` has a fixed default language and needs a way to
 * override it.
 */
async function resolveSource(event: SlashCommandEvent): Promise<Source | undefined> {
  const typed = event.text.trim()
  if (typed) return { kind: 'text', text: capText(typed, translation.maxSourceChars) }

  return quotedArticleSource(event.raw, translation.maxSourceChars)
}

/**
 * One message of the translation.
 *
 * Structure from the template, prose from the model — the same split the digest
 * writer uses, and for the same reason: the article's URL must be exactly right,
 * and a model that writes its own markdown eventually breaks a link.
 *
 * The heading rides on the first part only and the source footer on the last, so
 * a multi-part translation reads as one article rather than as three copies of
 * the same header. The part marker is what ties them together, and it is omitted
 * entirely when there is only one.
 *
 * Exported because it is the only part of this file that can be checked without
 * sending: pure, and the piece most likely to be wrong. A message whose blocks
 * collapse into one run-on line is invisible in code and obvious through
 * `formatConverter.toAst()`.
 */
export function renderTranslation(
  source: Source,
  paragraphs: string[],
  part: { index: number; total: number },
): string {
  // Not escaped, unlike the digest's bullets. The model writes markdown here on
  // purpose — headings, lists, fenced code, and the italics inside every gloss —
  // and `escapeMarkdown` would backslash every one of those characters, which is
  // exactly what made the first version unreadable: `\### Titre` and
  // `(\_released\_)` on the phone. The article's link is still not the model's to
  // write, which is the part that had to stay protected; it is templated below.
  const body = paragraphs
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .join('\n\n')

  const marker = part.total > 1 ? `${part.index}/${part.total}` : null
  const footer = [
    ...(part.index === part.total && source.kind === 'article'
      ? [source.article.source, source.article.subtopic]
      : []),
    marker,
  ]
    .filter((value): value is string => Boolean(value))
    .map(escapeMarkdown)
    .join(' · ')

  // Blank lines, not newlines: a single newline is a soft wrap in markdown and
  // collapses into the previous line when Telegram renders it.
  return [
    ...(part.index === 1 && source.kind === 'article' ? [articleHeading(source.article), ''] : []),
    body,
    ...(footer ? ['', `_${footer}_`] : []),
  ].join('\n')
}

/**
 * Sent before the first part, and it is not decoration.
 *
 * **`deepseek-v4-flash` has no usable latency here — it has a range.** Ten runs
 * against the same 1556-character chunk on 2026-07-28: 9s, 11.6s, 21.1s, 25.7s,
 * 52.8s, 68s, 107s, 160.8s, 207.7s, 282.8s. That is a factor of thirty, and it
 * does not track output length — the run that emitted the *fewest* words took
 * 107s while a denser one took 21s. So there is no number to quote and no point
 * tuning against one; the honest statement is that a part takes somewhere
 * between ten seconds and five minutes.
 *
 * Which is exactly why this exists. A reader who sees nothing for four minutes
 * concludes the bot is broken, and nothing else covers the gap — the adapter
 * sends `sendChatAction` once and Telegram expires it after ~5s, and this path
 * cannot stream, because a slash command is answered with `postMessage` rather
 * than through the agent's channel.
 *
 * Faster models were measured for the orchestrator and rejected here on cost:
 * this command emits several thousand characters per part, several parts per
 * article, and `deepseek-v4-flash` is cheaper by orders of magnitude. Waiting is
 * the deliberate trade — so it is announced rather than endured.
 *
 * Naming the part count is the useful half: it is the difference between "this
 * is slow" and "this is a five-part article".
 */
function starting(source: Source, parts: number): string {
  const what = source.kind === 'article' ? `_${escapeMarkdown(source.article.title)}_` : 'your text'
  const scale = parts > 1 ? ` — ${parts} parts, sent as each is ready` : ''
  return `⏳ Translating ${what}${scale}.`
}

/**
 * The reply when there is nothing to work on.
 *
 * English, like `/start` and the unknown-command reply: these are the bot
 * talking about itself, and the reader's language is only known through a model
 * call this path deliberately does not make.
 */
function nothingToTranslate(command: TranslationCommand): string {
  return [
    `${escapeMarkdown(command)} needs something to translate.`,
    `Swipe to reply on an article and send ${escapeMarkdown(command)} on its own, ` +
      `or type the text after it: \`${command} your text here\`.`,
    `_${escapeMarkdown(command)} — ${TRANSLATIONS[command].help}_`,
  ].join('\n\n')
}

/** Said after a failure, and it has to name how much did arrive. */
function failed(sent: number, total: number): string {
  if (sent === 0) return 'The translation failed and nothing was sent. Try again in a moment.'
  return `The translation failed after part ${sent} of ${total}. What arrived above is complete; the rest is missing.`
}
