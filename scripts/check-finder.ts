import { feedFinder } from '../src/config/feed-finder.js'
import { checkFeed } from '../src/services/feed-check.js'
import {
  FeedFinderError,
  findFeedsForDomain,
  passesGates,
  searchTopics,
  type FoundFeed,
} from '../src/services/feed-finder.js'
import { byTimeliness, raceFeeds } from '../src/services/feed-timeliness.js'

/**
 * `pnpm finder:check "<topic>" [--against <feed-url>…] [--domain <site>]`
 *
 * Finds candidate sources for a subject and reports **which of them break a
 * story and which repeat it late** — the question `pnpm feeds:check` cannot
 * answer, because a late source is a perfectly healthy feed.
 *
 * Three stages, printed as three blocks: search, verify, race. The race is the
 * point; the first two exist so that what it races is real.
 *
 * `--against` adds feeds already subscribed to. Worth doing: it puts the
 * candidates in the same race as the sources they would replace, and it thickens
 * the pool, which is what makes shared stories findable when a narrow subject
 * returns four candidates that never overlap.
 *
 * Read-only. No database, no model, no `.env`.
 */

const args = process.argv.slice(2)
const against: string[] = []
const domains: string[] = []
const words: string[] = []

for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === undefined) continue
  if (arg === '--against') against.push(args[++index] ?? '')
  else if (arg === '--domain') domains.push(args[++index] ?? '')
  else words.push(arg)
}

const topic = words.join(' ').trim()

if (!topic && domains.length === 0) {
  console.log('usage: pnpm finder:check "<topic>" [--against <feed-url>…] [--domain <site>]')
  console.log('\nexamples:')
  console.log('  pnpm finder:check "ai model releases"')
  console.log('  pnpm finder:check "ai model releases" --against https://sub.thursdai.news/feed')
  console.log('  pnpm finder:check --domain blog.fal.ai')
  process.exit(0)
}

/**
 * Phrasings sent to the search.
 *
 * The endpoint is precise rather than generous — one query returns one to five
 * feeds, and two phrasings of the same subject return nearly disjoint sets. So
 * breadth is bought here, within `feedFinder.maxQueries`.
 */
function phrasings(subject: string): string[] {
  return [subject, `${subject} news`, `${subject} blog`, `best ${subject} sources`]
}

console.log(`topic   ${topic || '(none — domain lookup only)'}`)

/* ─────────────────────────────────── search ────────────────────────────────── */

let found: FoundFeed[] = []
const started = Date.now()

if (topic) {
  try {
    found = await searchTopics(phrasings(topic))
  } catch (error) {
    if (error instanceof FeedFinderError) {
      console.error(`FAILED (${error.reason})\n  ${error.message}`)
      process.exit(1)
    }
    throw error
  }
}

for (const domain of domains.filter(Boolean)) {
  try {
    found.push(...(await findFeedsForDomain(domain)))
  } catch (error) {
    console.log(`  domain lookup failed for ${domain}: ${String(error)}`)
  }
}

// Dedupe across both searches, keeping whichever description arrived first.
const unique = new Map<string, FoundFeed>()
for (const feed of found) if (!unique.has(feed.feedUrl)) unique.set(feed.feedUrl, feed)

const gated = [...unique.values()].filter(feed => passesGates(feed))
const dropped = [...unique.values()].filter(feed => !passesGates(feed))

console.log(`search  ${unique.size} candidates in ${Date.now() - started}ms`)
if (dropped.length > 0) {
  console.log(`gates   dropped ${dropped.length} as dormant`)
  for (const feed of dropped) {
    const stale = feed.lastUpdated ? `${Math.round((Date.now() - feed.lastUpdated) / 86_400_000)}d stale` : ''
    console.log(`          ${feed.feedUrl}  ${stale} ${feed.velocity !== null ? `vel ${feed.velocity.toFixed(2)}/wk` : ''}`)
  }
}

const candidates = gated.slice(0, feedFinder.maxCandidates)

/* ─────────────────────────────────── verify ────────────────────────────────── */

console.log(`\nverifying ${candidates.length}…`)
const verified: FoundFeed[] = []
for (const feed of candidates) {
  const check = await checkFeed(feed.feedUrl)
  if (check.ok) verified.push(feed)
  else console.log(`  DEAD  ${feed.feedUrl} — ${check.problem}`)
}
console.log(`${verified.length} of ${candidates.length} are working feeds.`)

/* ──────────────────────────────────── race ─────────────────────────────────── */

const baseline = new Set(against.filter(Boolean))
const racing = [...new Set([...verified.map(feed => feed.feedUrl), ...baseline])]

if (racing.length < 2) {
  console.log('\nToo few feeds to race — a lag is measured against other sources, not in the abstract.')
  process.exit(0)
}

console.log(`\nracing ${racing.length} feeds over the last ${feedFinder.race.windowDays} days…`)
const race = await raceFeeds(racing)

console.log(`\n${race.stories.length} shared stories found.`)
for (const story of race.stories.slice(0, 8)) {
  const first = story.coveredBy[0]
  if (!first) continue
  console.log(
    `  "${story.token}" — ${story.coveredBy.length} sources, first ` +
      `${new Date(story.startedAt).toISOString().slice(0, 16)} by ${hostOf(first.feedUrl)}`,
  )
}

console.log('\n=== timeliness ===')
console.log('  source                                    stories  broke   median lag   posts/wk')
for (const feed of [...race.feeds].sort(byTimeliness)) {
  const label = (baseline.has(feed.feedUrl) ? '* ' : '  ') + hostOf(feed.feedUrl)
  if (!feed.ok) {
    console.log(`  ${label.slice(0, 41).padEnd(42)} ${'—'.padStart(7)} ${'—'.padStart(6)} ${feed.problem}`)
    continue
  }
  const lag =
    feed.medianLagHours === null
      ? `too few (${feed.stories})`
      : feed.medianLagHours === 0
        ? 'breaks it'
        : `+${feed.medianLagHours.toFixed(1)}h`
  console.log(
    `  ${label.slice(0, 41).padEnd(42)} ${String(feed.stories).padStart(7)} ${String(feed.broke).padStart(6)} ` +
      `${lag.padStart(12)} ${feed.postsPerWeek.toFixed(1).padStart(10)}`,
  )
}

console.log('\n* = already subscribed (passed with --against)')
console.log(
  `A source needs ${feedFinder.race.minStoriesToRank} shared stories before a lag is reported. ` +
    'Fewer is shown as "too few" —\none scoop is not evidence.',
)

/**
 * Host plus a hint of the path, because one publisher can appear twice.
 * `blog.google/rss` and `blog.google/…/google-deepmind/rss` are different feeds
 * and rendered as a bare hostname they read as a duplicated row.
 */
function hostOf(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    const segments = parsed.pathname.split('/').filter(segment => segment && !/^(rss|feed|index)/i.test(segment))
    const tail = segments[segments.length - 1]
    return tail ? `${host}/${tail}` : host
  } catch {
    return url
  }
}
