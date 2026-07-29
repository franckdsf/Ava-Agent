/**
 * Verifies every feed the beats subscribe to is reachable and parseable.
 *
 * Run it after adding a feed, or when a beat suddenly goes quiet:
 *
 *   pnpm feeds:check
 *
 * It reads the `beats` and `beat_feeds` tables, which is why it now needs `.env`
 * where it used to need nothing — feeds moved out of a config array and into the
 * database ([ADR-0019](../docs/decisions/0019-beats-as-reader-owned-data.md)).
 * It still calls no model and sends nothing; the only thing it does with the
 * network is fetch each feed once.
 *
 * A URL two beats share is checked **once** and reported under both, which
 * mirrors what ingest does. Checking it per beat would give the second check a
 * warm cache and a meaningless time, and would hide the thing worth knowing —
 * that the feed is shared at all.
 */
import { pipeline } from '../src/config/pipeline.js'
import { activeBeats, feedsForBeats } from '../src/db/beats.js'

interface CheckResult {
  url: string
  ok: boolean
  detail: string
}

async function check(url: string): Promise<CheckResult> {
  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': pipeline.userAgent },
      redirect: 'follow',
      signal: AbortSignal.timeout(pipeline.feedTimeoutMs),
    })
    if (!response.ok) {
      return { url, ok: false, detail: `HTTP ${response.status}` }
    }
    const body = await response.text()
    const entries = (body.match(/<item[\s>]|<entry[\s>]/g) ?? []).length
    const conditional = response.headers.get('etag')
      ? 'etag'
      : response.headers.get('last-modified')
        ? 'last-modified'
        : 'none'
    return {
      url,
      ok: entries > 0,
      detail:
        entries > 0
          ? `${entries} entries · conditional-GET: ${conditional} · ${Date.now() - startedAt}ms`
          : 'parsed but contained no entries',
    }
  } catch (error) {
    return { url, ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

const beats = await activeBeats()
if (beats.length === 0) {
  console.log('No active beats — nothing to check.')
  process.exit(0)
}

const subscriptions = await feedsForBeats(beats.map(beat => beat.slug))
const distinct = [...new Set(subscriptions.map(subscription => subscription.feedUrl))]
const results = new Map((await Promise.all(distinct.map(check))).map(result => [result.url, result]))

for (const beat of beats) {
  console.log(`\n${beat.emoji} ${beat.title}`)
  const mine = subscriptions.filter(subscription => subscription.beatSlug === beat.slug)
  if (mine.length === 0) console.log('  (no feeds)')
  for (const subscription of mine) {
    const result = results.get(subscription.feedUrl)
    if (!result) continue
    console.log(`  ${result.ok ? '✓' : '✗'} ${subscription.source.padEnd(22)} ${result.detail}`)
    if (!result.ok) console.log(`    ${result.url}`)
  }
}

const shared = distinct.filter(
  url => subscriptions.filter(subscription => subscription.feedUrl === url).length > 1,
)
if (shared.length > 0) {
  console.log(`\n${shared.length} feed(s) followed by more than one beat — fetched once per run.`)
}

const failed = [...results.values()].filter(result => !result.ok)
console.log(`\n${results.size - failed.length}/${results.size} feeds healthy`)
if (failed.length > 0) process.exitCode = 1

// The libsql pool keeps the process alive once a query has opened it.
process.exit(process.exitCode ?? 0)
