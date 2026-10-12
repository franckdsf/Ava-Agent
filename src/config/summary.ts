import { pipeline } from './pipeline.js'

/**
 * `/summarize` — the swiped article explained at length, in a language named on
 * the command line.
 *
 * Separate from `translation.ts` for the reason that file is separate from
 * `pipeline.ts`: nothing here touches ingest, ranking or delivery. See
 * [ADR-0018](../../docs/decisions/0018-summarize-command.md).
 *
 * **The two commands look alike and their arguments mean opposite things.**
 * `/translate <text>` translates the text you typed; `/summarize <language>`
 * summarizes what you *swiped*, into the language you typed. That is why this is
 * its own config and its own handler rather than a third entry in `TRANSLATIONS`
 * — the entries there differ only in a prompt string, and this differs in what
 * the reader's own words are for.
 */

export const summary = {
  /** The literal Telegram command. */
  command: '/summarize' as const,

  /**
   * The language used when the reader types the command on its own.
   *
   * **English, deliberately — not the reader's language from Newy's notes.** The
   * translation commands read the notes because translating *into English* is
   * the one thing they can never usefully do; a summary has no such asymmetry,
   * and the articles are English, so an English summary is the cheap, obvious
   * default and the argument is there for when it isn't wanted. It also keeps
   * this path off `memories` entirely — one fewer read, and one fewer way for a
   * command to fail because of something Newy did or did not write down.
   */
  defaultLanguage: 'English',

  /**
   * What the argument is allowed to look like, before it reaches a model.
   *
   * The reader types a language, so this accepts letters, combining marks,
   * spaces, apostrophes and hyphens — `fr`, `ru`, `français`, `brazilian
   * portuguese`, `русский` — and nothing else. Two characters minimum because a
   * one-letter argument is a typo, not a language.
   *
   * The guard is on the *shape*, not on a list of languages: an allowlist of
   * codes would have to be an ISO-639 table to be honest, and would still reject
   * `brazilian portuguese`. Which language a token names is a judgement, and it
   * is exactly one judgement per command — the model makes it and reports back
   * what it decided. That is a very different proposition from the hundreds of
   * per-word judgements the translator asks for, where the prompt could not be
   * trusted.
   *
   * What this *does* buy is that nothing else can arrive: a reader who pastes an
   * article after `/summarize` gets the usage message instead of several
   * thousand characters silently interpreted as the name of a language.
   */
  languageArgument: /^[\p{L}\p{M}][\p{L}\p{M}\s'’-]{1,31}$/u,

  /**
   * Ceiling on the text one command will summarize.
   *
   * Matches `translation.maxSourceChars` and for the same reason: stored bodies
   * are already capped at `articleMaxChars` on the way in, so this binds only
   * the quoted-message path, and one number in the reader's head — whatever the
   * pipeline kept is what a command can work on — is worth more than a tuned
   * one.
   *
   * **Not chunked, unlike a translation.** A translation of part 3 is a valid
   * translation; a summary of part 3 is not a summary. The whole capped body
   * goes in one call, which is also what lets the summary decide for itself
   * which parts of the article mattered.
   */
  maxSourceChars: pipeline.articleMaxChars,
} as const
