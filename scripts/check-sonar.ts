/**
 * Dry-runs the `sonar` job source for one search, and writes nothing.
 *
 *     pnpm sonar:check "senior frontend, TypeScript and React, remote Europe"
 *     pnpm sonar:check senior-frontend-paris-europe
 *
 * Sibling of `check-discovery.ts`, and it exists for the same reason: the part of
 * this source that can go wrong is not the code, it is what a model returns and
 * what the open web answers, and that is only observable by running it. It
 * proposes companies, resolves and verifies every careers page, builds the rows
 * ingest would store, and runs the real filter over them — without storing a
 * posting, linking a search, scoring anything or sending a message.
 *
 * **Read the FILTER section first.** A lead survives only if its careers page
 * carries the reader's must-haves in real text; if most leads are rejected for
 * never mentioning them, the page text is not doing its job and the design needs
 * revisiting rather than the numbers being accepted. That is the measurement this
 * script exists for.
 *
 * **Run it three times before believing anything.** The ±10 discipline in
 * AGENTS.md applies to a proposal prompt as much as to a ranking one. Watch in
 * particular whether the same company comes back under a differently-phrased
 * role: that is the case `leadIdentity` exists for, and the ids printed below
 * must collapse to one when it does.
 *
 * **Both bot tokens are deleted before anything is imported.** Constructing
 * either agent with its token present builds a second polling adapter, which
 * would eat the live bot's updates ([invariant 7](../AGENTS.md#invariants)). This
 * never imports them at all — a bare `Mastra` holding the scout and the targeter
 * is enough to resolve `mastra.getAgent`.
 *
 * This one **does** call a model, unlike `pnpm jobs:check`, which is why it is a
 * separate script rather than another section of that one. `jobs:check` promises
 * to be safe and model-free at any time and keeps that promise.
 */
delete process.env.NEWY_TELEGRAM_BOT_TOKEN
delete process.env.JOOB_TELEGRAM_BOT_TOKEN

import { Mastra } from '@mastra/core'
import { jobScout } from '../src/config/jobs.js'
import { getSearch } from '../src/db/job-searches.js'
import type { Job, JobSearch } from '../src/db/schema.js'
import { jobScoutAgents, proposeCompanies, renderSearchForScouting } from '../src/mastra/agents/job-scout.js'
import { jobTargeterAgents, parseTarget } from '../src/mastra/agents/job-targeter.js'
import { filterJobs } from '../src/services/job-filter.js'
import { leadId, leadIdentity } from '../src/services/job-identity.js'
import { leadToPosting, resolveLeads } from '../src/services/job-scout.js'
import { deriveTags } from '../src/services/job-tags.js'

const argument = process.argv.slice(2).join(' ').trim()
if (!argument) {
  console.error('Usage: pnpm sonar:check "<search slug or free text>"')
  process.exit(1)
}

const mastra = new Mastra({ agents: { ...jobScoutAgents, ...jobTargeterAgents } })
const seconds = (from: number) => `${((Date.now() - from) / 1000).toFixed(1)}s`
const now = Date.now()

/**
 * The search to scout for.
 *
 * A stored slug is used as-is, so this measures exactly what a real run would do.
 * Free text goes through the *same* parser `/target` uses rather than through a
 * hand-built stand-in — the filter's behaviour depends entirely on `mustHave` and
 * `dealbreakers`, and inventing those here would measure a search the reader
 * never made.
 *
 * **The database is opened only for a slug-shaped argument**, because every
 * repository function here awaits `migrate()` — which applies pending migrations,
 * and that is a write. Free text is therefore completely inert: no connection, no
 * migration, nothing on disk touched. An argument containing a space cannot be a
 * slug (`beatCommands.slugPattern` shape), so this costs nothing real.
 */
const looksLikeSlug = !/\s/.test(argument)
const stored = looksLikeSlug ? await getSearch(argument).catch(() => undefined) : undefined
let search: JobSearch

if (stored) {
  console.log(`\n── using the stored search "${argument}" (database opened, migrations applied)`)
  search = stored
} else {
  const parsing = Date.now()
  const parsed = await parseTarget(mastra, argument)
  console.log(
    `\n── parsed the request in ${seconds(parsing)}` +
      (looksLikeSlug ? ` (no stored search called "${argument}")` : ' (free text, database untouched)'),
  )
  search = {
    ...parsed,
    request: argument,
    notes: parsed.notes || null,
    fitThreshold: null,
    suggestion: null,
    suggestedAt: null,
    createdAt: now,
    criteriaChangedAt: now,
    archivedAt: null,
  }
}

console.log(`   slug   ${search.slug}`)
console.log(`   label  ${search.label}`)
console.log(`\n${renderSearchForScouting(search).split('\n').map(line => `   │ ${line}`).join('\n')}`)

const searching = Date.now()
const leads = await proposeCompanies(mastra, search)
console.log(`\n── ${leads.length} companies proposed in ${seconds(searching)} (asked for ${jobScout.leadsPerSearch})`)
for (const lead of leads) {
  console.log(`   ${lead.company} — ${lead.role}`)
  console.log(`      ${lead.homepage}`)
  console.log(`      ${lead.why}`)
}

const resolving = Date.now()
const resolutions = await resolveLeads(leads)
const resolved = resolutions.filter(result => result.careersUrl)
console.log(`\n── ${resolved.length}/${resolutions.length} careers pages verified in ${seconds(resolving)}`)
for (const result of resolutions) {
  console.log(
    result.careersUrl
      ? `   OK   ${result.lead.company}\n` +
        `          [${result.via}] ${result.careersUrl}\n` +
        `          ${result.pageText?.length.toLocaleString('en-US')} chars of text` +
        (result.pageText && result.pageText.length >= jobScout.maxPageChars ? ' (capped)' : '') +
        // The gate ADR-0040 added. Printed here because it is invisible
        // everywhere else until a job silently stops being sent: zero means the
        // page verified fine and still has nothing anybody can apply for, so the
        // company goes to Leads rather than to the reader as a job.
        `\n          ${result.listedRoles} role links${result.listedRoles === 0 ? '  → a lead, not a job' : ''}`
      : `   miss ${result.lead.company}  (${result.problem})`,
  )
}

/**
 * The rows ingest would insert, built through the same functions the workflow
 * calls — `leadToPosting`, `deriveTags`, `leadId`/`leadIdentity`. A copy of that
 * mapping here would drift from the real one, which is exactly what happened once
 * to `check-discovery.ts`.
 */
const rows: Job[] = []
for (const resolution of resolutions) {
  const posting = leadToPosting(resolution)
  if (!posting) continue
  const identity = { careersUrl: posting.url, firstSeenAt: now }
  rows.push({
    id: leadId(identity),
    identity: leadIdentity(identity),
    sourceId: 'sonar',
    company: posting.company,
    title: posting.title,
    location: posting.location,
    remote: posting.remote,
    url: posting.url,
    description: posting.description,
    salaryText: posting.salaryText,
    contractType: posting.contractType,
    tags: posting.tags,
    derivedTags: deriveTags(posting),
    listedRoles: posting.listedRoles ?? null,
    postedAt: posting.postedAt,
    discoveredAt: now,
    deliveredAt: null,
    deliveredSearch: null,
  })
}

console.log(`\n${'='.repeat(70)}\nTAGS — derived from the careers page's own words`)
for (const row of rows) {
  console.log(`   ${row.company}`)
  console.log(`      ${row.derivedTags.join(' ') || '(none)'}`)
}

console.log(`\n${'='.repeat(70)}\nFILTER — what would reach the scorer`)
{
  const outcome = filterJobs(rows, search)
  console.log(`   must mention  ${search.mustHave.join(' or ') || '(nothing set)'}`)
  console.log(`   rules out     ${search.dealbreakers.join(', ') || '(nothing set)'}`)
  console.log(
    `\n   ${rows.length} leads  →  ${outcome.kept.length} reach the scorer` +
      (rows.length > 0 ? `  (${Math.round((outcome.kept.length / rows.length) * 100)}%)` : ''),
  )
  if (outcome.rejected.size > 0) {
    console.log('\n   rejected because:')
    for (const [reason, count] of [...outcome.rejected.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(count).padStart(3)}  ${reason}`)
    }
  }
  for (const job of outcome.kept) {
    console.log(`\n   KEPT  ${job.title} @ ${job.company}`)
    console.log(`         ${job.url}`)
  }
}

/**
 * The identity check. Two runs proposing the same employer under two phrasings
 * must produce **one** id — that is the entire reason a lead is not keyed like a
 * posting. Distinct ids below being lower than the row count is the merge working
 * within a single run; across runs, compare these hashes by eye between two
 * invocations.
 */
console.log(`\n${'='.repeat(70)}\nIDENTITY`)
console.log(`leads stored          ${rows.length}`)
console.log(`distinct ids          ${new Set(rows.map(row => row.id)).size}`)
console.log(`distinct identities   ${new Set(rows.map(row => row.identity)).size}`)
console.log(`undated (month from first-seen)  ${rows.filter(row => row.postedAt === null).length}`)
console.log('\ncompare these between runs — a re-phrased role must not change them:')
for (const row of rows) {
  console.log(`   ${row.identity.slice(0, 16)}…  ${row.company}  ("${row.title}")`)
}
console.log('\nNothing was stored, linked, scored or sent.\n')
