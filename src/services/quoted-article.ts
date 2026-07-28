import { pipeline } from '../config/pipeline.js'
import type { Item } from '../db/types.js'
import { itemForLink } from './rss.js'
import { type QuotedMessage, quotedMessage } from './telegram-reply.js'

/**
 * What a reader pointed at with a swipe-to-reply: the message itself, and the
 * stored article it turns out to be — if it is one.
 *
 * Split out of `src/mastra/channels.ts` when a second caller appeared. Two
 * inbound paths need this exact pair and they must not answer it differently: a
 * reader who swipes a digest and asks a question, and a reader who swipes the
 * same digest and types `/translate`, are pointing at the same thing. The
 * lookup lives here rather than in `telegram-reply.ts` because that module is
 * deliberately pure parsing with no I/O, and this reads the database.
 *
 * Read-only, so [invariant 8](../../AGENTS.md#invariants) holds: at most
 * `quotedLinkLookups` primary-key reads, nothing written.
 */

export interface QuotedSource {
  /** The message replied to, flattened out of whichever shape it arrived in. */
  quoted: QuotedMessage
  /** The stored article it links to, or null when it links to nothing we hold. */
  article: Item | null
}

/**
 * The quoted message and its article, or undefined when this isn't a reply.
 *
 * Takes `unknown` because that is how the raw payload is typed on both paths —
 * `Message.raw` on a channel handler, `event.raw` on a slash command.
 */
export async function quotedSource(raw: unknown): Promise<QuotedSource | undefined> {
  const quoted = quotedMessage(raw)
  if (!quoted) return undefined
  return { quoted, article: await quotedArticle(quoted.links) }
}

/**
 * The stored article a quoted message points at, if any.
 *
 * First hit wins: a digest carries exactly one link and it is the article's, so
 * anything after it is a link Ava wrote into a later message. How a URL becomes
 * a row is `itemForLink`'s business — all that is decided here is how many of a
 * quoted message's links are worth trying.
 */
async function quotedArticle(links: string[]): Promise<Item | null> {
  for (const link of links.slice(0, pipeline.quotedLinkLookups)) {
    const item = await itemForLink(link)
    if (item) return item
  }
  return null
}
