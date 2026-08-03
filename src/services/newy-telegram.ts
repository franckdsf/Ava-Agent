import { NEWY_BOT } from '../config/bots.js'
import type { NewyTopicSlug } from '../config/newy-topics.js'
import { createTelegramTransport, type SendTarget, type TelegramTransport } from './telegram.js'

/**
 * Newy's outbound transport — the one the news pipeline sends through.
 *
 * A named singleton rather than a call to `createTelegramTransport` at each site,
 * because the caches inside it are the point: a digest resolves the tab set once
 * per process, not once per article. Constructing a second transport for the same
 * bot would be correct but would pay for the tabs again.
 *
 * It reads as an extra file for one line, and it earns that by making ownership
 * explicit at every call site. `sendArticle(...)` said nothing about which chat
 * it meant while there was only one; `newyTelegram.sendArticle(...)` cannot be
 * misread once there are two, and a job-side caller reaching for it is visible in
 * review rather than at runtime.
 *
 * Nothing is constructed eagerly here — the adapter is built on first send — so
 * importing this with Telegram unconfigured stays free.
 */
export const newyTelegram: TelegramTransport<NewyTopicSlug> =
  createTelegramTransport(NEWY_BOT)

/** What Newy may be asked to send to: one of her three tabs, or a beat. */
export type NewySendTarget = SendTarget<NewyTopicSlug>
