import type { Mastra } from '@mastra/core'
import type { JoobTopicSlug } from '../../bots/joob.js'
import { JOOB_TOPICS } from '../../bots/joob.js'
import { LEAD_SIGNAL_KINDS, LEAD_SIGNAL_LABELS, leadPipeline } from '../../config/leads.js'
import {
  activeProfiles,
  allProfiles,
  archiveProfile,
  getProfile,
  upsertProfile,
} from '../../db/leads.js'
import type { ClientProfile } from '../../db/schema.js'
import { escapeMarkdown } from '../../services/telegram.js'
import { parseClient, slugify, type ParsedClient } from '../agents/lead-targeter.js'
import type { Command } from './command.js'

/**
 * `/client`, `/clients`, `/unclient` and `/reclient` — who Joob prospects for
 * ([ADR-0038](../../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
 *
 * The lead-side twin of `targets.ts`, and built to the same rules. All four
 * answer in Chat, as one message each. They write `client_profiles` and nothing
 * else — the configuration half of [invariant 8](../../AGENTS.md#invariants) —
 * so none of them starts a run and nothing here can reach a fit score, a vision
 * verdict or a delivery.
 *
 * They live beside the job commands in Joob's chat rather than in a bot of their
 * own. ADR-0038: a job, a mission and a client are three shapes of *find me paid
 * work*, for one person, on one cadence, against one portfolio — and the day the
 * two command sets start confusing each other is the day the bot splits.
 *
 * **"Client", not "ICP".** The reader's language, not sales jargon — the same
 * rule that made these `/target` rather than `/query`.
 *
 * Only `/client` and `/reclient` call a model, which is the inbound
 * human-triggered category invariant 2 carves out: a person typing, not a cron
 * fire nobody watches. They are the two with a `working` message.
 *
 * **The holding message says what not to do.** A parse was measured at 9s on one
 * run and 232.8s on the next; a reader left in silence retypes the command in
 * different words, and because `/client` upserts on the slug the *model*
 * produces, that makes a second row competing for the same companies — the
 * duplicate `/reclient` exists to repair.
 */

export const client: Command<JoobTopicSlug> = {
  name: '/client',
  description: 'Tell me what you sell and who should buy it',
  help:
    'tell me who you want to work with, in a sentence. `/client I shoot product ' +
    'photos for DTC skincare brands that just raised`. I show you what I understood.',
  usage:
    '`/client <what you sell, and to whom>` — for example `/client ad creative for ' +
    'seed-stage SaaS, English-speaking, no crypto`.',
  working: "Reading that — give me a moment. I'll show you exactly what I understood, and you can correct me then.",
  run: ({ mastra, args }) => addClient(mastra, args),
}

export const clients: Command<JoobTopicSlug> = {
  name: '/clients',
  description: 'List who I am currently prospecting for',
  help: 'everything I am currently prospecting for, with the filters for each.',
  usage: '`/clients` — takes no arguments.',
  run: async () => renderProfiles(await allProfiles()),
}

export const unclient: Command<JoobTopicSlug> = {
  name: '/unclient',
  description: 'Stop prospecting for one kind of client',
  help: 'stop prospecting for one of them. Nothing already sent is lost. `/unclient dtc-skincare`.',
  usage: '`/unclient <slug>` — `/clients` lists the slugs.',
  run: ({ args }) => removeClient(args),
}

/**
 * Re-parses an existing profile in place, keeping its slug.
 *
 * The same command `/retarget` is for searches, and it exists for the same
 * measured reason ([ADR-0036](../../../docs/decisions/0036-a-source-may-declare-its-field-and-a-search-may-be-re-read.md)):
 * `/client` upserts on the slug the *model* produces, so re-describing a
 * profile in different words can silently create a second row competing for the
 * same companies while the first keeps running with the criteria the reader was
 * trying to change.
 *
 * With no new wording it re-runs today's parser over the request already
 * stored — the backfill case, for a profile written before the parser gained a
 * field.
 */
export const reclient: Command<JoobTopicSlug> = {
  name: '/reclient',
  description: 'Re-read one client profile, keeping its name',
  help:
    're-read one of them without creating a second. `/reclient dtc-skincare` re-runs ' +
    'what you already said; add new wording to change it.',
  usage: '`/reclient <slug> [new wording]` — `/clients` lists the slugs.',
  working: "Re-reading that one — give me a moment. I'll show you what changed.",
  run: ({ mastra, args }) => reread(mastra, args),
}

/** Joob's prospecting commands, in menu order. */
export const CLIENT_COMMANDS: Command<JoobTopicSlug>[] = [client, clients, unclient, reclient]

/**
 * Parses a request and writes the profile, then shows every field back.
 *
 * **The echo is the safety mechanism, not a courtesy** — the same argument
 * `/target` makes. A model wrote this configuration; `dealbreakers` and
 * `locations` are literal filters that throw companies away before anything
 * reads them, and the reader never learns which. Showing all of it makes a bad
 * parse visible immediately, and saying it again more precisely overwrites the
 * row.
 */
async function addClient(mastra: Mastra, request: string): Promise<string> {
  if (!request) return client.usage

  const parsed = await parseClient(mastra, request)
  const now = Date.now()
  const existing = await getProfile(parsed.slug)

  await upsertProfile({
    slug: parsed.slug,
    label: parsed.label,
    request,
    offer: parsed.offer,
    industries: parsed.industries,
    locations: parsed.locations,
    signalKinds: parsed.signalKinds,
    dealbreakers: parsed.dealbreakers,
    minDealSize: parsed.minDealSize,
    currency: parsed.currency,
    notes: parsed.notes,
    fitThreshold: existing?.fitThreshold ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    archivedAt: null,
  })

  return [
    existing
      ? `Updated **${escapeMarkdown(parsed.label)}** (\`${parsed.slug}\`).`
      : `Prospecting for **${escapeMarkdown(parsed.label)}** (\`${parsed.slug}\`).`,
    renderCriteria(parsed),
    `If any of that is wrong, say it again more precisely — it overwrites this one. Leads land in **${JOOB_TOPICS.leads.title}**.`,
  ].join('\n\n')
}

/**
 * Re-parses one profile in place, keeping its slug.
 *
 * The slug comes from the reader and the parse's own slug is discarded — that is
 * the whole difference from `/client`, and it is what stops "change this" from
 * becoming "add another". Same discipline `/retarget` follows
 * ([ADR-0036](../../../docs/decisions/0036-a-source-may-declare-its-field-and-a-search-may-be-re-read.md)).
 *
 * `fitThreshold` is preserved rather than re-read, because a bar the reader tuned
 * by hand is not something a re-parse of their *wording* knows about.
 */
async function reread(mastra: Mastra, argument: string): Promise<string> {
  if (!argument) return reclient.usage

  const [rawSlug, ...rest] = argument.split(/\s+/)
  const slug = slugify(rawSlug ?? '')
  const existing = await getProfile(slug)
  if (!existing) {
    return `I have no client profile called \`${escapeMarkdown(slug)}\`. \`/clients\` lists them.`
  }

  const wording = rest.join(' ').trim() || existing.request
  const parsed = await parseClient(mastra, wording)

  await upsertProfile({
    slug: existing.slug,
    label: parsed.label,
    request: wording,
    offer: parsed.offer,
    industries: parsed.industries,
    locations: parsed.locations,
    signalKinds: parsed.signalKinds,
    dealbreakers: parsed.dealbreakers,
    minDealSize: parsed.minDealSize,
    currency: parsed.currency,
    notes: parsed.notes,
    fitThreshold: existing.fitThreshold,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
    archivedAt: null,
  })

  const changes = describeChanges(existing, parsed)
  return [
    `Re-read **${escapeMarkdown(existing.label)}** (\`${existing.slug}\`).`,
    changes.length > 0 ? changes.join('\n') : 'Nothing changed — the parse came out the same.',
    renderCriteria(parsed),
  ].join('\n\n')
}

/**
 * A before-and-after diff, echoed for the same reason the full criteria are.
 *
 * These are deterministic filters written by a model, and a re-read that quietly
 * *added* a dealbreaker would start deleting companies the reader never hears
 * about.
 */
function describeChanges(before: ClientProfile, after: ParsedClient): string[] {
  const changes: string[] = []
  const list = (values: string[]) => values.join(', ') || 'any'

  if (before.label !== after.label) {
    changes.push(`- label: ${escapeMarkdown(before.label)} → ${escapeMarkdown(after.label)}`)
  }
  if (before.offer !== after.offer) {
    changes.push(`- offer: ${escapeMarkdown(before.offer)} → ${escapeMarkdown(after.offer)}`)
  }
  if (list(before.industries) !== list(after.industries)) {
    changes.push(`- industries: ${list(before.industries)} → ${list(after.industries)}`)
  }
  if (list(before.locations) !== list(after.locations)) {
    changes.push(`- locations: ${list(before.locations)} → ${list(after.locations)}`)
  }
  if (list(before.signalKinds) !== list(after.signalKinds)) {
    changes.push(`- signals: ${list(before.signalKinds)} → ${list(after.signalKinds)}`)
  }
  if (list(before.dealbreakers) !== list(after.dealbreakers)) {
    changes.push(`- dealbreakers: ${list(before.dealbreakers)} → ${list(after.dealbreakers)}`)
  }
  return changes
}

/** Every field, so a wrong parse is visible rather than subtle. */
function renderCriteria(profile: ParsedClient | ClientProfile): string {
  const list = (values: string[], empty: string) =>
    values.length > 0 ? escapeMarkdown(values.join(', ')) : empty

  const signals =
    profile.signalKinds.length > 0
      ? escapeMarkdown(
          profile.signalKinds
            .map(kind => LEAD_SIGNAL_LABELS[kind as keyof typeof LEAD_SIGNAL_LABELS] ?? kind)
            .join(', '),
        )
      : `all of them (${LEAD_SIGNAL_KINDS.join(', ')})`

  const money =
    profile.minDealSize !== null && profile.minDealSize !== undefined
      ? `${profile.minDealSize.toLocaleString('en-US')} ${profile.currency ?? ''}`.trim()
      : 'unstated'

  return [
    `- **you sell** — ${escapeMarkdown(profile.offer)}`,
    `- **industries** — ${list(profile.industries, 'any')}`,
    `- **locations** — ${list(profile.locations, 'anywhere')}`,
    `- **signals that count** — ${signals}`,
    `- **dealbreakers** — ${list(profile.dealbreakers, 'none')}`,
    `- **minimum engagement** — ${escapeMarkdown(money)}`,
    `- **notes** — ${profile.notes ? escapeMarkdown(profile.notes) : '—'}`,
  ].join('\n')
}

function renderProfiles(profiles: ClientProfile[]): string {
  const active = profiles.filter(profile => profile.archivedAt === null)
  if (active.length === 0) {
    return [
      "I'm not prospecting for anyone yet.",
      client.usage,
    ].join('\n\n')
  }

  const blocks = active.map(profile => {
    const bar = profile.fitThreshold ?? leadPipeline.defaultFitThreshold
    return [
      `**${escapeMarkdown(profile.label)}** — \`${profile.slug}\` (bar: ${bar})`,
      renderCriteria(profile),
    ].join('\n')
  })

  const archived = profiles.filter(profile => profile.archivedAt !== null)
  return [
    `Prospecting for ${active.length} kind${active.length === 1 ? '' : 's'} of client:`,
    ...blocks,
    ...(archived.length > 0
      ? [`Switched off: ${archived.map(profile => `\`${profile.slug}\``).join(', ')}.`]
      : []),
  ].join('\n\n')
}

async function removeClient(slug: string): Promise<string> {
  if (!slug) return unclient.usage

  const normalized = slugify(slug)
  const profile = await getProfile(normalized)
  if (!profile) {
    return `I have no client profile called \`${escapeMarkdown(normalized)}\`. \`/clients\` lists them.`
  }
  if (profile.archivedAt !== null) {
    return `\`${escapeMarkdown(normalized)}\` is already switched off. Re-run \`/client\` to bring it back.`
  }

  await archiveProfile(normalized)
  const remaining = await activeProfiles()
  return [
    `Stopped prospecting for **${escapeMarkdown(profile.label)}**.`,
    'Nothing it already sent you is lost, and the definition is kept — say it again with `/client` and it comes back.',
    remaining.length === 0
      ? "That was the last one, so I'm not prospecting for anyone right now."
      : `Still prospecting for ${remaining.length}.`,
  ].join('\n\n')
}
