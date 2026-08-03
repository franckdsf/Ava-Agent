import { portfolio } from '../src/config/portfolio.js'
import { fetchPortfolio, PortfolioError, portfolioConfigured } from '../src/services/portfolio.js'

/**
 * Fetches the CV and reports what came back, without running anything else.
 *
 * Exists for the reason `pnpm feeds:check` does: the endpoint is the one input
 * to job scoring that lives outside this repo, and a wrong one never errors — it
 * returns a login page or an empty document with a perfectly valid 200. Finding
 * that out here takes a second; finding it out from the matches takes a
 * fortnight.
 *
 * Read-only and sends nothing. Safe at any time.
 */

if (!portfolioConfigured()) {
  console.log('not configured — PORTFOLIO_FEED_URL is unset.')
  console.log('\nSet it in .env, with PORTFOLIO_FEED_TOKEN if the endpoint is gated:')
  console.log('  PORTFOLIO_FEED_URL=https://example.com/portfolio.md')
  console.log('  PORTFOLIO_FEED_TOKEN=…')
  process.exit(0)
}

console.log(`url     ${process.env.PORTFOLIO_FEED_URL}`)
console.log(`token   ${process.env.PORTFOLIO_FEED_TOKEN ? 'sent as a bearer' : 'none — fetching unauthenticated'}`)

const started = Date.now()
let cv
try {
  cv = await fetchPortfolio()
} catch (error) {
  if (error instanceof PortfolioError) {
    console.error(`\nFAILED (${error.reason})\n  ${error.message}`)
    process.exit(1)
  }
  throw error
}

console.log(`took    ${Date.now() - started}ms`)
console.log(`type    ${cv.contentType}`)
console.log(`size    ${cv.chars.toLocaleString('en-US')} characters${cv.truncated ? ` — TRUNCATED to ${portfolio.maxChars.toLocaleString('en-US')}` : ''}`)

// A rough token figure, because the CV goes into the scoring prompt whole and
// once per run. ~4 characters per token is close enough to decide whether that
// is a problem, and wrong enough that it is worth labelling as an estimate.
console.log(`prompt  ~${Math.round(cv.markdown.length / 4).toLocaleString('en-US')} tokens per run (estimated)`)

const lines = cv.markdown.split('\n')
const headings = lines.filter(line => /^#{1,3}\s/.test(line))
console.log(`\nheadings (${headings.length})`)
for (const heading of headings.slice(0, 25)) console.log(`  ${heading.trim()}`)
if (headings.length > 25) console.log(`  …and ${headings.length - 25} more`)

console.log('\nfirst 20 lines')
for (const line of lines.slice(0, 20)) console.log(`  | ${line}`)

if (headings.length === 0) {
  console.log(
    '\nNo markdown headings found. That is not an error — a CV can be prose — but it is\n' +
    'worth a look, since it is also what an HTML page stripped of its tags looks like.',
  )
}
