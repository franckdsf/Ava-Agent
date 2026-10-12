import type { Mastra } from '@mastra/core'
import { commands } from '../../config/commands.js'
import { LEAD_COMMANDS, type LeadCommand } from '../../config/lead-commands.js'
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
import { transportFor } from '../../bots/index.js'
import { JOOB_BOT } from '../../bots/joob.js'

const joobTelegram = transportFor(JOOB_BOT)

/**
 * `/client`, `/clients`, `/unclient` and `/reclient` — who Joob prospects for
 * ([ADR-0038](../../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
 *
 * The lead-side twin of `targets.ts`, and built to the same three rules. All four
 * answer in Chat, as one message each. They write `client_profiles` and nothing
 * else — the configuration half of [invariant 8](../../AGENTS.md#invariants) —
 * so none of them starts a run and nothing here can reach a fit score, a vision
 * verdict or a delivery.
 *
 * Only `/client` and `/reclient` call a model, which is the inbound
 * human-triggered category invariant 2 carves out: a person typing, not a cron
 * fire nobody watches.
 */

export { isLeadCommand } from '../../config/lead-commands.js'

/** The slash-command event, without importing the Chat SDK's own types. */
interface SlashEvent {
  command: string
  args?: string
  text?: string
}

/**
 * Runs one command and answers in Chat, saying it is working if it takes a while.
 *
 * **The adapter dispatches slash commands without awaiting them**
 * (`processUpdate` and `handleSlashCommandUpdate` are both fire-and-forget), so a
 * slow parse here never blocks Joob's other traffic. What it does block is the
 * reader's understanding: the typing indicator expires after about five seconds
 * and then nothing happens, for as long as the model takes.
 *
 * So the acknowledgement is on a timer. Under `commands.ackAfterMs` the
 * reader gets exactly one message, as before; over it they get "working on it"
 * and then the result. The ack is **awaited before the result is sent**, because
 * two sends racing could otherwise deliver the answer first and the promise to
 * answer second.
 */
async function runAndAnswer(
  mastra: Mastra,
  event: SlashEvent,
  command: LeadCommand,
): Promise<void> {
  // Only the two commands that call a model can be slow. `/clients` and
  // `/unclient` are a query and an update, and announcing those would be noise.
  const mayBeSlow = command === '/client' || command === '/reclient'
  let acknowledged: Promise<unknown> | null = null
  const timer = mayBeSlow
    ? setTimeout(() => {
        acknowledged = joobTelegram
          .notify(working(command), 'chat')
      }, commands.ackAfterMs)
    : null

  try {
    const text = await reply(mastra, event, command)
    if (timer) clearTimeout(timer)
    if (acknowledged) await acknowledged
    await joobTelegram.sendToTelegram(text, 'chat')
  } catch (error) {
    if (timer) clearTimeout(timer)
    if (acknowledged) await acknowledged
    throw error
  }
}

/**
 * The holding message. It says what is happening and, crucially, **what not to
 * do** — a reader who retypes the command in different words gets a second row
 * under a second slug, which is the duplicate this whole mechanism exists to
 * prevent.
 */
function working(command: LeadCommand): string {
  return command === '/reclient'
    ? "Re-reading that one — give me a moment. I'll show you what changed."
    : "Reading that — give me a moment. I'll show you exactly what I understood, and you can correct me then."
}

/**
 * The entry point `joob-channels.ts` calls.
 *
 * Wraps the above so **every branch ends in a message**: a slash command is
 * swallowed before the agent ever sees it, so one that fails silently is
 * indistinguishable from one that was never registered.
 */
export async function runLeadCommand(
  mastra: Mastra,
  event: SlashEvent,
  command: LeadCommand,
): Promise<void> {
  try {
    await runAndAnswer(mastra, event, command)
  } catch (error) {
    // Every branch ends in a message: a command that fails silently is
    // indistinguishable from one that was never registered.
    await joobTelegram
      .notify(
        `\`${escapeMarkdown(command)}\` failed: ${escapeMarkdown(
          error instanceof Error ? error.message : String(error),
        )}`,
        'chat',
      )
  }
}

async function reply(mastra: Mastra, event: SlashEvent, command: LeadCommand): Promise<string> {
  const argument = (event.args ?? event.text ?? '').trim()

  if (command === '/clients') return renderProfiles(await allProfiles())
  if (command === '/unclient') return unclient(argument)
  if (command === '/reclient') return reclient(mastra, argument)
  return client(mastra, argument)
}

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
async function client(mastra: Mastra, request: string): Promise<string> {
  if (!request) return LEAD_COMMANDS['/client'].usage

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
async function reclient(mastra: Mastra, argument: string): Promise<string> {
  if (!argument) return LEAD_COMMANDS['/reclient'].usage

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
      LEAD_COMMANDS['/client'].usage,
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

async function unclient(slug: string): Promise<string> {
  if (!slug) return LEAD_COMMANDS['/unclient'].usage

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
