/**
 * The beat-management commands — the reader's hands on their own beats.
 *
 * These are the first commands that **write**. Every other one on this surface
 * reads: `/summarize` and the translation commands touch nothing, and Newy's news
 * tools are read-only by construction. These write `beats` and `beat_feeds`,
 * which is what the restated
 * [invariant 8](../../AGENTS.md#invariants) permits — configuration the *next*
 * run reads, never anything a run produced
 * ([ADR-0019](../../docs/decisions/0019-beats-as-reader-owned-data.md)).
 *
 * Commands rather than tools on Newy, for the reason `/summarize` is one: the
 * adapter routes anything starting with `/` away from the agent entirely, and a
 * slash command carries the swipe on `event.raw`. There is a second reason here
 * — archiving a beat should happen because the reader asked for it in those
 * words, not because a model inferred it from a sentence about being tired of
 * design news.
 *
 * `description` is what Telegram shows in the command menu, pushed with
 * `setMyCommands`. It is a different audience from `help`: the menu has a hard
 * 256-character cap and is read while typing, so it is one short sentence with
 * no markdown. `help` is read in `/start`, where the reader is sitting still.
 */

export interface BeatCommandDefinition {
  /** One short sentence for Telegram's command menu. No markdown — it renders literally. */
  description: string
  /** One line for `/start` and the unknown-command reply. Markdown is fine here. */
  help: string
  /** Shown when the arguments don't parse. */
  usage: string
}

export const BEAT_COMMANDS = {
  '/follow': {
    description: 'Follow a new subject — I find the feeds for it myself',
    help:
      'follow a new subject. Say it in any language and I set the beat up and go ' +
      'looking for feeds. `/follow formula 1`.',
    usage: '`/follow <subject>` — for example `/follow formula 1` or `/follow cuisine japonaise`.',
  },
  '/beats': {
    description: 'List the beats I follow and how each one is doing',
    help: 'the beats I follow, with their feeds and what they did this week.',
    usage: '`/beats` — takes no arguments.',
  },
  '/beat': {
    description: 'Show one beat in full: its rubric, feeds and thresholds',
    help: 'one beat in full — its rubric, its feeds, its thresholds. `/beat design`.',
    usage: '`/beat <slug>` — for example `/beat design`. `/beats` lists the slugs.',
  },
  '/pause': {
    description: 'Stop a beat from ingesting, ranking and sending',
    help: 'stop a beat without losing it — nothing is deleted. `/pause design`.',
    usage: '`/pause <slug>` — for example `/pause design`.',
  },
  '/resume': {
    description: 'Start a paused beat again',
    help: 'start a paused beat again. `/resume design`.',
    usage: '`/resume <slug>` — for example `/resume design`.',
  },
  '/addfeed': {
    description: 'Add an RSS feed to a beat, checking it works first',
    help: 'add an RSS feed to a beat. I check it before saving it. `/addfeed design <url>`.',
    usage: '`/addfeed <slug> <url>` — for example `/addfeed design https://example.com/feed.xml`.',
  },
  '/removefeed': {
    description: 'Stop a beat pulling from one of its feeds',
    help: 'stop a beat pulling from a feed. Its old articles stay. `/removefeed design <url>`.',
    usage: '`/removefeed <slug> <url>` — `/beat <slug>` lists the URLs.',
  },
  '/why': {
    description: 'Explain how an article was scored, and why it was or was not sent',
    help: 'swipe an article and ask why it was sent — or why it was not.',
    usage: '`/why` — swipe to reply on an article and send it on its own.',
  },
} as const satisfies Record<string, BeatCommandDefinition>

export type BeatCommand = keyof typeof BEAT_COMMANDS

export const beatCommandNames = Object.keys(BEAT_COMMANDS) as BeatCommand[]

export function isBeatCommand(command: string): command is BeatCommand {
  return command in BEAT_COMMANDS
}

export const beatCommands = {
  /**
   * How far back `/beats` and `/beat` count when reporting what a beat has done.
   *
   * A week, so the answer covers a normal reading rhythm and a quiet weekend
   * doesn't read as a broken beat.
   */
  statsDays: 7,

  /** Feeds listed inline by `/beat` before it stops and says how many are left. */
  maxFeedsShown: 20,

  /**
   * A slug, as the reader may type it. Same shape the seeds use — lowercase,
   * hyphenated — checked here so a typo is answered rather than looked up.
   */
  slugPattern: /^[a-z0-9][a-z0-9-]{0,47}$/,

  /**
   * Longest subject `/follow` accepts.
   *
   * Generous enough for a sentence in any language, short enough that a pasted
   * article does not become a search query. The namer is cheap, but the *scout*
   * searches the open web, and a 2000-character "subject" produces eight sites
   * about nothing in particular.
   */
  subjectMaxChars: 200,
} as const
