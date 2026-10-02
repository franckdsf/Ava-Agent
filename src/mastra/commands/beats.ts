import type { Mastra } from '@mastra/core'
import { and, eq, gte } from 'drizzle-orm'
import {
  BEAT_COMMANDS,
  beatCommands,
  isBeatCommand,
  type BeatCommand,
} from '../../config/beat-commands.js'
import { pipeline } from '../../config/pipeline.js'
import {
  articleIdsFromFeed,
  feedPerformance,
  linkToBeats,
  verdictsForArticle,
  type FeedPerformance,
} from '../../db/articles.js'
import {
  activeBeats,
  addBeatFeed,
  allBeats,
  createBeat,
  feedsForBeats,
  getBeat,
  removeBeatFeed,
  setBeatArchived,
  type Beat,
} from '../../db/beats.js'
import { nameBeat } from '../agents/scout.js'
import { NEWY_BOT } from '../../config/bots.js'
import { db, migrate } from '../../db/client.js'
import { articleBeats, articles } from '../../db/schema.js'
import { scopeArxivFeed } from '../../services/arxiv.js'
import { checkFeed, normalizeFeedUrl, sourceLabel } from '../../services/feed-check.js'
import { escapeMarkdown } from '../../services/telegram.js'
import { newyTelegram } from '../../services/newy-telegram.js'
import { setBeatTopicOpen } from '../../services/telegram-topics.js'
import { quotedSource } from '../../services/quoted-article.js'
import type { SlashCommandEvent } from './article-context.js'

/**
 * The beat-management commands — `/beats`, `/beat`, `/pause`, `/resume`,
 * `/addfeed`, `/removefeed`, `/why`.
 *
 * **These are the first commands on this surface that write**, and what they
 * write is configuration: `beats` and `beat_feeds` only. That is the line the
 * restated [invariant 8](../../../AGENTS.md#invariants) draws — a conversation
 * may change what the *next* run reads, never what a run produced. Nothing here
 * touches `articles`, a score, or a `deliveredAt`, and nothing here starts a run.
 *
 * The one apparent exception is `/addfeed`, which writes `article_beats` rows.
 * It is not an exception: those rows are links with a null `rankedAt`, saying
 * "this beat should consider this article". No verdict is written, and the
 * ranker fills them in on its own schedule exactly as it does for anything
 * ingest produced.
 *
 * **No model is called by any of these.** They are deterministic handlers over
 * the database, which is deliberate for the write paths: archiving a beat should
 * happen because the reader typed `/pause design`, not because a model read a
 * sentence about being tired of design news and inferred it.
 *
 * Every reply lands in **Chat** — each one is a single short message, which is
 * what that tab is for ([invariant 9](../../../AGENTS.md#invariants)). Only a
 * translation earns its own tab, and only because it is several thousand
 * characters over several messages.
 */

const BEAT_TAB = 'chat' as const

export { isBeatCommand }

/**
 * Runs any beat command end to end.
 *
 * Never throws. A command that fails silently is the bug the catch-all handler
 * in `channels.ts` exists to prevent, so every path here ends in a message —
 * including the unexpected ones, which is what the outer catch is for.
 */
export async function runBeatCommand(
  mastra: Mastra,
  event: SlashCommandEvent,
  command: BeatCommand,
): Promise<void> {
  try {
    await newyTelegram.sendToTelegram(await beatCommandReply(event, command, mastra), BEAT_TAB)
  } catch (error) {
    mastra.getLogger()?.error('Beat command failed', { command, error })
    await newyTelegram.sendToTelegram(
      `${escapeMarkdown(command)} failed and nothing was changed. Try again in a moment.`,
      BEAT_TAB,
    )
  }
}

/**
 * Produces the reply for a command without sending it.
 *
 * Exported for the reason `renderSummary`, `renderTranslation` and `welcome` are:
 * it is the seam where a message can be checked without Telegram in the loop.
 * Every one of these replies is markdown that Telegram parses server-side, and a
 * block structure that collapses into one run-on line is invisible in code and
 * obvious through `formatConverter.toAst()`.
 *
 * Not pure — it reads the database, and the write commands write it. That is the
 * difference from the render functions, and it means a check of `/pause` really
 * does pause the beat. Point it at a copy, or resume afterwards.
 *
 * `mastra` is needed by `/follow` alone — the only one of these that calls a
 * model and the only one that starts a run. Every other branch ignores it.
 */
export function beatCommandReply(
  event: SlashCommandEvent,
  command: BeatCommand,
  mastra: Mastra,
): Promise<string> {
  const args = event.text.trim().split(/\s+/).filter(Boolean)
  switch (command) {
    case '/follow':
      return follow(event.text, mastra)
    case '/beats':
      return listBeats()
    case '/beat':
      return showBeat(args[0])
    case '/pause':
      return setPaused(args[0], true, mastra)
    case '/resume':
      return setPaused(args[0], false, mastra)
    case '/addfeed':
      return addFeed(args[0], args[1])
    case '/removefeed':
      return removeFeed(args[0], args[1])
    case '/why':
      return why(event.raw)
  }
}

/* ─────────────────────────────── shared bits ──────────────────────────────── */

function usage(command: BeatCommand, problem: string): string {
  return [`${problem}`, BEAT_COMMANDS[command].usage].join('\n\n')
}

/** Resolves a slug the reader typed, or explains why it didn't resolve. */
async function resolveSlug(
  command: BeatCommand,
  slug: string | undefined,
): Promise<Beat | string> {
  if (!slug) return usage(command, `${escapeMarkdown(command)} needs a beat slug.`)
  if (!beatCommands.slugPattern.test(slug)) {
    return usage(command, `\`${escapeMarkdown(slug)}\` isn't shaped like a beat slug.`)
  }
  const beat = await getBeat(slug)
  if (!beat) {
    const known = (await allBeats()).map(b => `\`${b.slug}\``).join(', ')
    return [
      `I have no beat called \`${escapeMarkdown(slug)}\`.`,
      known ? `What I have: ${known}.` : 'There are no beats yet.',
    ].join('\n\n')
  }
  return beat
}

const since = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000

/** Linked / ranked / delivered for one beat over the reporting window. */
async function beatStats(slug: string) {
  await migrate()
  const rows = await db()
    .select({ rankedAt: articleBeats.rankedAt, deliveredBeat: articles.deliveredBeat })
    .from(articleBeats)
    .innerJoin(articles, eq(articles.id, articleBeats.articleId))
    .where(
      and(
        eq(articleBeats.beatSlug, slug),
        gte(articles.discoveredAt, since(beatCommands.statsDays)),
      ),
    )
  return {
    linked: rows.length,
    ranked: rows.filter(row => row.rankedAt !== null).length,
    delivered: rows.filter(row => row.deliveredBeat === slug).length,
  }
}

/* ───────────────────────────────── /follow ─────────────────────────────────── */

/**
 * Sets a beat up from a subject typed in any language, and goes looking for its
 * feeds in the background.
 *
 * **The only beat command that calls a model, and the only one that starts a
 * run.** Both are deliberate departures from the rule the others follow, and
 * neither weakens it. `/pause` must not be inferred from a sentence because it
 * destroys something the reader built; naming a beat is the opposite — it is a
 * translation job with no destructive outcome, and asking a reader to invent an
 * English slug and five subtopic labels is asking them to do the machine's work.
 *
 * The run it starts writes configuration only, which is what the amended
 * [invariant 8](../../../AGENTS.md#invariants) permits. It does not start
 * `curateAll`, and nothing conversational can.
 *
 * **Two messages, not one.** This returns the acknowledgement; the workflow
 * sends the report minutes later. Folding them together is impossible anyway —
 * discovery is slower than a reader will hold still for — but even if it were
 * not, one message carrying "starting" and "here are seven feeds" reads like a
 * form rather than a reply.
 */
async function follow(rawSubject: string, mastra: Mastra): Promise<string> {
  const subject = rawSubject.trim().replace(/\s+/g, ' ')
  if (!subject) {
    return usage('/follow', `${escapeMarkdown('/follow')} needs a subject to follow.`)
  }
  if (subject.length > beatCommands.subjectMaxChars) {
    return usage(
      '/follow',
      `That's a lot to follow at once — keep it under ${beatCommands.subjectMaxChars} characters.`,
    )
  }

  // The namer runs before anything is written, so a model failure leaves no
  // half-made beat behind. It is the one blocking model call here; the scout,
  // which is the slow one, runs inside the workflow.
  let named: Awaited<ReturnType<typeof nameBeat>>
  try {
    named = await nameBeat(mastra, subject)
  } catch (error) {
    mastra.getLogger()?.error('Could not name a beat', { subject, error })
    return [
      "I couldn't work out what to call that beat.",
      'Try naming the subject a little more plainly — `/follow formula 1`, `/follow japanese cooking`.',
    ].join('\n\n')
  }

  const existing = await getBeat(named.slug)
  if (existing) {
    return [
      `You already follow ${existing.emoji} **${escapeMarkdown(existing.title)}** — that's what ` +
        `\`${subject}\` came out as.`,
      existing.archivedAt
        ? `It's paused. \`/resume ${existing.slug}\` starts it again.`
        : `\`/beat ${existing.slug}\` shows what it looks for, and \`/addfeed ${existing.slug} <url>\` ` +
          `adds a source to it.`,
    ].join('\n\n')
  }

  // Written paused. Between here and the workflow's report there is a beat with
  // no feeds, and a *live* beat with no feeds would join every digest and
  // contribute nothing — which is indistinguishable from a broken one.
  const created = await createBeat(named)
  if (!created) {
    return `Something else created \`${escapeMarkdown(named.slug)}\` a moment ago. \`/beats\` shows it.`
  }

  // The English search phrase, not what the reader typed. Searching in their own
  // language finds far fewer sites — see `NamedBeat.searchQuery`.
  await startDiscovery(mastra, named.slug, named.searchQuery)

  return [
    `${named.emoji} **${escapeMarkdown(named.title)}** — setting it up.`,
    `I'm looking for feeds now. That takes a few minutes, and I'll come back here with what I ` +
      `found. It's **paused** until then.`,
    `**Subtopics:** ${named.subtopics.map(topic => `\`${topic}\``).join(', ')}`,
  ].join('\n\n')
}

/**
 * Starts the discovery run without waiting for it.
 *
 * Not awaited, deliberately: `run.start()` resolves when the *workflow* finishes,
 * minutes from now, and the reader is holding a phone. The acknowledgement above
 * has to go out first, and the workflow sends its own message when it lands.
 *
 * This works from here and would not from a script. `run.start()` needs the
 * pubsub loop the Mastra server owns — a plain script hangs forever on it, which
 * is documented in AGENTS.md — and a slash handler runs *inside* that server.
 *
 * Errors are logged and swallowed on purpose. The beat exists and is paused
 * either way, so a failed discovery leaves the reader something they can finish
 * by hand with `/addfeed` rather than nothing at all.
 */
async function startDiscovery(mastra: Mastra, slug: string, subject: string): Promise<void> {
  try {
    const run = await mastra.getWorkflow('discoverFeeds').createRun()
    void run
      .start({ inputData: { slug, subject, activate: true } })
      .catch(error => mastra.getLogger()?.error('Feed discovery failed', { slug, error }))
  } catch (error) {
    mastra.getLogger()?.error('Could not start feed discovery', { slug, error })
  }
}

/* ────────────────────────────────── /beats ─────────────────────────────────── */

async function listBeats(): Promise<string> {
  const beats = await allBeats()
  if (beats.length === 0) {
    return [
      '## Beats',
      "You aren't following anything yet.",
      'Tell me a subject you want to follow and I\'ll find the feeds for it.',
    ].join('\n\n')
  }

  const feeds = await feedsForBeats(beats.map(beat => beat.slug))
  const lines = await Promise.all(
    beats.map(async beat => {
      const stats = await beatStats(beat.slug)
      const count = feeds.filter(feed => feed.beatSlug === beat.slug).length
      const paused = beat.archivedAt ? ' — **paused**' : ''
      return (
        `- ${beat.emoji} **${escapeMarkdown(beat.title)}** \`${beat.slug}\`${paused}\n` +
        `  ${count} feed${count === 1 ? '' : 's'} · ${stats.delivered} sent, ` +
        `${stats.ranked} scored of ${stats.linked} in ${beatCommands.statsDays} days`
      )
    }),
  )

  return [
    '## Beats',
    lines.join('\n'),
    `\`/beat <slug>\` for one in full. Digests arrive at ` +
      `${pipeline.digestHours.map(hour => `${String(hour).padStart(2, '0')}:00`).join(', ')}.`,
  ].join('\n\n')
}

/* ─────────────────────────────────── /beat ─────────────────────────────────── */

async function showBeat(slug: string | undefined): Promise<string> {
  const beat = await resolveSlug('/beat', slug)
  if (typeof beat === 'string') return beat

  const feeds = await feedsForBeats([beat.slug])
  const stats = await beatStats(beat.slug)
  const shown = feeds.slice(0, beatCommands.maxFeedsShown)
  const rest = feeds.length - shown.length

  // What each feed has actually done, so a source that collects hundreds of
  // articles and delivers none is visible rather than inferred. Keyed by URL
  // because a feed with no articles in the window has no row at all.
  const performance = new Map(
    (await feedPerformance(beat.slug, since(beatCommands.statsDays))).map(row => [
      row.feedUrl,
      row,
    ]),
  )

  return [
    `## ${beat.emoji} ${escapeMarkdown(beat.title)}`,
    beat.archivedAt
      ? '**Paused** — no ingest, no ranking, no digests. `/resume` to start it again.'
      : `Sends at or above **${beat.digestThreshold}**, at most ` +
        `**${beat.maxItemsPerDigest}** per digest.`,
    `In the last ${beatCommands.statsDays} days: **${stats.delivered}** sent, ` +
      `${stats.ranked} scored of ${stats.linked} collected.`,
    `**Subtopics:** ${beat.subtopics.map(topic => `\`${topic}\``).join(', ') || '—'}`,
    `**Feeds (${feeds.length}), over ${beatCommands.statsDays} days:**`,
    shown.length > 0
      ? shown
          .map(feed => feedLine(feed.source, feed.feedUrl, performance.get(feed.feedUrl)))
          .join('\n') + (rest > 0 ? `\n- …and ${rest} more` : '')
      : '- none yet — `/addfeed` to add one',
    '**Rubric:**',
    // Fenced rather than escaped: a rubric is prose full of parentheses, dashes
    // and quotes, and escaping every one of them is what made the first version
    // of the translation message unreadable. A fence renders it verbatim.
    '```\n' + beat.rubric + '\n```',
  ].join('\n\n')
}

/**
 * One feed's line in `/beat`: what it brought, what came of it, and the URL
 * `/removefeed` takes — trailing, since a reader is reading the stats first and
 * copying the URL second, if at all.
 */
function feedLine(source: string, feedUrl: string, stats: FeedPerformance | undefined): string {
  const name = `- **${escapeMarkdown(source)}**`
  // Not escaped: a code span keeps backslashes literally, so `\_` would reach
  // the reader — and `/removefeed` — as part of the URL.
  const url = `  \`${feedUrl}\``
  if (!stats || stats.collected === 0) {
    return `${name}\n  nothing collected yet\n${url}`
  }

  const parts = [`${stats.delivered} sent of ${stats.collected}`]
  if (stats.meanScore !== null) parts.push(`avg ${stats.meanScore}`)
  if (stats.bestScore !== null) parts.push(`best ${stats.bestScore}`)
  if (stats.ranked < stats.collected) parts.push(`${stats.collected - stats.ranked} unscored`)

  return `${name}\n  ${parts.join(' · ')}\n${url}`
}

/* ────────────────────────────── /pause · /resume ───────────────────────────── */

async function setPaused(
  slug: string | undefined,
  paused: boolean,
  mastra: Mastra,
): Promise<string> {
  const command: BeatCommand = paused ? '/pause' : '/resume'
  const beat = await resolveSlug(command, slug)
  if (typeof beat === 'string') return beat

  const alreadyThere = paused ? beat.archivedAt !== null : beat.archivedAt === null
  if (alreadyThere) {
    return paused
      ? `${beat.emoji} **${escapeMarkdown(beat.title)}** is already paused.`
      : `${beat.emoji} **${escapeMarkdown(beat.title)}** is already running.`
  }

  await setBeatArchived(beat.slug, paused)

  // The tab follows the beat where the chat type allows it
  // ([ADR-0021](../../../docs/decisions/0021-a-tab-per-beat.md)). Best-effort on
  // purpose: the database write above *is* the command, and a Telegram failure
  // must not report a pause that did happen as a failure. Only a genuine error
  // reaches the catch — 'no-tab' and 'unsupported' are ordinary outcomes.
  const tab = await setBeatTopicOpen(NEWY_BOT, beat, !paused).catch(error => {
    mastra.getLogger()?.error('Could not follow the beat with its tab', {
      slug: beat.slug,
      paused,
      error,
    })
    return 'failed' as const
  })

  return paused
    ? [
        `⏸ Paused ${beat.emoji} **${escapeMarkdown(beat.title)}**.`,
        'No ingest, no ranking, no digests. Nothing is deleted — its articles, ' +
          'scores and your votes all stay, and `/resume ' + beat.slug + '` picks it ' +
          'up where it left off.',
        pausedTabNote(tab),
      ].join('\n\n')
    : [
        `▶️ Resumed ${beat.emoji} **${escapeMarkdown(beat.title)}**.`,
        tab === 'changed'
          ? 'Its tab is open again, and it rejoins the next scheduled digest.'
          : 'It rejoins the next scheduled digest.',
      ].join('\n\n')
}

/**
 * What to say about the tab after a pause.
 *
 * `unsupported` is the live case on a private chat — Telegram has no
 * `closeForumTopic` there — so this says the true thing rather than the intended
 * one: the tab stays, and it simply goes quiet, which is what "no digests" above
 * already promised. Claiming a closed tab the reader can see is open would make
 * every other line of this reply suspect.
 */
function pausedTabNote(tab: 'changed' | 'no-tab' | 'unsupported' | 'failed'): string {
  switch (tab) {
    case 'changed':
      return 'Its tab is closed. Everything it sent is still there to read.'
    case 'no-tab':
      return 'It has no tab yet — one appears the first time a beat sends you something.'
    default:
      return 'Its tab stays where it is and goes quiet. Everything it sent is still there to read.'
  }
}

/* ──────────────────────────── /addfeed · /removefeed ───────────────────────── */

async function addFeed(slug: string | undefined, rawUrl: string | undefined): Promise<string> {
  const beat = await resolveSlug('/addfeed', slug)
  if (typeof beat === 'string') return beat
  if (!rawUrl) return usage('/addfeed', `${escapeMarkdown('/addfeed')} needs a feed URL.`)

  const url = normalizeFeedUrl(rawUrl)
  if (!url) {
    return usage('/addfeed', `\`${escapeMarkdown(rawUrl)}\` isn't a valid http(s) URL.`)
  }

  const existing = await feedsForBeats([beat.slug])
  if (existing.some(feed => feed.feedUrl === url)) {
    return `${beat.emoji} **${escapeMarkdown(beat.title)}** already reads that feed.`
  }

  // An arXiv category listing is narrowed to this beat's subtopics before it is
  // stored — 287 papers a day becomes the newest 60 that match what the beat is
  // about ([src/config/arxiv.ts](../../config/arxiv.ts)).
  //
  // **Verified, and reverted if it fails.** A query matching no papers is a
  // healthy feed that returns nothing forever, which is the failure this whole
  // command exists to prevent — so the scoped URL has to prove itself, and the
  // reader gets the plain category feed if it cannot. `scoped` is left null on
  // that path so the message tells the truth about what was stored.
  let scoped = scopeArxivFeed(url, beat)
  let stored = url
  if (scoped) {
    const scopedCheck = await checkFeed(scoped.url)
    if (scopedCheck.ok) stored = scoped.url
    else scoped = null
  }

  // Checked before it is written, always. A stored feed that turns out to be a
  // web page is a source that silently returns nothing for as long as nobody
  // looks — and the reader has no reason to look, because they were told it
  // worked.
  const check = await checkFeed(stored)
  if (!check.ok) {
    return [
      `That doesn't work as a feed: ${check.problem}.`,
      `Nothing was saved. Feed URLs usually end in \`/feed\`, \`/rss\` or \`.xml\`.`,
    ].join('\n\n')
  }

  const source = sourceLabel(check.title, stored)
  await addBeatFeed(beat.slug, stored, source)

  // The backfill. A feed another beat already polls answers 304 on the next run,
  // so without this the new subscription is linked to nothing until that feed
  // changes — days, on a quiet source. Its articles are already stored; this
  // links them and lets the ranker do the rest.
  const ids = await articleIdsFromFeed(stored, since(pipeline.maxItemAgeDays))
  const linked = await linkToBeats(
    ids.map(id => ({ articleId: id, beatSlug: beat.slug, subtopic: null })),
  )

  return [
    `✅ Added **${escapeMarkdown(source)}** to ${beat.emoji} **${escapeMarkdown(beat.title)}**.`,
    [
      `${check.entries} entries`,
      check.newestAt ? `latest ${describeAge(check.newestAt)}` : 'no dates',
      check.hasBodies ? 'full article bodies' : 'headlines only',
    ].join(' · '),
    // Said outright. The stored URL is not the one they typed, and a silent
    // rewrite is the kind of surprise that reads as a bug six weeks later.
    scoped
      ? `That's arXiv's whole \`${escapeMarkdown(scoped.category)}\` category, so I narrowed it to ` +
        `this beat's subjects — ${scoped.terms.map(term => `_${escapeMarkdown(term)}_`).join(', ')}. ` +
        `\`/removefeed\` and re-add the plain category URL if you'd rather have all of it.`
      : null,
    linked > 0
      ? `${linked} article${linked === 1 ? '' : 's'} from it were already stored — they go into ` +
        `the next ranking run, so this beat has something to say straight away.`
      : `Nothing stored from it yet. The next scheduled run picks it up.`,
  ]
    .filter((block): block is string => block !== null)
    .join('\n\n')
}

async function removeFeed(slug: string | undefined, rawUrl: string | undefined): Promise<string> {
  const beat = await resolveSlug('/removefeed', slug)
  if (typeof beat === 'string') return beat
  if (!rawUrl) return usage('/removefeed', `${escapeMarkdown('/removefeed')} needs a feed URL.`)

  const url = normalizeFeedUrl(rawUrl) ?? rawUrl
  const removed = await removeBeatFeed(beat.slug, url)
  if (!removed) {
    return [
      `${beat.emoji} **${escapeMarkdown(beat.title)}** isn't reading that feed.`,
      `\`/beat ${beat.slug}\` lists the URLs it does read.`,
    ].join('\n\n')
  }

  return [
    `🗑 ${beat.emoji} **${escapeMarkdown(beat.title)}** no longer reads that feed.`,
    'The articles it already brought in stay, with their scores. Add it back any ' +
      'time and it picks up where it left off.',
  ].join('\n\n')
}

/* ──────────────────────────────────── /why ─────────────────────────────────── */

/**
 * Every beat's verdict on the swiped article.
 *
 * The near-miss reader. The ranker has always written a `reason` for everything
 * it scored, winners and rejects alike, and until the verdicts moved to
 * `article_beats` there was no way to read one — a single score column meant a
 * rejected article's reason was overwritten by whichever beat looked at it last.
 */
async function why(raw: unknown): Promise<string> {
  const quoted = await quotedSource(raw)
  if (!quoted?.article) {
    return usage(
      '/why',
      quoted
        ? "I can't match that message to a stored article."
        : '`/why` needs an article to talk about.',
    )
  }

  const article = quoted.article
  const verdicts = await verdictsForArticle(article.id)
  const heading = `## [${escapeMarkdown(article.title)}](${article.link})`

  if (verdicts.length === 0) {
    return [heading, 'No beat has scored this one yet — it arrived too recently.'].join('\n\n')
  }

  const beats = await activeBeats()
  const title = (slug: string) =>
    beats.find(beat => beat.slug === slug)?.title ?? slug

  const lines = verdicts.map(verdict => {
    const won = article.deliveredBeat === verdict.beatSlug
    return (
      `- **${escapeMarkdown(title(verdict.beatSlug))}** — ${verdict.score ?? '—'}` +
      `${won ? ' · **sent**' : ''}` +
      (verdict.reason ? `\n  _${escapeMarkdown(verdict.reason)}_` : '')
    )
  })

  return [
    heading,
    article.deliveredAt
      ? `Sent from **${escapeMarkdown(title(article.deliveredBeat ?? ''))}**. ` +
        `Scored by ${verdicts.length} beat${verdicts.length === 1 ? '' : 's'}:`
      : `Never sent. Scored by ${verdicts.length} beat${verdicts.length === 1 ? '' : 's'}:`,
    lines.join('\n'),
    article.deliveredAt
      ? 'A story goes to whichever beat scores it highest, so the others show what ' +
        'they made of it without having sent it.'
      : 'It needed to clear a beat\'s threshold to be sent. `/beat <slug>` shows what each one asks for.',
  ].join('\n\n')
}

/** "3 days ago", for a feed's most recent entry. Rough on purpose. */
function describeAge(at: number): string {
  const days = Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? 'a month ago' : `${months} months ago`
}
