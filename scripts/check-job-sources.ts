import { SEED_JOB_SOURCES } from '../src/config/seed-job-sources.js'
import type { Job, JobSearch, JobSource } from '../src/db/schema.js'
import { filterJobs } from '../src/services/job-filter.js'
import { fetchJobSource } from '../src/services/job-fetch.js'
import { jobId, jobIdentity, normalizeCompany, normalizeForIdentity } from '../src/services/job-identity.js'
import { deriveTags } from '../src/services/job-tags.js'

/**
 * Fetches every seeded job source and reports what came back, writing nothing.
 *
 * The job-side `pnpm feeds:check`. It exercises the real fetchers and the real
 * normalizers — the two places a board changing its payload would break the
 * pipeline silently — and then runs the identity function over everything so the
 * cross-board dedupe is visible as a number rather than assumed.
 *
 * Sends nothing, stores nothing, calls no model. Safe at any time.
 */

const now = Date.now()

/**
 * The seeds as rows, with no fetch state, which is what a first run sees.
 *
 * **`sonar` is excluded, and that is what keeps this script's promise.** It is a
 * source like any other to the pipeline, but fetching it means a model call and a
 * page fetch per lead — and this script's whole contract is that it is safe to
 * run at any time and calls no model. `pnpm sonar:check` exercises that source
 * instead, deliberately as a separate command with a separate cost.
 */
const sources: JobSource[] = SEED_JOB_SOURCES.filter(seed => seed.kind !== 'sonar').map(seed => ({
  id: seed.id,
  kind: seed.kind,
  url: seed.url,
  label: seed.label,
  adapter: seed.adapter ?? null,
  addedAt: seed.addedAt,
  archivedAt: null,
  etag: null,
  lastModified: null,
  lastFetchedAt: null,
  lastStatus: null,
  lastError: null,
  lastCount: null,
}))

const all: { sourceId: string; id: string; identity: string; company: string; title: string; location: string | null; remote: string; postedAt: number | null }[] = []

/** Every posting as ingest would store it, for the tag and filter sections below. */
const tagged: { tags: string[]; job: Job }[] = []

for (const source of sources) {
  const started = Date.now()
  const result = await fetchJobSource(source)
  const took = Date.now() - started

  console.log(`\n${'='.repeat(70)}`)
  console.log(`${source.id}  [${source.kind}${source.adapter ? `/${source.adapter}` : ''}]  ${took}ms`)
  console.log(source.url)
  console.log(`status ${result.status}${result.error ? `  ERROR: ${result.error}` : ''}  postings ${result.postings.length}`)
  console.log(`etag   ${result.etag ?? '—'}`)

  const dated = result.postings.filter(p => p.postedAt !== null).length
  const located = result.postings.filter(p => p.location).length
  const salaried = result.postings.filter(p => p.salaryText).length
  const described = result.postings.filter(p => p.description && p.description.length > 200).length
  if (result.postings.length > 0) {
    const pct = (n: number) => `${Math.round((n / result.postings.length) * 100)}%`
    console.log(
      `fields dated ${pct(dated)}  located ${pct(located)}  salary ${pct(salaried)}  described ${pct(described)}`,
    )
  }

  for (const posting of result.postings.slice(0, 3)) {
    const identity = { ...posting, remote: posting.remote === 'remote', firstSeenAt: now }
    console.log(`\n  ${posting.title}`)
    console.log(`    company   ${posting.company}  →  "${normalizeCompany(posting.company)}"`)
    console.log(`    title     →  "${normalizeForIdentity(posting.title).replace(/\s+/g, ' ').trim()}"`)
    console.log(`    location  ${posting.location ?? '—'}   remote=${posting.remote}`)
    console.log(`    posted    ${posting.postedAt ? new Date(posting.postedAt).toISOString().slice(0, 10) : '— (falls back to first-seen)'}`)
    console.log(`    contract  ${posting.contractType ?? '—'}   salary ${posting.salaryText ?? '—'}`)
    console.log(`    id        ${jobId(identity).slice(0, 16)}…  identity ${jobIdentity(identity).slice(0, 16)}…`)
    console.log(`    desc      ${(posting.description ?? '').replace(/\s+/g, ' ').slice(0, 140)}…`)
  }

  for (const posting of result.postings) {
    const identity = { ...posting, remote: posting.remote === 'remote', firstSeenAt: now }
    const id = jobId(identity)
    all.push({
      sourceId: source.id,
      id,
      identity: jobIdentity(identity),
      company: posting.company,
      title: posting.title,
      location: posting.location,
      remote: posting.remote,
      postedAt: posting.postedAt,
    })

    const derivedTags = deriveTags(posting)
    tagged.push({
      tags: derivedTags,
      // The row exactly as ingest would write it, so the filter below runs on
      // the same shape it will see in production rather than on a stand-in.
      job: {
        id,
        identity: jobIdentity(identity),
        sourceId: source.id,
        company: posting.company,
        title: posting.title,
        location: posting.location,
        remote: posting.remote,
        url: posting.url,
        description: posting.description,
        salaryText: posting.salaryText,
        contractType: posting.contractType,
        tags: posting.tags,
        derivedTags,
        postedAt: posting.postedAt,
        discoveredAt: now,
        deliveredAt: null,
        deliveredSearch: null,
      },
    })
  }
}

console.log(`\n${'='.repeat(70)}\nTAGS`)
{
  const counts = new Map<string, number>()
  for (const posting of tagged) {
    for (const tag of posting.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  const pct = (n: number) => `${Math.round((n / tagged.length) * 100)}%`.padStart(4)
  const show = (prefix: string) =>
    [...counts.entries()]
      .filter(([tag]) => tag.startsWith(prefix))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([tag, n]) => `${tag.slice(prefix.length)} ${n}`)
      .join(', ')

  console.log(`disciplines  ${show('discipline:')}`)
  console.log(`levels       ${show('level:')}`)
  console.log(`tech         ${show('tech:')}`)
  console.log(
    `flags        non-technical ${counts.get('flag:non-technical') ?? 0} ` +
    `(${pct(counts.get('flag:non-technical') ?? 0).trim()}), ` +
    `untagged ${counts.get('flag:untagged') ?? 0} ` +
    `(${pct(counts.get('flag:untagged') ?? 0).trim()})`,
  )
}

console.log(`\n${'='.repeat(70)}\nFILTER — what would reach the model`)
{
  // A representative search rather than a stored one, so this runs on a fresh
  // database and reports the same thing every time.
  const sample: JobSearch = {
    slug: 'sample-senior-frontend',
    label: 'Senior frontend, remote',
    request: 'senior frontend, remote, TypeScript or React',
    locations: [],
    remote: 'preferred',
    seniority: ['senior', 'staff'],
    contractTypes: [],
    mustHave: ['TypeScript', 'React'],
    dealbreakers: ['consulting'],
    minCompensation: null,
    currency: null,
    notes: null,
    fitThreshold: null,
    suggestion: null,
    suggestedAt: null,
    createdAt: now,
    archivedAt: null,
  }

  // Deduped first, because that is the order the pipeline runs in: `insertJobs`
  // collapses on the primary key before anything is linked to a search. Filtering
  // the raw intake instead counts one role advertised in six cities as six
  // postings and flatters every ratio below.
  const distinct = new Map<string, Job>()
  for (const posting of tagged) {
    if (!distinct.has(posting.job.id)) distinct.set(posting.job.id, posting.job)
  }
  const asJobs = [...distinct.values()]
  const outcome = filterJobs(asJobs, sample)
  console.log(`search: ${sample.label}`)
  console.log(`  must mention  ${sample.mustHave.join(' or ')}`)
  console.log(`  level         ${sample.seniority.join(', ')}`)
  console.log(`  rules out     ${sample.dealbreakers.join(', ')}`)
  console.log(`\n  ${asJobs.length} in  →  ${outcome.kept.length} reach the model  ` +
    `(${Math.round((outcome.kept.length / asJobs.length) * 100)}%)`)
  console.log('\n  rejected because:')
  for (const [reason, count] of [...outcome.rejected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(count).padStart(4)}  ${reason}`)
  }
  console.log('\n  survivors:')
  for (const job of outcome.kept.slice(0, 12)) {
    console.log(`    ${job.title}  @ ${job.company}`)
    console.log(`      ${job.derivedTags.join(' ')}`)
  }
}

console.log(`\n${'='.repeat(70)}\nDEDUPE`)
console.log(`postings fetched      ${all.length}`)
console.log(`distinct ids          ${new Set(all.map(p => p.id)).size}`)
console.log(`distinct identities   ${new Set(all.map(p => p.identity)).size}`)
console.log(`undated (month from first-seen)  ${all.filter(p => p.postedAt === null).length}`)

// Any id seen more than once is a posting two sources both carried, which is the
// case link-hashing would have missed. Worth printing: it is the whole argument
// for keying on company+title+location instead.
const byId = new Map<string, typeof all>()
for (const posting of all) {
  const existing = byId.get(posting.id)
  if (existing) existing.push(posting)
  else byId.set(posting.id, [posting])
}
const merged = [...byId.values()].filter(group => group.length > 1)
console.log(`\nids carried by more than one posting: ${merged.length}`)
for (const group of merged.slice(0, 10)) {
  console.log(`  "${group[0]?.title}" @ ${group[0]?.company}`)
  for (const posting of group) console.log(`    ← ${posting.sourceId}  (${posting.location ?? '—'})`)
}
