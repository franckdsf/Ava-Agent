/**
 * Joob's commands — the reader's hands on what it looks for.
 *
 * These write `job_searches`, which the restated
 * [invariant 8](../../AGENTS.md#invariants) permits: configuration a *future*
 * run reads, never anything a run produced. Nothing here touches a fit score, a
 * delivery, or a run in progress.
 *
 * `/target` takes free text and puts a model between the reader and the row, the
 * same shape `/follow` uses ([ADR-0020](../../docs/decisions/0020-feed-discovery-from-a-subject.md)):
 * a phone is a bad place to type `loc=Paris sen=senior,staff`, and the reader
 * should be able to say what they want in a sentence. `/targets` and `/untarget`
 * are deterministic — listing and archiving need no judgement, and a model that
 * could archive on inference would eventually archive on inference.
 *
 * `description` is Telegram's command menu, capped at 256 characters and read
 * while typing. `help` is read in `/start`, sitting still. Different audiences,
 * so they are different strings.
 */

export interface JobCommandDefinition {
  /** One short sentence for Telegram's command menu. No markdown — it renders literally. */
  description: string
  /** One line for `/start` and the unknown-command reply. Markdown is fine here. */
  help: string
  /** Shown when the arguments don't parse. */
  usage: string
}

export const JOB_COMMANDS = {
  '/target': {
    description: 'Tell me what kind of role to look for, in your own words',
    help:
      'tell me what to look for, in a sentence. `/target senior frontend in Paris ' +
      'or remote EU, TypeScript, no consultancies`. I show you what I understood.',
    usage:
      '`/target <what you want>` — for example `/target staff backend, remote in Europe, ' +
      'Go or Rust, at least 90k euros`.',
  },
  '/targets': {
    description: 'List what I am currently looking for',
    help: 'everything I am currently looking for, with the filters for each.',
    usage: '`/targets` — takes no arguments.',
  },
  '/untarget': {
    description: 'Stop looking for one kind of role',
    help: 'stop looking for one of them. Nothing already sent is lost. `/untarget frontend`.',
    usage: '`/untarget <slug>` — `/targets` lists the slugs.',
  },
} as const satisfies Record<string, JobCommandDefinition>

export type JobCommand = keyof typeof JOB_COMMANDS

export function isJobCommand(command: string): command is JobCommand {
  return command in JOB_COMMANDS
}

export const jobCommands = {
  /**
   * A slug, as the reader may type it into `/untarget`.
   *
   * Same shape beats use, and checked here so a typo is answered rather than
   * looked up. Forbids a colon for the reason `beatCommands.slugPattern` does —
   * nothing reader-supplied may collide with a namespaced key.
   */
  slugPattern: /^[a-z0-9][a-z0-9-]{0,47}$/,

  /**
   * Longest request `/target` accepts.
   *
   * Generous enough for a couple of sentences in any language, short enough that
   * a pasted job advert does not become a search definition. Unlike `/follow`
   * there is no web search downstream, so the cost of a long one is only a
   * larger parse prompt — but a reader pasting an entire posting means something
   * different from what this command does, and refusing is a better answer than
   * silently producing a search shaped like one advert.
   */
  requestMaxChars: 400,

  /** Searches `/targets` lists in full before it stops and says how many are left. */
  maxSearchesShown: 15,

  /**
   * How many searches may be active at once.
   *
   * Every active search costs a slice of the scoring prompt on every run, and
   * they compete for the same postings — past a handful the marginal one mostly
   * duplicates another. A cap that is reached is a prompt to prune rather than a
   * limit worth raising.
   */
  maxActiveSearches: 8,

  /**
   * Below this many hard constraints, a target is treated as too broad and the
   * advisor is asked for a tighter one.
   *
   * Three, because one constraint on its own — a stack, or a level — still lets
   * most of a board through. Measured on a real target with **zero**: the filter
   * dropped 5 postings out of 240, and the scorer's capped batch was filled with
   * whatever had been published most recently.
   */
  minConstraints: 3,
} as const
