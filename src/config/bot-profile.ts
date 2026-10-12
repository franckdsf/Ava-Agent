/**
 * What a bot looks like before anyone talks to it — its name, and the two
 * descriptions Telegram shows in different places.
 *
 * Config rather than a BotFather chore, for the reason the command menu is: a fresh deployment should end up
 * looking like the running one without a human retyping three fields into a
 * chat with @BotFather. Everything here is pushed at boot by `publishProfile()`.
 *
 * **Each bot has its own, in its file in `src/bots/`, and that is the whole reason there are two bots.** Of
 * the four profile methods only `setMyCommands` takes a `scope`; `setMyName`,
 * `setMyDescription` and `setMyShortDescription` take `language_code` and
 * nothing else. One token therefore means one name for every agent behind it —
 * which is what made a second token the answer rather than a shared bot
 * ([ADR-0023](../../docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)).
 *
 * **What this still cannot set: Threaded Mode.** That toggle has no API and is
 * the one prerequisite a container cannot provision for itself — without it the
 * tabs silently degrade to one flat stream. `pnpm telegram:check` reports it,
 * and there are now two bots to forget it on.
 *
 * The three fields have different audiences and are not interchangeable:
 *
 * - `name` — the chat title, on every message the bot sends.
 * - `shortDescription` — the bot's profile page, and link previews when the bot
 *   is shared. One sentence; it is read by someone deciding whether to open it.
 * - `description` — the empty-chat screen, above the Start button. Several
 *   sentences; it is read by someone who has already opened it and is deciding
 *   what to type.
 *
 * Writing the same value twice is not free — `setMyName` in particular is
 * flood-limited — so `publishProfile()` reads each field back and pushes only
 * what has drifted. In the steady state a boot costs three GETs and no writes.
 */

export interface BotProfile {
  /**
   * The bot's display name.
   *
   * Kept in config even though it changes about never, because leaving one field
   * to BotFather makes the whole set unreliable — "the profile is in config" is a
   * property worth having intact. The emoji is part of the name, not decoration
   * added at render time, which is why this is a plain string and not the
   * `emoji`/`title` split `src/config/topics.ts` uses for tabs.
   */
  name: string
  /**
   * Profile page and share previews. One sentence, written for someone who has
   * not used it yet — so it names what it does, not what it is built from.
   */
  shortDescription: string
  /**
   * The empty-chat screen, above Start.
   *
   * Longer than the short description on purpose: this one is read at the moment
   * a reader is deciding what to type, so it covers what they can actually do.
   *
   * Plain text, no markdown: Telegram renders this field literally, so backticks
   * and asterisks would arrive as backticks and asterisks.
   */
  description: string
}

/**
 * Telegram's caps on each field, from the API reference.
 *
 * **Not probe-verified, unlike most numbers in this repo** — confirming a cap
 * means sending an over-long value, and a wrong guess about where the boundary
 * sits overwrites the live profile with the test string instead of being
 * rejected. The methods themselves are verified: `setMyDescription` and
 * `setMyShortDescription` shipped in Bot API 6.6 (2023-03-09) and `setMyName` in
 * 6.7 (2023-04-21), read from the changelog, and all six getters answered
 * against the live bot on 2026-07-30.
 *
 * Enforced at boot because an over-long field is rejected outright rather than
 * truncated, and the failure would otherwise read as a network problem. Checking
 * here turns it into a message naming the field and the overshoot.
 */
export const PROFILE_LIMITS = {
  name: 64,
  shortDescription: 120,
  description: 512,
} as const

/**
 * Which fields of a profile are too long for Telegram to accept, if any.
 *
 * Exported so `pnpm telegram:check` can report it without a boot, and so the
 * check is one implementation rather than a copy that drifts from the one that
 * runs. Returns a list rather than throwing: the caller decides whether an
 * over-long name is worth failing over, and at boot it is not — a bot with a
 * stale description still delivers.
 *
 * Takes the profile as an argument rather than reading one, because there are
 * two of them now and a check that silently examined only the first would be
 * worse than no check.
 */
export function profileOverflows(profile: BotProfile): string[] {
  return Object.entries(PROFILE_LIMITS)
    .filter(([field, max]) => profile[field as keyof typeof PROFILE_LIMITS].length > max)
    .map(([field, max]) => {
      const length = profile[field as keyof typeof PROFILE_LIMITS].length
      return `${field} is ${length} characters, over Telegram's ${max}`
    })
}
