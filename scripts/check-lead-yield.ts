import { desc, gte } from 'drizzle-orm'
import { db, migrate } from '../src/db/client.js'
import { jobs } from '../src/db/schema.js'
import { leadPipeline } from '../src/config/leads.js'
import { hiringSignalsFromJobs } from '../src/services/lead-signals.js'
import { normalizeHost } from '../src/services/lead-identity.js'

/**
 * How many leads the free source actually yields, against the live table.
 *
 * Written to answer one question with a number rather than a guess: *is the
 * `jobs` table a real lead source, or only a theoretical one?* The claim it
 * checks is that most job postings carry a board's host rather than an
 * employer's, so most are dropped — see `hiringSignalsFromJobs`.
 *
 * `pnpm leads:yield`
 */

await migrate()

const cutoff = Date.now() - leadPipeline.signalWindowDays * 86_400_000
const rows = await db()
  .select({ url: jobs.url, company: jobs.company, sourceId: jobs.sourceId })
  .from(jobs)
  .where(gte(jobs.discoveredAt, cutoff))
  .orderBy(desc(jobs.discoveredAt))

console.log(`\nPostings in the last ${leadPipeline.signalWindowDays} days: ${rows.length}`)

const harvest = await hiringSignalsFromJobs(100_000)
const total = harvest.signals.length + harvest.noCompanyDomain

console.log(`\n  ✓ ${harvest.signals.length} became leads (distinct companies)`)
console.log(`  ✗ ${harvest.noCompanyDomain} dropped — board or ATS host, no company domain`)
if (total > 0) {
  console.log(`    yield: ${((harvest.signals.length / total) * 100).toFixed(1)}% of postings`)
}

const bySource = new Map<string, { kept: number; dropped: number }>()
for (const row of rows) {
  const entry = bySource.get(row.sourceId) ?? { kept: 0, dropped: 0 }
  const host = normalizeHost(row.url)
  const kept = harvest.signals.some(signal => signal.leadId === host)
  if (kept) entry.kept += 1
  else entry.dropped += 1
  bySource.set(row.sourceId, entry)
}

console.log('\nBy source — which ones carry a company domain at all:')
for (const [source, counts] of [...bySource.entries()].sort((a, b) => b[1].kept - a[1].kept)) {
  const flag = counts.kept > 0 ? '✓' : ' '
  console.log(`  ${flag} ${source.padEnd(34)} ${String(counts.kept).padStart(4)} kept  ${String(counts.dropped).padStart(5)} dropped`)
}

console.log('\nA sample of what became a lead:')
for (const signal of harvest.signals.slice(0, 15)) {
  console.log(`  ${signal.leadId.padEnd(32)} ${signal.company.slice(0, 28).padEnd(30)} ${signal.origin}`)
}
console.log()
