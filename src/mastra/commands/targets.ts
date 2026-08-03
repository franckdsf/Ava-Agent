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
      .sendToTelegram(
        `\`${escapeMarkdown(command)}\` failed: ${escapeMarkdown(
          error instanceof Error ? error.message : String(error),
        )}`,
        'chat',
      )
      .catch(() => {})
  }
}

async function reply(mastra: Mastra, event: SlashEvent, command: JobCommand): Promise<string> {
  const argument = (event.args ?? event.text ?? '').trim()

  if (command === '/targets') return renderSearches(await activeSearches())
  if (command === '/untarget') return untarget(argument)
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
