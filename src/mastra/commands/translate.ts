import type { Mastra } from '@mastra/core'
import { TRANSLATIONS, type TranslationCommand, translation } from '../../config/translation.js'
import { capText, chunkText } from '../../services/article.js'
import { escapeMarkdown, sendToTelegram } from '../../services/telegram.js'
import { type Translation, translateChunk } from '../agents/translator.js'
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
 * **Part one alone, then every remaining part at once.** The article used to be
 * translated strictly in sequence, which made a five-part piece five of
 * `deepseek-v4-flash`'s 9s–283s waits end to end. Only the *first* of those is
 * load-bearing: it resolves the reader's language from Ava's notes, and every
 * later part is pinned to what it decided so a long article cannot switch
 * language halfway through (see `translateChunk`). Once that answer exists there
 * is nothing left for the parts to tell each other, so they all go out together
 * and the article costs roughly two waits rather than N.
 *
 * The gate is the reason this is not one `Promise.all` over `parts`. Firing part
 * one with the rest would mean six independent readings of the same notes, which
 * is the failure ADR-0017 pinned the language to avoid — and it would buy one
 * wait, exactly the one the reader is already watching a message about.
 *
 * **Delivery stays in order.** The calls settle in whatever order the provider
 * finishes them, so the loop below walks the parts by index and awaits each in
 * turn: a part that landed early waits its turn in `inFlight` and is sent the
 * instant its predecessor has been, and a part still running holds the ones
 * behind it. That is the queue — awaiting an already-running promise costs
 * nothing, so no separate buffer, no flush lock, and no way for `2/5` to arrive
 * after `3/5`.
 *
 * Parts are still **sent as each lands** rather than assembled and sent at the
 * end, which is what a failure in part three needs: parts one and two are
 * already delivered rather than lost with it.
 *
 * The one thing concurrency costs is a wasted call. A sequential run stopped
 * spending at the part that failed; here parts four and five are already in
 * flight when part three fails, and their results are dropped on the floor.
 * That is a few thousand tokens of the cheapest model in the system against
 * minutes of a human's waiting, and there is no signal to cancel them with —
 * `generate()` is not handed an `AbortSignal` on this path.
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
  const [opening, ...remaining] = parts
  // Only reachable on text that is nothing but whitespace, which `resolveSource`
  // already refuses — but the empty article has to go somewhere, and the usage
  // message is the honest place.
  if (!opening) {
    await sendToTelegram(nothingToTranslate(command), 'chat')
    return
  }

  await sendToTelegram(starting(source, parts.length), TRANSLATION_TAB)

  const translate = (text: string, index: number, language?: string) =>
    translateChunk(mastra, {
      text,
      definition: TRANSLATIONS[command],
      language,
      part: { index, total: parts.length },
    })

  const deliver = (result: Translation, index: number) =>
    sendToTelegram(
      renderTranslation(source, result.paragraphs, { index, total: parts.length }),
      TRANSLATION_TAB,
    )

  const fail = async (error: unknown, index: number, sent: number) => {
    mastra.getLogger()?.error('Translation failed', { command, part: index, error })
    // With the partial output, not in Chat: "the rest is missing" only means
    // something next to the parts that did arrive.
    await sendToTelegram(failed(sent, parts.length), TRANSLATION_TAB)
  }

  let first: Translation
  try {
    first = await translate(opening, 1)
  } catch (error) {
    await fail(error, 1, 0)
    return
  }

  // Launched before part one is sent, so the fan-out is already running while
  // Telegram takes the first message.
  const language = first.language.trim() || undefined
  const inFlight = remaining.map((part, offset) => settled(translate(part, offset + 2, language)))

  await deliver(first, 1)
  let sent = 1

  for (const [offset, pending] of inFlight.entries()) {
    const outcome = await pending
    if (outcome.status === 'rejected') {
      await fail(outcome.reason, offset + 2, sent)
      return
    }
    await deliver(outcome.value, offset + 2)
    sent += 1
  }
}

type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }

/**
 * A promise that reports its failure instead of throwing it.
 *
 * Not cosmetic: the parts run concurrently and are read one at a time, so part
 * five can reject while part two is still being awaited. A rejection with no
 * handler attached in the turn it happens is an `unhandledRejection`, which Node
 * treats as fatal by default — the command would take the process down with it
 * rather than telling the reader the translation stopped. Attaching the handler
 * at launch is what makes reading them in order safe.
 */
function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    value => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  )
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
      ? [source.article.source, source.subtopic]
      : []),
    marker,
  ]
    .filter((value): value is string => Boolean(value))
    .map(escapeMarkdown)
    .join(' · ')

  // Blank lines, not newlines: a single newline is a soft wrap in markdown and
  // collapses into the previous line when Telegram renders it.
  return [
    ...(part.index === 1 && source.kind === 'article' ? [articleHeading(source.article, source.emoji), ''] : []),
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
