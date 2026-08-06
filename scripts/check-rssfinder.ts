import { rssFinder } from '../src/config/rss-finder.js'
import { checkFeed, type FeedCheck } from '../src/services/feed-check.js'
import { RssFinderError, searchRssFinder } from '../src/services/rss-finder.js'

/**
 * `pnpm rssfinder:check "<subject or domain>" [--verify]`
 *
 * Runs one rssfinder.app search and prints the feeds it would show, which is
 * what the browser gets from `?q=…` — same endpoint, same operation, same
 * normalization of a domain into a URL.
 *
 * **`--verify` is the half that matters.** Without it this reports what an index
 * claims; with it every URL goes through the same `checkFeed()` that guards
 * `/addfeed` and `/follow`, so a stale entry is visible here rather than as a
 * beat that quietly ingests nothing. The index is a *proposal* mechanism, exactly
 * like the `sonar` scout, and the repo's rule about model-proposed feed URLs
 * applies unchanged to a third party's database.
 *
 * Read-only end to end. No database, no model, no `.env` — nothing to configure
 * and nothing to break by running it.
 */

const args = process.argv.slice(2)
const verify = args.includes('--verify')
const query = args.filter(arg => arg !== '--verify').join(' ').trim()

if (!query) {
  console.log('usage: pnpm rssfinder:check "<subject or domain>" [--verify]')
  console.log('\nexamples:')
  console.log('  pnpm rssfinder:check "ai images models"')
  console.log('  pnpm rssfinder:check simonwillison.net --verify')
  process.exit(0)
}

const started = Date.now()
let search
try {
  search = await searchRssFinder(query)
} catch (error) {
  if (error instanceof RssFinderError) {
    console.error(`FAILED (${error.reason})\n  ${error.message}`)
    process.exit(1)
  }
  throw error
}

console.log(`query   ${query}`)
if (search.text !== query) console.log(`sent    ${search.text}   (normalized as the site does)`)
console.log(`took    ${Date.now() - started}ms`)
console.log(`feeds   ${search.feeds.length}`)

if (search.feeds.length === 0) {
  console.log('\nNo feeds. The index simply may not cover this subject — try the English')
  console.log('phrasing, or a section page rather than a site root.')
}

// Verification is one batch of real fetches, so it happens up front and the
// report reads its results rather than interleaving fetches with printing.
// Kept positional rather than keyed by URL: `checkFeed` reports the URL it
// *normalized*, which is not always the one the index returned.
const checks: FeedCheck[] = []
if (verify && search.feeds.length > 0) {
  console.log(`\nverifying ${search.feeds.length} feeds…`)
  const urls = search.feeds.map(feed => feed.url)
  for (let index = 0; index < urls.length; index += rssFinder.verifyConcurrency) {
    const batch = urls.slice(index, index + rssFinder.verifyConcurrency)
    checks.push(...(await Promise.all(batch.map(url => checkFeed(url)))))
  }
}

for (const [index, feed] of search.feeds.entries()) {
  console.log(`\n${index + 1}. ${feed.title ?? '(untitled)'}`)
  console.log(`   ${feed.url}`)
  if (feed.description) console.log(`   ${feed.description.slice(0, 160)}`)

  const check = checks[index]
  if (!check) continue
  if (check.ok) {
    console.log(`   OK — ${check.entries} entries, newest ${describeAge(check.newestAt)}, bodies ${check.hasBodies ? 'yes' : 'no'}, conditional-GET ${check.conditionalGet}`)
  } else {
    console.log(`   DEAD — ${check.problem}`)
  }
}

/**
 * How stale the newest entry is.
 *
 * Signed, because feeds really do publish into the future and the naive
 * subtraction printed `-126d old` for euractiv's agenda feed — which reads as a
 * bug in this script rather than as the fact about that feed that it is.
 */
function describeAge(newestAt: number | null): string {
  if (newestAt === null) return 'no dates'
  const days = Math.round((Date.now() - newestAt) / 86_400_000)
  return days < 0 ? `dated ${-days}d ahead` : `${days}d old`
}

if (verify && checks.length > 0) {
  const live = checks.filter(check => check.ok).length
  console.log(`\n${live} of ${search.feeds.length} verified as working feeds.`)
}

if (search.related.length > 0) {
  console.log(`\nrelated topics (the site's own chips — each is another search)`)
  console.log(`  ${search.related.join(', ')}`)
}

if (!verify && search.feeds.length > 0) {
  console.log('\nThese URLs are unverified. Re-run with --verify before trusting any of them.')
}
