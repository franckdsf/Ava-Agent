import type { Mastra } from '@mastra/core'
import { JOB_COMMANDS, jobCommands, type JobCommand } from '../../config/job-commands.js'
import { JOOB_TOPICS } from '../../config/joob-topics.js'
import {
  activeSearches,
  getSearch,
  saveSearch,
  saveSuggestion,
  setSearchArchived,
} from '../../db/job-searches.js'
import type { JobSearch, SuggestedCriteria, TargetSuggestion } from '../../db/schema.js'
import { constraintCount } from '../../services/job-filter.js'
import { fetchPortfolio } from '../../services/portfolio.js'
import { joobTelegram } from '../../services/joob-telegram.js'
import { domainLabel } from '../../config/job-taxonomy.js'
import { escapeMarkdown } from '../../services/telegram.js'
import { parseTarget, suggestTighterTarget, type ParsedTarget } from '../agents/job-targeter.js'

/**
 * `/target`, `/targets` and `/untarget` — what Joob is looking for.
 *
 * All three answer in Chat, as one message each. They write `job_searches` and
 * nothing else, which is the configuration half of
 * [invariant 8](../../AGENTS.md#invariants); none of them starts a run, and
 * nothing here can reach a fit score or a delivery.
 *
 * Only `/target` calls a model. That is the inbound, human-triggered category
 * invariant 2 carves out — a person typing, not a cron fire nobody watches.
 */

export { isJobCommand } from '../../config/job-commands.js'

/** The slash-command event, without importing the Chat SDK's own types. */
interface SlashEvent {
  command: string
  args?: string
  text?: string
}

export async function runJobCommand(
  mastra: Mastra,
  event: SlashEvent,
  command: JobCommand,
): Promise<void> {
  try {
    await joobTelegram.sendToTelegram(await reply(mastra, event, command), 'chat')
  } catch (error) {
    // Every branch must end in a message: a command that fails silently is
    // indistinguishable from one that was never registered, which is the whole
    // bug the catch-all handler exists to prevent.
    await joobTelegram
      .notify(
        `\`${escapeMarkdown(command)}\` failed: ${escapeMarkdown(
          error instanceof Error ? error.message : String(error),
        )}`,
        'chat',
      )
  }
}

async function reply(mastra: Mastra, event: SlashEvent, command: JobCommand): Promise<string> {
  const argument = (event.args ?? event.text ?? '').trim()

  if (command === '/targets') return renderSearches(await activeSearches())
  if (command === '/untarget') return untarget(argument)
  if (command === '/retarget') return retarget(mastra, argument)
  return target(mastra, argument)
}

/**
 * Parses a request and writes the search, then shows every field back.
 *
 * **The echo is the safety mechanism, not a courtesy.** A model wrote this
 * configuration, and these are deterministic filters — a wrong `mustHave` throws
 * postings away before anything reads them and the reader never learns what they
 * missed. Showing all of it means a bad parse is visible immediately, and saying
 * it again more precisely overwrites the row (`saveSearch` upserts on slug).
 */
async function target(mastra: Mastra, request: string): Promise<string> {
  if (!request) return usage('/target')
  if (request.length > jobCommands.requestMaxChars) {
    return [
      `That's ${request.length} characters, and I cap a target at ${jobCommands.requestMaxChars}.`,
      "If you're pasting a job advert, that's a different thing from a standing search — tell me what about it you want more of instead.",
      JOB_COMMANDS['/target'].usage,
    ].join('\n\n')
  }

  const active = await activeSearches()
  const parsed = await parseTarget(mastra, request)

  // Checked after parsing rather than before, so re-targeting an existing slug
  // is never blocked by the cap — that path replaces a row instead of adding one.
  const isNew = !active.some(search => search.slug === parsed.slug)
  if (isNew && active.length >= jobCommands.maxActiveSearches) {
    return [
      `I'm already looking for ${active.length} things, which is the cap.`,
      'They compete for the same postings, so another one mostly duplicates an existing one. Drop one first:',
      active.map(search => `- \`${search.slug}\` — ${escapeMarkdown(search.label)}`).join('\n'),
      '`/untarget <slug>`',
    ].join('\n\n')
  }

  if (!jobCommands.slugPattern.test(parsed.slug)) {
    // The model is told the shape; this is the guard for when it ignores it,
    // and a slug is a primary key, so a bad one is worth refusing outright.
    return `I couldn't turn that into a usable name (\`${escapeMarkdown(parsed.slug)}\`). Try saying it a bit more plainly.`
  }

  const existing = await getSearch(parsed.slug)
  await saveSearch({
    slug: parsed.slug,
    label: parsed.label,
    request,
    domain: parsed.domain,
    locations: parsed.locations,
    remote: parsed.remote,
    seniority: parsed.seniority,
    contractTypes: parsed.contractTypes,
    mustHave: parsed.mustHave,
    dealbreakers: parsed.dealbreakers,
    minCompensation: parsed.minCompensation,
    currency: parsed.currency,
    notes: parsed.notes || null,
    fitThreshold: null,
    createdAt: existing?.createdAt ?? Date.now(),
  })

  // Only when the target barely constrains anything, and only after it is
  // saved: the advice is a nicety on top of a command that already worked, and
  // it costs a call carrying the whole CV, so it must not fire on a good target.
  const advice =
    constraintCount({ ...parsed, notes: parsed.notes || null } as JobSearch) <
    jobCommands.minConstraints
      ? await adviseOnLooseTarget(mastra, parsed.slug, parsed, request)
      : null

  return [
    existing
      ? `Updated **${escapeMarkdown(parsed.label)}** (\`${parsed.slug}\`). Here's what I have now:`
      : `Right — I'll look for **${escapeMarkdown(parsed.label)}** (\`${parsed.slug}\`). Here's what I understood:`,
    renderCriteria(parsed),
    "If any of that is wrong, say it again more precisely and I'll replace it — same words, more detail.",
    ...(advice
      ? [
        `⚠️ **This one is very broad.** ${escapeMarkdown(advice.diagnosis)}`,
        `Something like this would work better — send it as-is, or just tell me to apply it:`,
        `\`\`\`\n${advice.command}\n\`\`\``,
      ]
      : []),
    // Said every time rather than only on the first one: "when will I hear
    // anything?" is the single most likely question after seeing this reply, and
    // a reader who has to ask has already spent a day wondering.
    `I look every couple of days and put what clears the bar in the ${JOOB_TOPICS.jobs.title} tab. A quiet run tells you so here rather than saying nothing.`,
  ].join('\n\n')
}

/**
 * Fetches the CV, asks for a tighter target, and parks it on the row. Null on
 * any failure.
 *
 * The CV is fetched here rather than passed in because this is the only path
 * that needs it — `/target` is otherwise a cheap parse, and making every one of
 * them pull 80,000 characters to serve the rare loose case would be the wrong
 * trade. A portfolio that will not fetch simply means no advice; the search is
 * already saved either way.
 *
 * **The suggestion is then put through `parseTarget`**, the same parser that
 * would run if the reader pasted the line themselves. That is what lets Joob
 * apply it on request without a second opinion about what it meant: both routes
 * end at the same parse of the same sentence, so they cannot disagree. A failed
 * parse still stores the line — a reader can always paste it.
 */
async function adviseOnLooseTarget(
  mastra: Mastra,
  slug: string,
  parsed: ParsedTarget,
  request: string,
): Promise<TargetSuggestion | null> {
  let advice: { diagnosis: string; suggestion: string } | null = null
  try {
    const cv = await fetchPortfolio()
    advice = await suggestTighterTarget(mastra, cv.markdown, parsed, request)
  } catch {
    return null
  }
  if (!advice) return null

  const suggestion: TargetSuggestion = {
    diagnosis: advice.diagnosis,
    command: advice.suggestion,
    criteria: await parseSuggestedCriteria(mastra, advice.suggestion),
  }

  // Storing it must not cost the reader the advice itself, which is already
  // written and about to be shown.
  await saveSuggestion(slug, suggestion).catch(() => {})
  return suggestion
}

/** The suggested line as filters, or null if it would not parse. */
async function parseSuggestedCriteria(
  mastra: Mastra,
  command: string,
): Promise<SuggestedCriteria | null> {
  try {
    const sentence = command.replace(/^\s*\/target\s*/i, '').trim()
    if (!sentence) return null
    const { slug: _slug, ...criteria } = await parseTarget(mastra, sentence)
    return criteria
  } catch {
    return null
  }
}

/** One search's filters, as bullets. Empty lists are shown as "any", never omitted. */
function renderCriteria(search: ParsedTarget | JobSearch): string {
  const list = (values: string[]): string =>
    values.length > 0 ? values.map(escapeMarkdown).join(', ') : '_any_'

  const pay =
    search.minCompensation === null || search.minCompensation === undefined
      ? '_unstated_'
      : `${search.minCompensation.toLocaleString('en-US')} ${search.currency ?? ''}`.trim()

  return [
    // First, because it is the coarsest filter: a posting recognised as another
    // field is dropped before any other rule runs. Showing it is what makes a
    // wrong parse correctable — the reader says the target again more plainly
    // and the row is overwritten.
    `- **Field** — ${search.domain ? domainLabel(search.domain) : '_any_'}`,
    `- **Where** — ${list(search.locations)}`,
    `- **Remote** — ${search.remote}`,
    `- **Level** — ${list(search.seniority)}`,
    `- **Contract** — ${list(search.contractTypes)}`,
    `- **Must mention** — ${list(search.mustHave)}`,
    `- **Rules out** — ${list(search.dealbreakers)}`,
    `- **Pay floor** — ${pay}`,
    `- **Everything else** — ${search.notes ? escapeMarkdown(search.notes) : '_nothing noted_'}`,
  ].join('\n')
}

function renderSearches(searches: JobSearch[]): string {
  if (searches.length === 0) {
    return [
      "I'm not looking for anything yet.",
      JOB_COMMANDS['/target'].usage,
    ].join('\n\n')
  }

  const shown = searches.slice(0, jobCommands.maxSearchesShown)
  const blocks = shown.map(search =>
    [`**${escapeMarkdown(search.label)}** — \`${search.slug}\``, renderCriteria(search)].join('\n\n'),
  )

  const remaining = searches.length - shown.length
  return [
    `I'm looking for ${searches.length} ${searches.length === 1 ? 'thing' : 'things'}:`,
    ...blocks,
    ...(remaining > 0 ? [`…and ${remaining} more.`] : []),
    '`/untarget <slug>` stops one. Re-run `/target` with the same idea to replace one.',
  ].join('\n\n')
}

/**
 * Re-parses one existing search, keeping its slug, its `createdAt` and its history.
 *
 * **The slug is taken from the reader, never from the model**, which is the
 * whole difference from `/target`. There the model names the search, and a
 * re-worded request can name it something new — producing a second row rather
 * than an edit. Here the row is chosen first and the parse is written into it,
 * so "change this search" cannot turn into "add another one".
 *
 * Two modes, and the empty one is the reason this was written. With no new
 * wording it re-runs today's parser over the request already stored: that is how
 * a search written before the parser gained a field acquires that field, which
 * is not a hypothetical — three live searches held a null `domain` for two weeks
 * because the column arrived after they did, and the filter's largest saving
 * silently did nothing the whole time.
 *
 * The before-and-after is shown for the reason `/target` echoes its parse: these
 * are deterministic filters, a model wrote them, and a wrong `mustHave` throws
 * postings away before anything reads them. A diff makes a bad re-parse visible
 * in the one moment the reader is looking.
 */
async function retarget(mastra: Mastra, argument: string): Promise<string> {
  const [slug = '', ...words] = argument.split(/\s+/).filter(Boolean)
  if (!slug) return usage('/retarget')
  if (!jobCommands.slugPattern.test(slug)) {
    return `\`${escapeMarkdown(slug)}\` isn't a slug I could have made. ${JOB_COMMANDS['/retarget'].usage}`
  }

  const existing = await getSearch(slug)
  if (!existing) return `I have no search called \`${escapeMarkdown(slug)}\`. \`/targets\` lists them.`

  const wording = words.join(' ').trim()
  if (wording.length > jobCommands.requestMaxChars) {
    return `That's ${wording.length} characters, and I cap a target at ${jobCommands.requestMaxChars}.`
  }
  const request = wording || existing.request

  const parsed = await parseTarget(mastra, request)
  // The parse's own slug is **discarded**. It is a name for a search that already
  // has one, and honouring it here would reintroduce exactly the duplicate-row
  // problem this command exists to remove.
  await saveSearch({
    slug: existing.slug,
    label: parsed.label,
    request,
    domain: parsed.domain,
    locations: parsed.locations,
    remote: parsed.remote,
    seniority: parsed.seniority,
    contractTypes: parsed.contractTypes,
    mustHave: parsed.mustHave,
    dealbreakers: parsed.dealbreakers,
    minCompensation: parsed.minCompensation,
    currency: parsed.currency,
    notes: parsed.notes || null,
    // Deliberately preserved rather than re-read from the parse: a threshold the
    // reader tuned by hand is not something a re-parse of their *wording* knows
    // about, and silently resetting it would undo a decision they never mentioned.
    fitThreshold: existing.fitThreshold,
    createdAt: existing.createdAt,
  })

  const changed = describeChanges(existing, parsed)
  return [
    wording
      ? `Re-read **${escapeMarkdown(parsed.label)}** (\`${existing.slug}\`) with your new wording.`
      : `Re-read **${escapeMarkdown(parsed.label)}** (\`${existing.slug}\`) with what you'd already told me.`,
    renderCriteria(parsed),
    changed.length > 0
      ? [`**What moved:**`, ...changed.map(line => `- ${line}`)].join('\n')
      : '_Nothing changed_ — the parser reads it the same way it did before.',
    // Said because it is a real consequence the reader would otherwise discover
    // as a surprise: `decayUnproductiveSources` measures a board against the
    // reader's bar, and this just moved the bar.
    `Every source's record starts again from here — they're judged on what they find for *this*, and this just changed.`,
  ].join('\n\n')
}

/** Which filters a re-parse actually moved. Empty when it read the same. */
function describeChanges(before: JobSearch, after: ParsedTarget): string[] {
  const lines: string[] = []
  const list = (values: string[]): string => (values.length > 0 ? values.join(', ') : 'any')

  if ((before.domain ?? null) !== (after.domain ?? null)) {
    lines.push(
      `Field — ${before.domain ? domainLabel(before.domain) : 'any'} → ` +
        `**${after.domain ? domainLabel(after.domain) : 'any'}**`,
    )
  }
  const pairs: [string, string[], string[]][] = [
    ['Where', before.locations, after.locations],
    ['Level', before.seniority, after.seniority],
    ['Contract', before.contractTypes, after.contractTypes],
    ['Must mention', before.mustHave, after.mustHave],
    ['Rules out', before.dealbreakers, after.dealbreakers],
  ]
  for (const [label, was, now] of pairs) {
    if (was.join('|') !== now.join('|')) lines.push(`${label} — ${list(was)} → **${list(now)}**`)
  }
  if (before.remote !== after.remote) lines.push(`Remote — ${before.remote} → **${after.remote}**`)
  if ((before.minCompensation ?? null) !== (after.minCompensation ?? null)) {
    lines.push(`Pay floor — ${before.minCompensation ?? 'unstated'} → **${after.minCompensation ?? 'unstated'}**`)
  }
  return lines.map(escapeMarkdown)
}

async function untarget(slug: string): Promise<string> {
  if (!slug) return usage('/untarget')
  if (!jobCommands.slugPattern.test(slug)) {
    return `\`${escapeMarkdown(slug)}\` isn't a slug I could have made. ${JOB_COMMANDS['/untarget'].usage}`
  }

  const search = await getSearch(slug)
  if (!search) return `I have no search called \`${escapeMarkdown(slug)}\`. \`/targets\` lists them.`
  if (search.archivedAt !== null) {
    return `\`${escapeMarkdown(slug)}\` is already switched off. Re-run \`/target\` to bring it back.`
  }

  await setSearchArchived(slug, true)
  return [
    `Stopped looking for **${escapeMarkdown(search.label)}**.`,
    'Nothing it already sent you is lost, and the definition is kept — say it again with `/target` and it comes back.',
  ].join('\n\n')
}

function usage(command: JobCommand): string {
  return JOB_COMMANDS[command].usage
}
