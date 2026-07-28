import type { TelegramMessage } from '@chat-adapter/telegram'
import { pipeline } from '../config/pipeline.js'
import { capText } from './article.js'

/**
 * Reads the message a reader swiped-to-reply on, off the raw Telegram payload.
 *
 * Pure parsing, no I/O and no adapter instance — the inbound handler in
 * `src/mastra/channels.ts` turns what this returns into context for Ava, and
 * `src/services/telegram.ts` stays what it says it is.
 *
 * Two things make this necessary rather than a field read:
 *
 * - **The adapter's types stop short of the wire.** `TelegramMessage` declares
 *   neither `reply_to_message` nor `quote` (verified in
 *   `@chat-adapter/telegram` 4.35 `dist/index.d.ts`), but `parseTelegramMessage`
 *   hands the untouched Telegram payload through as `Message.raw`, so both are
 *   there at runtime. The casts below are the type layer catching up, not a
 *   guess about the API.
 * - **A quoted digest may carry no `text` at all.** Digests go out as rich
 *   messages, so the reply comes back as `rich_message` blocks. `richMessageToText`
 *   is internal to the adapter, so the walk below is ours.
 */

/** What a reader pointed at, flattened out of whichever shape it arrived in. */
export interface QuotedMessage {
  /** Plain text of the message replied to, capped at `quotedMessageMaxChars`. */
  text: string
  /** The part the reader selected, when they highlighted one rather than the whole message. */
  fragment?: string
  /** Every URL the quoted message carried, in reading order, deduplicated. */
  links: string[]
}

/** The fields Telegram sends and the adapter's types don't declare. */
type InboundMessage = TelegramMessage & {
  message_thread_id?: number
  quote?: { text?: string }
  reply_to_message?: TelegramMessage & { forum_topic_created?: unknown }
}

type MessageEntity = NonNullable<TelegramMessage['entities']>[number]

/**
 * The quoted message, or undefined when this message isn't a reply to one.
 *
 * Takes `unknown` because that is how `Message.raw` is typed once it reaches a
 * channel handler — narrowing it here keeps the cast in one place.
 */
export function quotedMessage(raw: unknown): QuotedMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const message = raw as InboundMessage
  const reply = message.reply_to_message
  if (!reply) return undefined

  // A tab's own root message is not something the reader replied to. Telegram
  // hangs `reply_to_message` off messages that merely *live* in a topic, so
  // without this every message typed in a tab looks like a reply to its header.
  if (reply.message_id === message.message_thread_id) return undefined
  if ('forum_topic_created' in reply) return undefined

  const flat = flatten(reply)
  const fragment = message.quote?.text?.trim()

  return {
    text: capText(flat.text, pipeline.quotedMessageMaxChars),
    ...(fragment ? { fragment: capText(fragment, pipeline.quotedMessageMaxChars) } : {}),
    links: flat.links,
  }
}

/** Text and links out of a message, whichever of the three shapes it arrived in. */
function flatten(message: TelegramMessage): { text: string; links: string[] } {
  const plain = message.text ?? message.caption ?? ''
  const entities = message.entities ?? message.caption_entities ?? []
  const rich = message.rich_message ? fromRichMessage(message.rich_message) : undefined

  const text = plain || rich?.text || ''
  const links = [
    ...(rich?.links ?? []),
    ...fromEntities(plain, entities),
    // Nothing guarantees entities: a link pasted by a client that didn't mark it
    // up, or a rich block shape this walk doesn't know, still leaves the URL in
    // the text. Cheap, and the only cost of a false positive is a lookup miss.
    ...(text.match(/https?:\/\/[^\s<>()"'\]]+/g) ?? []),
  ]

  return { text: text.trim(), links: [...new Set(links)] }
}

/** `text_link` carries its target; a bare `url` entity is a span of the text. */
function fromEntities(text: string, entities: MessageEntity[]): string[] {
  const links: string[] = []
  for (const entity of entities) {
    if (entity.type === 'text_link' && entity.url) links.push(entity.url)
    else if (entity.type === 'url') links.push(text.slice(entity.offset, entity.offset + entity.length))
  }
  return links
}

/**
 * Keys that hold text or nested blocks in Telegram's rich message tree, in the
 * order they read.
 *
 * Walking by key rather than switching on `type` is deliberate: the block union
 * has twenty-odd variants and grows with roughly every Bot API release, so an
 * exhaustive switch is stale the month it ships. Restricting the walk to these
 * keys is what keeps a photo's `file_id` out of the text.
 *
 * `label` is deliberately absent. On a list item it is the bullet or the number,
 * not content — walking it produced `1First point.2Second point.`
 */
const TEXT_KEYS = ['summary', 'text', 'caption', 'blocks', 'items', 'cells', 'credit']

/** Of those, the ones holding block-level children, which read as separate lines. */
const BLOCK_KEYS = new Set(['blocks', 'items', 'cells'])

/** Flattens rich blocks to text, one line per top-level block, collecting URLs. */
function fromRichMessage(rich: NonNullable<TelegramMessage['rich_message']>): {
  text: string
  links: string[]
} {
  const lines: string[] = []
  const links: string[] = []

  for (const block of rich.blocks) {
    const collected = { text: [] as string[], links: [] as string[] }
    walk(block, collected)
    const line = collected.text.join('').trim()
    if (line) lines.push(line)
    links.push(...collected.links)
  }

  return { text: lines.join('\n'), links }
}

function walk(node: unknown, out: { text: string[]; links: string[] }): void {
  if (typeof node === 'string') {
    out.text.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return
  }
  if (!node || typeof node !== 'object') return

  const record = node as Record<string, unknown>
  // The linked title of a delivered article lands here — this is the field the
  // whole feature turns on.
  if (record.type === 'url' && typeof record.url === 'string') out.links.push(record.url)

  for (const key of TEXT_KEYS) {
    if (!(key in record)) continue
    const value = record[key]
    if (!BLOCK_KEYS.has(key) || !Array.isArray(value)) {
      walk(value, out)
      continue
    }
    // Bullets and table cells are their own lines. Without this the two points
    // under a digest run together into one sentence. Between siblings only:
    // separating on "anything collected so far" instead put a blank line before
    // every nested list item, since a list item's own blocks are an array too.
    for (const [index, child] of value.entries()) {
      if (index > 0) out.text.push('\n')
      walk(child, out)
    }
  }
}
