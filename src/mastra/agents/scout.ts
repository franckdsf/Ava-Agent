import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { beatCommands } from '../../config/pipeline.js'
import { buildRubric, discovery } from '../../config/discovery.js'
import { env } from '../../config/env.js'
import { structured } from './structured.js'

/**
 * The two model calls behind `/follow`, and they are deliberately two.
 *
 * **The namer** turns whatever the reader typed — in their own language — into
 * the English shape a beat needs: a title, an emoji, subtopic labels, and the
 * bullets that fill the rubric template. Cheap, no search, one small object.
 *
 * **The scout** finds sites that publish about the subject. It is the only model
 * in this repo that needs the open web, and it gets it without a new dependency:
 * `perplexity/sonar` searches natively and routes through the OpenRouter gateway
 * like every other model here ([invariant on model IDs](../../config/env.ts)).
 *
 * Separate agents because the jobs share nothing. The namer is a translator with
 * a schema; the scout is a search engine with a schema. Merging them would put a
 * search-priced model on a call that needs no search, and would make one failure
 * take out both halves of the command.
 *
 * **Why `sonar` and not `sonar-pro`** — measured 2026-07-29 across three
 * subjects, scoring *verified feeds* rather than proposed sites, because
 * proposed sites is a number the prompt sets: sonar **18/24**, sonar-pro
 * **16/24**, with sonar equal or better on every subject and faster (3.1s vs
 * 3.4s). sonar-pro also proposed `chefpjacooks.com`, which does not exist, where
 * sonar proposed the real `chefjacooks.com`. Both are env-swappable; re-measure
 * on more than one subject before believing a change, and read the ±10 gotcha in
 * AGENTS.md first — a single comparison run tells you whatever you want to hear.
 */

export const namerId = 'beat-namer'
export const scoutId = 'beat-scout'

const namer = new Agent({
  id: namerId,
  name: 'Beat Namer',
  model: env.AVA_MODEL_BEAT_NAMER,
  /**
   * Reasoning off and price-routed, as `pnpm bench beat-namer` chose: `low`
   * wrote rubrics no better at four times the wait. Price rather than latency
   * because `/beat` spends its time in the scout's search after this, not here.
   */
  defaultOptions: {
    providerOptions: {
      openrouter: {
        reasoning: { enabled: false },
        provider: { sort: 'price' },
      },
    },
  },
  instructions: `
You turn a subject a reader typed into the definition of a news "beat".

The reader may write in any language. **Everything you return is English**, with
one exception noted below. This is not a preference: every stored string in this
system is English — rubrics are read by a ranking model, subtopic labels are
written into a database and rendered in prompts, and only the text shown to a
human follows the reader's own language. A French subject produces an English
beat.

Return:

- "title": the subject in English, as a section name. Two or three words, title
  case, no punctuation. "Formula 1", "Japanese Cooking", "EU Policy".
- "searchQuery": an English phrase for finding websites that publish about this,
  six to twelve words. Fuller than the title — "Formula 1 racing news, results
  and technical analysis", not "Formula 1". This is what gets searched, and a
  bare two-word title finds fewer and worse sites than a phrase does. Write it
  for reach, not for the reader's language: what the sites publish in does not
  matter, because everything is summarized before they read it.
- "emoji": exactly one emoji that reads as the subject at tab size. One
  character. Never a flag, never a sequence, never text.
- "subtopics": ${discovery.subtopicCount.min}-${discovery.subtopicCount.max} lowercase
  hyphenated labels covering the natural divisions of the subject. These are the
  only labels the ranker may assign, so they must together cover everything the
  subject publishes — a story that fits none of them gets mislabelled. Prefer
  broad and few over narrow and many: "race-weekend", "technical", "driver-news",
  not "monaco-gp".
- "readerLine": one sentence naming who this beat is curated for and what they
  care about, starting "You are curating for". This is the first line the ranking
  model reads.
- "scoreHigh": 4-6 bullets describing articles worth sending. Concrete and
  checkable — a thing that happened, a result, a release. Not "important news".
- "scoreLow": 4-6 bullets describing articles to reject. Aim these at the specific
  noise this subject produces: every subject has its own listicles, its own
  rumour mill, its own press-release churn. Name them.

Write the bullets as judgements a person could disagree with. A rubric that says
"high: relevant articles, low: irrelevant articles" is worthless — it scores
nothing, and nobody can tell it is failing.

The exception: if the subject is a proper noun that has no English form — a
publication, a person, a place — keep it as it is.
`.trim(),
})

const scout = new Agent({
  id: scoutId,
  name: 'Beat Scout',
  model: env.AVA_MODEL_BEAT_SCOUT,
  instructions: `
You find websites that publish regularly about a subject.

**Never return a feed URL.** Not /feed, not /rss.xml, not a URL you believe is a
feed. Something else fetches the page you give and reads the feed location out of
it, which is the only way to be right about it. A guessed feed URL is worse than
no site at all: it is stored as a source that returns nothing, forever, and
nobody notices because it never errors.

**Which page to return.** For a site that is *about* this subject, give its
homepage. For a general outlet that covers many subjects, give the **section
page** for this subject instead — "https://www.bbc.com/sport/formula1", not
"https://www.bbc.com". A big outlet's front page usually advertises no feed at
all, while its section page advertises that section's, and the section feed is
the one worth having anyway: nobody following Formula 1 wants the whole of BBC
News. Measured: bare roots for bbc.com, espn.com and skysports.com all yielded
nothing, where the section path for the same outlet resolved.

For the same reason, never return a URL you have not seen. If you are unsure a
site exists, leave it out — a shorter list of real sites beats a longer one with
an invented domain in it.

What makes a good proposal:

- It publishes **frequently** — a site that posts twice a year is not a feed
  worth polling every day.
- It publishes **articles**, not a forum, a wiki, a video channel, or a store.
- Independent outlets and specialist blogs are usually better sources than the
  official body's own site, which often publishes press releases and no feed.
- Prefer a mix: two or three broad outlets, the rest specialist.

Give each site its name, its homepage URL, and one short line on what it
publishes and why it fits.
`.trim(),
})

export const scoutAgents = { [namerId]: namer, [scoutId]: scout }

/* ──────────────────────────────── the namer ───────────────────────────────── */

const namedSchema = z.object({
  title: z.string(),
  searchQuery: z.string(),
  emoji: z.string(),
  subtopics: z.array(z.string()),
  readerLine: z.string(),
  scoreHigh: z.array(z.string()),
  scoreLow: z.array(z.string()),
})

/** A beat definition, validated and ready to insert. */
export interface NamedBeat {
  slug: string
  title: string
  emoji: string
  subtopics: string[]
  rubric: string
  /**
   * What the scout should search for — English, and a phrase rather than a name.
   *
   * Not stored on the beat; it only ever feeds one search. Searching in the
   * reader's own language is measurably worse: `"actualité de la formule 1"`
   * returned **3** sites of which 1 had a usable feed, where an English phrasing
   * of the same subject returned **8** of which 7 did.
   *
   * **The language of the sources it finds does not matter**, which is what
   * makes this a free win rather than a trade. A French reader following F1 is
   * not worse off with English sources: the digest is summarized before they see
   * it, and `/summarize` and `/translate` answer in their language on demand
   * ([ADR-0017](../../../docs/decisions/0017-translation-commands.md),
   * [ADR-0018](../../../docs/decisions/0018-summarize-command.md)). So the query
   * is chosen purely for how many good feeds it finds. It also lines up with the
   * rule that every stored string here is English and only what a human reads
   * follows their language ([AGENTS.md](../../../AGENTS.md#gotchas)).
   */
  searchQuery: string
}

/**
 * A slug derived from the English title, not asked of the model.
 *
 * Deriving is strictly better than asking: the slug is a primary key that
 * appears in `article_beats`, in every beat command the reader types, and in the
 * beat's Telegram tab, and `beatCommands.slugPattern` is the one shape all of
 * those agree on. Asking a model for a string matching a regex means handling
 * the case where it doesn't — deriving means there is no such case.
 */
export function slugFromTitle(title: string): string {
  return title
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
}

/**
 * One emoji, or null.
 *
 * Checked rather than trusted because this string is the first character of a
 * Telegram tab name and is prefixed to every digest heading: a model that
 * returns `"🏎️🏁"` or `"F1"` produces a tab that reads wrong forever, and
 * `createForumTopic` has no undo beyond deleting the tab. `Intl.Segmenter`
 * counts *graphemes*, so a flag or a skin-toned emoji — several code points,
 * one visible character — passes, while two emoji do not.
 */
export function oneEmoji(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const segments = [...new Intl.Segmenter().segment(trimmed)]
  if (segments.length !== 1) return null
  return /\p{Extended_Pictographic}/u.test(trimmed) ? trimmed : null
}

/**
 * Turns the reader's subject into a beat definition.
 *
 * Everything the model returns is validated or replaced. The rubric is
 * *assembled* from its bullets by `buildRubric`, never taken as prose — see the
 * note there for why a model-authored rubric is a quality risk that cannot be
 * measured after the fact.
 *
 * Throws when the response is unusable, and the caller turns that into a
 * sentence. There is nothing to fall back to: a beat with no title and no rubric
 * is not a degraded beat, it is a broken row.
 */
export async function nameBeat(mastra: Mastra, subject: string): Promise<NamedBeat> {
  const agent = mastra.getAgent(namerId)
  const named = await structured(agent, `The reader wants to follow this subject:\n\n${subject}`, namedSchema, {
    attempts: 1,
    orThrow: 'The beat namer returned no parsable object',
  })

  const title = named.title.trim()
  const slug = slugFromTitle(title)
  if (!beatCommands.slugPattern.test(slug)) {
    throw new Error(`"${title}" does not reduce to a usable beat slug.`)
  }

  const subtopics = [
    ...new Set(
      named.subtopics
        .map(topic => slugFromTitle(topic))
        .filter(Boolean)
        .slice(0, discovery.subtopicCount.max),
    ),
  ]
  if (subtopics.length === 0) throw new Error('The beat namer returned no usable subtopics.')

  return {
    slug,
    title,
    // Falls back to the title when the model skipped it. Worse for search, but a
    // two-word English query still beats the reader's original language.
    searchQuery: named.searchQuery.trim() || title,
    // A missing or malformed emoji must not fail the command — the beat is fine
    // without a good one, and this is decoration. The fallback is deliberately
    // generic rather than guessed from the subject.
    emoji: oneEmoji(named.emoji) ?? '📌',
    subtopics,
    rubric: buildRubric({
      readerLine: named.readerLine.trim(),
      scoreHigh: named.scoreHigh.map(line => line.trim()).filter(Boolean),
      scoreLow: named.scoreLow.map(line => line.trim()).filter(Boolean),
    }),
  }
}

/* ──────────────────────────────── the scout ───────────────────────────────── */

const sitesSchema = z.object({
  sites: z.array(z.object({ name: z.string(), homepage: z.string(), why: z.string() })),
})

/**
 * Homepages that publish about the subject.
 *
 * `avoidHosts` is a hint and nothing more — it stops the scout spending its
 * eight slots on sites the beat already reads. The actual exclusion is done
 * deterministically in `discoverFeeds`, because a prompt rule obeyed 99% of the
 * time is a bug at any volume ([AGENTS.md](../../../AGENTS.md#gotchas)).
 *
 * Returns homepages only. Anything shaped like a feed URL is dropped here rather
 * than trusted to the instructions, for the same reason.
 */
export async function proposeSites(
  mastra: Mastra,
  subject: string,
  avoidHosts: readonly string[] = [],
): Promise<{ name: string; homepage: string }[]> {
  const agent = mastra.getAgent(scoutId)
  const { sites } = await structured(
    agent,
    [
      `Find ${discovery.sitesRequested} websites that publish frequently about: ${subject}`,
      avoidHosts.length > 0
        ? `\nSkip these, they are already being read: ${avoidHosts.join(', ')}`
        : '',
      '\nGive each site its name, its homepage URL, and one line on what it publishes.',
    ].join('\n'),
    sitesSchema,
    { attempts: 1, orThrow: 'The scout found no sites for that subject' },
  )
  if (sites.length === 0) throw new Error('The scout found no sites for that subject')

  return sites
    .map(site => ({ name: site.name.trim(), homepage: site.homepage.trim() }))
    .filter(site => site.homepage && !looksLikeAFeedUrl(site.homepage))
}

/**
 * Whether a URL the scout returned is a feed rather than a homepage.
 *
 * The instructions forbid these outright and the model mostly obeys. "Mostly" is
 * the problem: a feed URL that slips through skips the page-reading step that
 * exists to confirm it, so it would be checked but never *discovered*, and a
 * plausible-looking guess that happens to parse is exactly the failure this
 * whole split prevents.
 */
function looksLikeAFeedUrl(url: string): boolean {
  return /\/(feed|rss|atom)(\.(xml|rss|atom))?\/?$|\.(xml|rss|atom)$/i.test(url)
}
