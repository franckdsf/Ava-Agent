import { JOOB_BOT } from '../config/bots.js'
import type { JoobTopicSlug } from '../config/joob-topics.js'
import { createTelegramTransport, type SendTarget, type TelegramTransport } from './telegram.js'

/**
 * Joob's outbound transport — where job matches are pushed.
 *
 * The same shape as `newy-telegram.ts` and for the same reason: the caches inside
 * are the point, and a named singleton per bot makes ownership visible at every
 * call site. `joobTelegram.sendToTelegram(...)` cannot be mistaken for Newy's
 * chat in review.
 *
 * Nothing is constructed eagerly — the adapter is built on first send — so this
 * import costs nothing while `JOOB_TELEGRAM_BOT_TOKEN` is unset, which is the
 * normal state until the bot is provisioned.
 */
export const joobTelegram: TelegramTransport<JoobTopicSlug> =
  createTelegramTransport(JOOB_BOT)

/**
 * What Joob may be asked to send to: one of its two tabs.
 *
 * `SendTarget` also admits a `BeatTab`, which Joob never has — beats are Newy's,
 * and Joob's searches deliberately share one tab
 * ([ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)).
 * Nothing prevents passing one; there is simply never one to pass.
 */
export type JoobSendTarget = SendTarget<JoobTopicSlug>
