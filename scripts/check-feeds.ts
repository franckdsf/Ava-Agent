/**
 * Verifies every feed in the category config is reachable and parseable.
 *
 * Deliberately depends only on `categories.ts` — not on the app's services — so
 * it needs no environment, no database, and no API key. Run it after editing
 * feeds, or when a category suddenly goes quiet:
 *
 *   pnpm feeds:check
 */
import { CATEGORIES } from '../src/config/categories.js'
import { pipeline } from '../src/config/pipeline.js'

interface CheckResult {
  category: string
  source: string
  url: string
  ok: boolean
  detail: string
}

async function check(category: string, source: string, url: string): Promise<CheckResult> {
  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': pipeline.userAgent },
      redirect: 'follow',
      signal: AbortSignal.timeout(pipeline.feedTimeoutMs),
    })
    if (!response.ok) {
      return { category, source, url, ok: false, detail: `HTTP ${response.status}` }
    }
    const body = await response.text()
    const entries = (body.match(/<item[\s>]|<entry[\s>]/g) ?? []).length
    const conditional = response.headers.get('etag')
      ? 'etag'
      : response.headers.get('last-modified')
        ? 'last-modified'
        : 'none'
    return {
      category,
      source,
      url,
      ok: entries > 0,
      detail:
        entries > 0
          ? `${entries} entries · conditional-GET: ${conditional} · ${Date.now() - startedAt}ms`
          : 'parsed but contained no entries',
    }
  } catch (error) {
    return {
      category,
      source,
      url,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

const results = await Promise.all(
  CATEGORIES.flatMap(category =>
    category.feeds.map(feed => check(category.slug, feed.source, feed.url)),
  ),
)

for (const category of CATEGORIES) {
  console.log(`\n${category.emoji} ${category.title}`)
  for (const result of results.filter(r => r.category === category.slug)) {
    console.log(`  ${result.ok ? '✓' : '✗'} ${result.source.padEnd(22)} ${result.detail}`)
    if (!result.ok) console.log(`    ${result.url}`)
  }
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} feeds healthy`)
if (failed.length > 0) process.exitCode = 1
