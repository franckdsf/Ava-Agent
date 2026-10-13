import { Mastra } from '@mastra/core'
import { leadScout } from '../src/config/leads.js'
import { getProfile } from '../src/db/leads.js'
import type { ClientProfile } from '../src/db/schema.js'
import { leadScoutAgents, proposeProspects } from '../src/mastra/agents/lead-scout.js'
import { leadTargeterAgents, parseClient } from '../src/mastra/agents/lead-targeter.js'
import { resolveProspect } from '../src/services/lead-scout.js'

/**
 * What the sonar lead scout actually returns, and how much of it survives
 * verification ([ADR-0039](../docs/decisions/0039-a-lead-scout-with-its-own-budget.md)).
 *
 * The lead-side twin of `pnpm sonar:check`, and it measures the same thing that
 * ADR measures: **verified companies, not proposed ones.** Proposed is a number
 * the prompt sets — asking for eight gets eight — so counting proposals would
 * measure nothing at all. What matters is how many clear the three gates, and
 * which gate the rest die on.
 *
 * `pnpm leadscout:check "<profile slug or free text>"`
 *
 * A stored slug runs exactly what a real run would. Free text goes through the
 * **same parser `/client` uses** rather than a hand-built stand-in, because the
 * scout's prompt is built from the parsed fields and inventing them here would
 * measure a profile the reader never made.
 *
 * **The database is opened only for a slug-shaped argument** — every repository
 * call awaits `migrate()`, which is a write. Free text is completely inert.
 */

const argument = process.argv.slice(2).join(' ').trim()
if (!argument) {
  console.error('Usage: pnpm leadscout:check "<profile slug or what you sell, and to whom>"')
  process.exit(1)
}

const mastra = new Mastra({ agents: { ...leadScoutAgents, ...leadTargeterAgents } })
const seconds = (from: number) => `${((Date.now() - from) / 1000).toFixed(1)}s`

const looksLikeSlug = !/\s/.test(argument)
const stored = looksLikeSlug
  ? await getProfile(argument).catch(error => {
      console.warn(`── could not read stored profiles (${error instanceof Error ? error.message : error}); reading "${argument}" as text`)
      return null
    })
  : null

let profile: ClientProfile
if (stored) {
  console.log(`\n── using the stored profile "${argument}" (database opened, migrations applied)`)
  profile = stored
} else {
  console.log(`\n── parsing "${argument}" through the same model /client uses`)
  const parsedAt = Date.now()
  const parsed = await parseClient(mastra, argument)
  console.log(`   parsed in ${seconds(parsedAt)}`)
  profile = {
    ...parsed,
    request: argument,
    minDealSize: parsed.minDealSize,
    currency: parsed.currency,
    notes: parsed.notes,
    fitThreshold: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
  }
}

console.log(`\n   sells:      ${profile.offer}`)
console.log(`   industries: ${profile.industries.join(', ') || 'any'}`)
console.log(`   locations:  ${profile.locations.join(', ') || 'anywhere'}`)
console.log(`   signals:    ${profile.signalKinds.join(', ') || 'all'}`)
console.log(`   avoids:     ${profile.dealbreakers.join(', ') || 'nothing named'}`)

console.log(`\n── asking the scout for up to ${leadScout.prospectsPerProfile} companies`)
const askedAt = Date.now()
const proposed = await proposeProspects(mastra, profile)
console.log(`   ${proposed.length} proposed in ${seconds(askedAt)}`)

if (proposed.length === 0) {
  console.log('\n   Nothing proposed. That is a model failure or an empty search, not "no leads".\n')
  process.exit(1)
}

console.log('\n── verifying each one against the open web')
console.log('   (site answers with real text → names the company → announcement resolves)\n')

const kept: string[] = []
const dropped: string[] = []

for (const prospect of proposed) {
  const startedAt = Date.now()
  const outcome = await resolveProspect(prospect)
  const label = `${prospect.company} (${prospect.signalKind})`
  if (outcome.signal) {
    kept.push(label)
    // The **cleaned** name, not the proposal's. They differ — the scout appends
    // parent companies — and showing the raw one here would hide the cleaning.
    console.log(`  ✓ ${outcome.signal.company} (${prospect.signalKind}) — ${seconds(startedAt)}`)
    console.log(`      ${outcome.signal.leadId}  ·  ${prospect.occurredOn}`)
    console.log(`      ${outcome.signal.summary}`)
    console.log(`      source: ${outcome.signal.sourceUrl}`)
  } else {
    dropped.push(`${label}: ${outcome.problem}`)
    console.log(`  ✗ ${label} — ${outcome.problem} (${seconds(startedAt)})`)
  }
}

console.log(`\n── ${kept.length} of ${proposed.length} verified in ${seconds(askedAt)} total`)
if (dropped.length > 0) {
  console.log('\n   Dropped, with the gate each died on:')
  for (const reason of dropped) console.log(`   - ${reason}`)
  console.log(
    '\n   A drop is the system working. An unverifiable prospect is the one most\n' +
      '   likely to have been invented — and unlike "is this company hiring", a claim\n' +
      '   that a company needs your work is checkable against nothing.',
  )
}
console.log()
