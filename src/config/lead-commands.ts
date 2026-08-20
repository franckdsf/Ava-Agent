/**
 * The prospecting commands — the reader's hands on who Joob looks for
 * ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
 *
 * These write `client_profiles`, which the restated
 * [invariant 8](../../AGENTS.md#invariants) permits on the same grounds as
 * `/target`: configuration a *future* run reads, never anything a run produced.
 * Nothing here touches a fit score, a vision verdict, a delivery, or a run in
 * flight.
 *
 * They live beside the job commands in Joob's chat rather than in a bot of their
 * own. ADR-0038: a job, a mission and a client are three shapes of *find me paid
 * work*, for one person, on one cadence, against one portfolio — and the day the
 * two command sets start confusing each other is the day the bot splits.
 *
 * **"Client", not "ICP".** The reader's language, not sales jargon — the same
 * rule that made these `/target` rather than `/query`.
 */

export interface LeadCommandDefinition {
  /** One short sentence for Telegram's command menu. No markdown — it renders literally. */
  description: string
  /** One line for `/start` and the unknown-command reply. Markdown is fine here. */
  help: string
  /** Shown when the arguments don't parse. */
  usage: string
}

export const LEAD_COMMANDS = {
  '/client': {
    description: 'Tell me what you sell and who should buy it',
    help:
      'tell me who you want to work with, in a sentence. `/client I shoot product ' +
      'photos for DTC skincare brands that just raised`. I show you what I understood.',
    usage:
      '`/client <what you sell, and to whom>` — for example `/client ad creative for ' +
      'seed-stage SaaS, English-speaking, no crypto`.',
  },
  '/clients': {
    description: 'List who I am currently prospecting for',
    help: 'everything I am currently prospecting for, with the filters for each.',
    usage: '`/clients` — takes no arguments.',
  },
  '/unclient': {
    description: 'Stop prospecting for one kind of client',
    help: 'stop prospecting for one of them. Nothing already sent is lost. `/unclient dtc-skincare`.',
    usage: '`/unclient <slug>` — `/clients` lists the slugs.',
  },
  /**
   * Re-parses an existing profile in place, keeping its slug.
   *
   * The same command `/retarget` is for searches, and it exists for the same
   * measured reason ([ADR-0036](../../docs/decisions/0036-a-source-may-declare-its-field-and-a-search-may-be-re-read.md)):
   * `/client` upserts on the slug the *model* produces, so re-describing a
   * profile in different words can silently create a second row competing for the
   * same companies while the first keeps running with the criteria the reader was
   * trying to change.
   *
   * With no new wording it re-runs today's parser over the request already
   * stored — the backfill case, for a profile written before the parser gained a
   * field.
   */
  '/reclient': {
    description: 'Re-read one client profile, keeping its name',
    help:
      're-read one of them without creating a second. `/reclient dtc-skincare` re-runs ' +
      'what you already said; add new wording to change it.',
    usage: '`/reclient <slug> [new wording]` — `/clients` lists the slugs.',
  },
} as const satisfies Record<string, LeadCommandDefinition>

export type LeadCommand = keyof typeof LEAD_COMMANDS

export const leadCommands = LEAD_COMMANDS as Record<string, LeadCommandDefinition>

export function isLeadCommand(command: string): command is LeadCommand {
  return command in LEAD_COMMANDS
}
