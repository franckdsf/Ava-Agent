/**
 * Dry-runs `/follow` for a subject, and writes nothing.
 *
 *     pnpm discovery:check "actualité de la formule 1"
 *
 * Sibling of `check-feeds.ts` and `check-telegram.ts`, and it exists for the
 * same reason: the part of this feature that can go wrong is not the code, it is
 * what two models return, and that is only observable by running them. It names
 * the beat, searches for sites, resolves and verifies every feed, and renders
 * the report Telegram would receive — without creating a beat, subscribing it to
 * anything, or sending a message.
 *
 * **The token is deleted before anything is imported.** Constructing Ava with
 * `TELEGRAM_BOT_TOKEN` present builds a second polling adapter, and it would eat
 * the live bot's updates ([invariant 7](../AGENTS.md#invariants)). This never
 * imports her at all — a bare `Mastra` holding only the two scout agents is
 * enough to resolve `mastra.getAgent`.
 *
 * Check the rubric it prints. A rubric whose bullets could be swapped between
 * any two subjects is a rubric that scores nothing, and it will not look broken
 * — the ranker's ±10-point noise floor hides it. Check it is English, too: every
 * stored string in this system is, and only the text shown to a human follows
 * the reader's language.
 */
delete process.env.TELEGRAM_BOT_TOKEN

import { Mastra } from '@mastra/core'
import { createTelegramAdapter } from '@chat-adapter/telegram'
import { nameBeat, proposeSites, scoutAgents } from '../src/mastra/agents/scout.js'
import { discoverFeeds } from '../src/services/feed-discovery.js'
import { describeSite, renderReport } from '../src/mastra/workflows/discover-feeds.js'

const subject = process.argv.slice(2).join(' ').trim()
if (!subject) {
  console.error('Usage: pnpm discovery:check "<subject>"')
  process.exit(1)
}

const mastra = new Mastra({ agents: scoutAgents })
const seconds = (from: number) => `${((Date.now() - from) / 1000).toFixed(1)}s`

const naming = Date.now()
const named = await nameBeat(mastra, subject)
console.log(`\n── named in ${seconds(naming)}`)
console.log(`   slug       ${named.slug}`)
console.log(`   title      ${named.emoji} ${named.title}`)
console.log(`   subtopics  ${named.subtopics.join(', ')}`)
console.log(`   search     ${named.searchQuery}`)
console.log(`\n${named.rubric.split('\n').map(line => `   │ ${line}`).join('\n')}`)

const nonAscii = [...new Set(named.rubric.match(/[^\x00-\x7F]/g) ?? [])]
console.log(`\n   non-ASCII in rubric: ${nonAscii.length > 0 ? nonAscii.join(' ') : 'none'}`)

const searching = Date.now()
const sites = await proposeSites(mastra, named.searchQuery)
console.log(`\n── ${sites.length} sites proposed in ${seconds(searching)}`)

const verifying = Date.now()
const results = await discoverFeeds(sites.map(site => site.homepage))
const working = results.filter(result => result.feed)
console.log(`── ${working.length}/${results.length} verified in ${seconds(verifying)}`)
for (const result of results) {
  console.log(
    result.feed
      ? `   OK   ${result.homepage}\n          [${result.via}] ${result.feed.url}\n` +
        `          ${result.feed.entries} entries · ${result.feed.hasBodies ? 'full bodies' : 'headlines'}`
      : `   miss ${result.homepage}  (${result.problem})`,
  )
}

const message = await renderReport({
  slug: named.slug,
  subject,
  activate: true,
  sites,
  // The workflow's own mapping, not a copy of it — a copy here silently skipped
  // `sourceLabel` once and made this dry-run disagree with the real run.
  results: results.map(describeSite),
  // Everything verified, since a dry run is always a fresh beat and
  // `discovery.sitesRequested` cannot exceed `maxFeedsPerBeat`. A real top-up is
  // where the two diverge, and that path is only reachable from the workflow.
  attachedFeeds: results
    .filter(result => result.feed)
    .map(result => ({ feedUrl: result.feed!.url, source: describeSite(result).source ?? result.feed!.url })),
  added: working.length,
  linked: 0,
  activated: working.length > 0,
})

// The block structure, not the prose. A single newline inside an entry is a soft
// wrap that silently collapses two blocks into one run-on line, and that is
// invisible in the source and obvious here.
const ast = createTelegramAdapter({ botToken: 'unused:unused' }).formatConverter.toAst(message)
console.log(`\n── report renders as ${ast.children.length} blocks`)
console.log(`   ${ast.children.map((child: { type: string }) => child.type).join(', ')}`)
console.log(`\n${message.split('\n').map(line => `   > ${line}`).join('\n')}\n`)
