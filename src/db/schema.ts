import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The app's own tables. Mastra manages its `mastra_*` tables independently in
 * the same database — Drizzle owns only what's declared here, so the two never
 * collide. Change a table, then run `pnpm db:generate` to emit a migration.
 */

/** Conditional-GET state, so feeds are re-fetched politely. */
export const feedState = sqliteTable('feed_state', {
  feedUrl: text('feed_url').primaryKey(),
  etag: text('etag'),
  lastModified: text('last_modified'),
  lastFetchedAt: integer('last_fetched_at'),
  lastStatus: text('last_status'),
  lastError: text('last_error'),
})

/**
 * A beat — one subject the reader follows, with the standard its curator judges
 * against.
 *
 * This was `CATEGORIES` in `src/config/categories.ts`, a git-reviewable array.
 * It is a table now because the reader adds beats by talking to Newy rather than
 * by editing code ([ADR-0019](../../docs/decisions/0019-beats-as-reader-owned-data.md)).
 * `src/config/seed-beats.ts` still exists, but it is a *seed* applied once to an
 * empty table — editing it does not reach a beat that already exists.
 *
 * Nothing here is a foreign key target in SQLite terms, deliberately: a beat is
 * soft-deleted with `archivedAt` rather than removed, so its articles, its
 * scores, its votes and its Telegram tab all survive being switched off. That
 * makes "pause this beat" and "delete this beat" the same operation at two
 * depths, and neither one loses history.
 */
export const beats = sqliteTable(
  'beats',
  {
    /** Stable key, used in `article_beats`, `feedback`, and the tab's topic slug. */
    slug: text('slug').primaryKey(),
    title: text('title').notNull(),
    /** Prefixed to the title on the beat's Telegram tab, and on every digest heading. */
    emoji: text('emoji').notNull(),
    /**
     * What makes a curator expert: the standard the ranker judges against.
     *
     * Passed **in the prompt, not baked into agent instructions**, which is the
     * same reasoning ADR-0008 gave for the feedback profile — instructions are
     * fixed at construction and a rubric the reader can edit mid-conversation
     * would go stale until the next restart.
     */
    rubric: text('rubric').notNull(),
    /**
     * The label set the ranker must choose from, as a JSON array. Sectioning
     * comes free from ranking rather than costing a second model call.
     *
     * A JSON column rather than a child table because nothing ever queries by
     * subtopic — it is read whole, written whole, and rendered into a prompt.
     */
    subtopics: text('subtopics', { mode: 'json' }).$type<string[]>().notNull(),
    /**
     * 0–100. At or above this, an article may win this beat and be delivered.
     * Null means `pipeline.defaultDigestThreshold`, so retuning the default
     * retunes every beat that never overrode it — which is the point of the
     * null rather than a copied number.
     */
    digestThreshold: integer('digest_threshold'),
    /** Hard cap per digest, so a busy news day can't produce a wall of text. Null → default. */
    maxItemsPerDigest: integer('max_items_per_digest'),
    createdAt: integer('created_at').notNull(),
    /** Set to switch the beat off: no ingest, no ranking, no delivery, tab closed. */
    archivedAt: integer('archived_at'),
  },
  table => [index('idx_beats_active').on(table.archivedAt)],
)

/**
 * Which feeds a beat pulls from.
 *
 * **A feed URL may appear on several beats, and that is now load-bearing.** When
 * beats were hand-written no two shared a feed, which hid a real bug:
 * `feed_state` is keyed by URL globally, so the second beat to fetch a shared
 * feed got a 304 and saw nothing. Ingest therefore fetches each *distinct* URL
 * once and fans the entries out to every beat subscribing to it — the index on
 * `feedUrl` is what that fan-out reads.
 */
export const beatFeeds = sqliteTable(
  'beat_feeds',
  {
    beatSlug: text('beat_slug').notNull(),
    feedUrl: text('feed_url').notNull(),
    /** Shown as the attribution in digests. */
    source: text('source').notNull(),
    /** Single-purpose feeds pin a subtopic instead of paying for classification. */
    subtopic: text('subtopic'),
    addedAt: integer('added_at').notNull(),
    /** Soft delete, same reasoning as `beats.archivedAt` — the articles it brought in stay. */
    archivedAt: integer('archived_at'),
    /**
     * Who archived this subscription, and why.
     *
     * The soft delete alone was enough while `/removefeed` was the only way to
     * archive one. The weekly review changes that: it archives feeds that earn
     * nothing, and it later brings them back to re-test them. Without this
     * column those two things are indistinguishable from a feed the reader
     * removed on purpose — and resurrecting *that* one a month later, silently,
     * is the kind of behaviour that makes a bot untrustworthy.
     *
     * Null means archived before this column existed, and is read as `reader`:
     * the safe assumption, since it is the one that never resurrects anything.
     */
    archivedReason: text('archived_reason', {
      enum: ['reader', 'underperforming', 'unreachable'],
    }),
    /**
     * How many times the review has archived this feed for underperforming.
     *
     * The backoff counter. A feed brought back, given a month, and found wanting
     * again would otherwise cycle forever — costing a fetch on every digest for
     * a week, every time. Past `feedReview.maxTrials` it stays archived and the
     * reader can still re-add it by hand, which is the deliberate act this is
     * meant to require.
     */
    trials: integer('trials'),
  },
  table => [
    primaryKey({ columns: [table.beatSlug, table.feedUrl] }),
    index('idx_beat_feeds_url').on(table.feedUrl),
  ],
)

/**
 * Every rubric a beat has outgrown. **Append-only — nothing here is ever
 * updated or deleted.**
 *
 * A row holds the definition that was *replaced*, not the one that replaced it:
 * `beats` is the head, and this is the chain behind it. Reading them
 * oldest-first gives the beat's history, and the newest row is what it looked
 * like before the last retune.
 *
 * It exists because a rubric is the single highest-leverage prompt in the
 * pipeline — it alone decides what a beat sends — and Newy may now rewrite one
 * when the reader asks her to. An in-place update would make that
 * unrecoverable: the ranker moves ±10 points on identical input
 * ([AGENTS.md](../../AGENTS.md#gotchas)), so a retune that quietly made a beat
 * worse is invisible for days and there would be nothing to go back to.
 *
 * The same argument `memories` makes, for the same reason. There, a fact that
 * stops being true is superseded rather than corrected, because the change is
 * the interesting half; here, "it stopped delivering after we added those
 * bullets" is only answerable if the old bullets still exist.
 *
 * Keyed `(beatSlug, replacedAt)` rather than on a generated id: a retune is
 * already identified by which beat it touched and when, and the pair doubles as
 * the index history is read by. Two retunes of one beat in the same millisecond
 * would collide, which is not reachable through a conversation.
 *
 * `reason` is what the reader asked for, in their own words — the one field
 * here that is not a copy of a `beats` column, and the one that makes the
 * history readable rather than just a diff.
 */
export const beatRevisions = sqliteTable(
  'beat_revisions',
  {
    beatSlug: text('beat_slug').notNull(),
    /** The rubric this beat carried *before* the retune that wrote this row. */
    rubric: text('rubric').notNull(),
    /** The subtopics it carried before that same retune. */
    subtopics: text('subtopics', { mode: 'json' }).$type<string[]>().notNull(),
    /**
     * Why the reader wanted it changed, in their language. Null when they gave
     * no reason — a retune is still recorded without one.
     */
    reason: text('reason'),
    replacedAt: integer('replaced_at').notNull(),
  },
  table => [primaryKey({ columns: [table.beatSlug, table.replacedAt] })],
)

export type BeatRevisionRow = typeof beatRevisions.$inferSelect

/**
 * One row per story. The id is a hash of the canonical link, so the same story
 * arriving from two feeds — or matching two beats — collides and is kept once.
 * That collision *is* the global dedupe ([invariant 5](../../AGENTS.md#invariants)).
 *
 * Renamed from `items`, which said nothing about what a row is. Everything else
 * in the codebase already called these articles — `read-article`,
 * `fetchArticleText`, the article writer — so `items` was the outlier.
 *
 * **Ranking is not here.** A story can sit on several beats and score
 * differently on each, so `score`, `subtopic`, `reason`, `rankedAt` and
 * `clusterId` live on `article_beats`. What stays here is what is true about the
 * story regardless of who is reading it — and delivery, because a story is sent
 * to exactly one beat (see `deliveredBeat`).
 *
 * A useful consequence: this table is now written once at ingest and then only
 * on delivery. It used to take a `score` and a `rankedAt` write on every run,
 * which is the whole reason the `articles_fts` update trigger is scoped to the
 * text columns.
 */
export const articles = sqliteTable(
  'articles',
  {
    id: text('id').primaryKey(),
    /** The feed this story was first seen in. Not the beat — several may carry it. */
    feedUrl: text('feed_url').notNull(),
    source: text('source').notNull(),
    title: text('title').notNull(),
    link: text('link').notNull(),
    /** Short, for the ranker — it sees hundreds of these per run and must stay cheap. */
    excerpt: text('excerpt'),
    /**
     * Full article body when the feed ships one (`content:encoded`), stripped to
     * plain text. Only the handful of articles that survive ranking are ever read
     * from here, but it is captured at ingest because the feed is the cheapest
     * source — re-fetching the article later costs a request and often fails.
     */
    content: text('content'),
    /**
     * Lead image, sent as a URL for Telegram to fetch — nothing is downloaded
     * or hosted here. Null for most sources: of the seeded feeds only DeepMind,
     * Smashing and Android Developers publish one reliably, so every consumer
     * must treat an image as absent by default.
     *
     * Written at ingest from the feed, or later by the compose step once an
     * og:image has passed the site-chrome and repeated-URL checks. Anything
     * stored here is therefore already vetted and is trusted on re-delivery.
     */
    imageUrl: text('image_url'),
    publishedAt: integer('published_at'),
    discoveredAt: integer('discovered_at').notNull(),

    // Delivery output — null until actually sent.
    deliveredAt: integer('delivered_at'),
    /**
     * The beat that won the story.
     *
     * A story is scored on every beat that carries it and sent on exactly one:
     * the highest scorer among those clearing their own threshold. That is why
     * delivery is a column here and not on `article_beats` — "which beat sent
     * this" has one answer, and the losing beats keep their score and their
     * reason so the near-miss is still readable.
     */
    deliveredBeat: text('delivered_beat'),
    deliveryKind: text('delivery_kind', { enum: ['digest', 'breaking'] }),
  },
  table => [
    index('idx_articles_undelivered').on(table.deliveredAt, table.discoveredAt),
    index('idx_articles_feed_image').on(table.feedUrl, table.imageUrl),
  ],
)

/**
 * One row per (story, beat): what this beat's curator made of this story.
 *
 * This is the table that lets a story belong to more than one beat without being
 * stored — or delivered — twice. A row exists from the moment ingest links the
 * story to a beat; the ranking columns fill in when that beat's curator runs.
 *
 * `reason` is worth more than it looks. The ranker writes one for **every**
 * article it scores, not just the winners, so this table holds a one-line
 * account of why each story was passed over. Nothing read it until now.
 */
export const articleBeats = sqliteTable(
  'article_beats',
  {
    articleId: text('article_id').notNull(),
    beatSlug: text('beat_slug').notNull(),

    /**
     * Groups near-duplicate headlines so one story doesn't reach the ranker
     * three times over.
     *
     * Per beat, not per article, because clustering runs over *one beat's*
     * pending batch — the same story lands in different neighbourhoods on
     * different beats, and a single global column would have two runs
     * overwriting each other.
     */
    clusterId: text('cluster_id'),

    // Ranking output — null until this beat's ranker has seen it.
    score: integer('score'),
    subtopic: text('subtopic'),
    /** At most 15 words, concrete. Written for winners and near-misses alike. */
    reason: text('reason'),
    rankedAt: integer('ranked_at'),
  },
  table => [
    primaryKey({ columns: [table.articleId, table.beatSlug] }),
    index('idx_article_beats_unranked').on(table.beatSlug, table.rankedAt),
    index('idx_article_beats_score').on(table.beatSlug, table.score),
    index('idx_article_beats_cluster').on(table.beatSlug, table.clusterId),
  ],
)

/**
 * 👍/👎 from Telegram. Feeds the per-beat interest profile.
 *
 * `title` and `source` are copied from the article at vote time rather than
 * joined back to it, and that denormalization is load-bearing: articles are
 * pruned at `retentionDays` but votes are kept forever, so a row that joined to
 * `articles` for its title would go silently unreadable the moment its story
 * aged out — taking the reader's taste with it. These two columns are the entire
 * signal the ranker consumes (`renderInterestProfile` emits `- title (source)`),
 * so storing them makes a vote self-contained and permanent.
 *
 * Unbounded growth is fine here in a way it is not for `articles`: this table
 * grows only when a human presses a button, at ~100 bytes a press, while
 * articles arrive automatically by the hundred every day.
 */
export const feedback = sqliteTable(
  'feedback',
  {
    /**
     * Still the article's id, so re-voting overwrites — and it stays meaningful
     * after the article is gone, since nothing joins on it any more.
     */
    articleId: text('article_id').primaryKey(),
    /** The beat the reader was reading when they voted, not every beat it scored on. */
    beatSlug: text('beat_slug').notNull(),
    /** Snapshot of the article, so the vote outlives it. */
    title: text('title').notNull(),
    source: text('source').notNull(),
    vote: text('vote', { enum: ['up', 'down'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  table => [index('idx_feedback_beat').on(table.beatSlug, table.createdAt)],
)

/**
 * What Newy knows about the reader. One row per fact, in her own words.
 *
 * Split into two tiers by how long the fact stays true, not by how it was
 * learned. `long` is biography — a name, where they live, what they do, a
 * standing preference. `short` is episodic — what they ate, what they were
 * working on this week — and is only shown for `memoryConfig.shortTermDays`.
 *
 * **Nothing here is ever rewritten to stay current, and that is the design.** A
 * fact that stops being true is not corrected; the new fact is recorded with its
 * own date and both are rendered oldest-first, so "dark hair (2025-01)" followed
 * by "blond hair (2026-01)" reads as a change rather than a contradiction. An
 * update-in-place would keep the current value and lose that it ever changed,
 * which is the more interesting half. Deletion exists only for a fact that was
 * never true ([ADR-0014](../../docs/decisions/0014-two-tier-memory-for-ava.md)).
 *
 * **Notes are not scoped to a beat, deliberately.** "No Android articles" is a
 * statement about the reader, and the reader is the same person on every beat —
 * a per-beat note would let the same preference be true in one tab and false in
 * the next. A note that stops being true is superseded by a later one, which is
 * the mechanism this table already has.
 *
 * No reader column. The bot has one reader by construction — an allowlist of
 * user ids, one chat id, a single replica — so a `resource` here would be a
 * constant in every row. Adding one is the migration to run on the day a second
 * reader exists, not before.
 */
export const memories = sqliteTable(
  'memories',
  {
    /**
     * Hash of the normalized fact, so re-stating something already known
     * collides rather than accumulating a near-duplicate line in the prompt.
     * Same device as `articles.id`: derive the key from the content that must be
     * unique, and the dedupe needs no bookkeeping.
     *
     * It only catches *verbatim* repeats — "Their name is Franck" and "The
     * reader is called Franck" are two rows. The prompt is the real guard there,
     * since Newy is shown everything she already knows before she decides to
     * write anything.
     */
    id: text('id').primaryKey(),
    tier: text('tier', { enum: ['short', 'long'] }).notNull(),
    /** One self-contained fact, third person. Capped at `memoryConfig.factMaxChars`. */
    fact: text('fact').notNull(),
    /**
     * When the fact was true, which is not always when it was recorded — "I ate
     * at Kodawari on Saturday" said on Monday is Saturday's memory. Supplied by
     * Newy when the reader dates it, otherwise the moment it was written.
     *
     * This is what orders the rendered block, so it is the column that carries
     * the whole supersedes-by-recency reading.
     */
    happenedAt: integer('happened_at').notNull(),
    /**
     * When the row was written. Bookkeeping, and deliberately the column the
     * short-term window measures against: a fact learned today about something
     * six months ago should survive its first month in the notes rather than
     * being invisible the moment it lands.
     */
    createdAt: integer('created_at').notNull(),
  },
  table => [index('idx_memories_tier').on(table.tier, table.happenedAt)],
)

/**
 * One kind of role the reader wants Joob to look for.
 *
 * The job-side counterpart to `beats`, and shaped by the same decision: this is
 * reader-owned data written from a conversation, not a config array
 * ([ADR-0019](../../docs/decisions/0019-beats-as-reader-owned-data.md),
 * [ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)).
 *
 * **The columns split in two, and the split is the point.** Everything above
 * `notes` is a *deterministic filter* applied in SQL before any model sees a
 * posting — the ranker moves ±10 points on identical input, and at ~40 postings
 * a cycle a threshold cut at that noise level drops good jobs at random. Filter
 * on what can be checked, and spend the model only on what survives. `notes` is
 * the opposite: everything a filter cannot express ("would rather not manage
 * people") goes there and reaches the scoring prompt as prose.
 *
 * **Unlike a beat, a search does not get its own tab.** Beats are different
 * subjects; searches are slices of one field, and a strip of near-identical tabs
 * is worse than one good one. `label` is what names the winning search in a
 * message footer — the slot a beat's subtopic occupies in a digest.
 *
 * `request` keeps what the reader actually typed. The row is model-parsed, so
 * the original is the only thing that survives a parser that improves later, and
 * it is what a re-parse would read.
 *
 * Soft-deleted with `archivedAt` like a beat, so a search switched off keeps the
 * postings it won and can be switched back on.
 */
export const jobSearches = sqliteTable(
  'job_searches',
  {
    slug: text('slug').primaryKey(),
    /** Names this search in the footer of every posting it wins. */
    label: text('label').notNull(),
    /** Verbatim, in the reader's own language. See above. */
    request: text('request').notNull(),

    // --- Deterministic filters, applied before the model ---
    /**
     * The field of work this search is in — a key of `DOMAINS` in
     * `job-taxonomy.ts`, or null.
     *
     * **Written by the targeter, never asked of the reader.** ADR-0028 rejected
     * a stored category on the grounds that it "asks the reader to declare a
     * category they never mentioned", and that objection was to the *asking*:
     * the model parses this out of the same sentence it already parses eleven
     * other fields from, and `/target` echoes it straight back, so a wrong domain
     * is visible in the reply and re-typing overwrites the row. That echo is the
     * mitigation the targeter's own header calls the reason it may write
     * configuration directly.
     *
     * The alternative — inferring it from keyword overlap at read time — was
     * tried on paper and is worse in the way this repo cares about most: it is
     * invisible, so nobody can see or correct it. It also cannot break a tie.
     * `/target research scientist, polymer chemistry` matches software's `ml`
     * vocabulary *and* chemistry, and only something reading the sentence knows
     * which was meant.
     *
     * **Null is a legal, common answer** and means "do not filter on this",
     * exactly as an empty `seniority` does — for a request that fits no curated
     * field, and for every row written before this column existed. The filter
     * only rejects when both sides name a domain and they do not intersect.
     */
    domain: text('domain'),
    /** Free-form place names as the reader gave them. Empty means anywhere. */
    locations: text('locations', { mode: 'json' }).$type<string[]>().notNull(),
    remote: text('remote', { enum: ['required', 'preferred', 'onsite', 'any'] }).notNull(),
    /** Lowercase bands — `junior`, `mid`, `senior`, `staff`, `principal`. */
    seniority: text('seniority', { mode: 'json' }).$type<string[]>().notNull(),
    contractTypes: text('contract_types', { mode: 'json' }).$type<string[]>().notNull(),
    /** Terms a posting must mention. Kept short: every entry narrows hard. */
    mustHave: text('must_have', { mode: 'json' }).$type<string[]>().notNull(),
    /** Terms that reject a posting outright, whatever else it says. */
    dealbreakers: text('dealbreakers', { mode: 'json' }).$type<string[]>().notNull(),
    /** Annual, in `currency`. Null means unstated — most postings omit pay anyway. */
    minCompensation: integer('min_compensation'),
    currency: text('currency'),

    // --- Everything a filter cannot express ---
    notes: text('notes'),
    /** 0–100. Null means the configured default, so retuning it moves every search. */
    fitThreshold: integer('fit_threshold'),

    /**
     * The tighter target the advisor proposed, when this one was too loose.
     *
     * **Stored because the reader can only act on what someone can still see.**
     * A slash command answers through the transport and never enters the agent's
     * memory, so "apply your example" reached a Joob that had never seen the
     * example and invented a generic one. Parking it on the row is what makes
     * that sentence work: the tool reads it back, and the advice a model gave
     * about *this* search lives with the search.
     *
     * Cleared on every write to the row — a re-parsed or edited target makes the
     * old advice stale, and stale advice presented as current is worse than none.
     */
    suggestion: text('suggestion', { mode: 'json' }).$type<TargetSuggestion>(),
    suggestedAt: integer('suggested_at'),

    createdAt: integer('created_at').notNull(),
    /**
     * When the *criteria* last changed, as opposed to when the search was made.
     *
     * `createdAt` deliberately survives a re-target — the reader has been looking
     * for this since March, whatever words they used last — so it cannot answer
     * the question `decayUnproductiveSources` has to ask: **how much of a
     * source's record was earned against the rules in force today?**
     *
     * A board judged on its yield is judged against the reader's bar, so moving
     * that bar invalidates the evidence. Retarget from software to chemistry and
     * every software board's history becomes a measurement of a question nobody
     * is asking any more; leaving it standing would archive good boards for
     * failing a test they were never given. This timestamp is where their record
     * restarts.
     *
     * Nullable only so the column could be added to rows that predate it, which
     * `yieldWindowStart()` reads as "no reset yet" rather than as an error.
     */
    criteriaChangedAt: integer('criteria_changed_at'),
    archivedAt: integer('archived_at'),
  },
  table => [index('idx_job_searches_active').on(table.archivedAt)],
)

export type JobSearch = typeof jobSearches.$inferSelect
export type NewJobSearch = typeof jobSearches.$inferInsert
export type RemotePreference = JobSearch['remote']

/**
 * What the advisor said about a loose target.
 *
 * `criteria` is the *same* `/target` line put through the *same* parser the
 * reader would hit by pasting it, rather than a second structured answer from the
 * advisor. That is the whole reason it can be applied by a tool: pasting the
 * command and asking Joob to apply it produce the same row, so the two routes can
 * never drift. Null when that parse failed — the command text is still worth
 * keeping, because a reader can always paste it themselves.
 */
export interface TargetSuggestion {
  /** One sentence on what the current target lets through. The reader's language. */
  diagnosis: string
  /** The complete `/target …` line, verbatim as it was shown. */
  command: string
  criteria: SuggestedCriteria | null
}

/** Every field of a search except its slug, which an applied suggestion never changes. */
export interface SuggestedCriteria {
  label: string
  locations: string[]
  remote: RemotePreference
  seniority: string[]
  contractTypes: string[]
  mustHave: string[]
  dealbreakers: string[]
  minCompensation: number | null
  currency: string | null
  notes: string
}

/**
 * Where Joob looks. The job-side counterpart to `beat_feeds`.
 *
 * `kind` is the discriminator that lets one table hold sources that are fetched
 * completely differently — an RSS feed, a JSON endpoint, and later a
 * search-native model or a metered scraper
 * ([ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)).
 * `adapter` names which normalizer turns the payload into `jobs` rows, because a
 * URL alone cannot say that: two `api` sources have nothing in common but the
 * word JSON.
 *
 * **Conditional-GET state lives here rather than in `feed_state`.** That table
 * is keyed by URL globally and is the news pipeline's, and while sharing it
 * would work for an RSS job board it would put two pipelines' bookkeeping in one
 * row — the exact coupling that made a shared feed return 304 to the second beat
 * before ADR-0019. A job source's health is a property of the job source.
 */
export const jobSources = sqliteTable(
  'job_sources',
  {
    /** Stable slug — `remotive`, `weworkremotely-programming`. */
    id: text('id').primaryKey(),
    /**
     * `ats` rows are **discovered, not seeded** — the only kind that is. A sonar
     * lead whose employer turns out to have a public applicant-tracking board
     * writes one, and from then on that board is polled like any other source,
     * with no model call and no page resolution. That is what makes coverage
     * compound instead of costing the same every run: sonar pays once per
     * employer, the row pays off forever.
     *
     * SQLite does not enforce this list — it is a TypeScript-level enum over a
     * plain text column, so adding a kind needs no migration.
     */
    kind: text('kind', { enum: ['rss', 'api', 'sonar', 'apify', 'ats', 'hn'] }).notNull(),
    url: text('url').notNull(),
    /**
     * The one field of work this source carries, or null for a general board.
     *
     * **Null is the default and means "everything", not "unknown".** Jobicy and
     * Remotive publish accountants beside engineers, so they genuinely have no
     * domain and must keep fetching whatever the reader is looking for. A value
     * here is a *claim of exclusivity*: Hacker News's hiring thread and We Work
     * Remotely's programming feeds carry software and nothing else, so a reader
     * whose searches are all chemistry should not pay a request for them.
     *
     * Read by `activeJobSources()`, which drops a row whose domain matches no
     * active search. That is a fetch-time saving on top of `filterJob`'s
     * scoring-time one, and the two are deliberately different stages: the
     * filter stops a posting reaching a *model*, this stops a board being
     * *called at all*. Neither can replace the other — a general board still
     * needs filtering, and a filter cannot un-spend an HTTP request.
     *
     * **Never set this on a board you have not read.** Wrong here is expensive
     * and silent: the source stops being fetched, no error is raised, and the
     * postings simply never exist. `filterJob` is the safe place to be wrong,
     * because a rejection there is recorded with a reason.
     */
    domain: text('domain'),
    /** Attribution shown under a posting. */
    label: text('label').notNull(),
    /** Which normalizer reads this source's payload. Null for `rss`, which is generic. */
    adapter: text('adapter'),
    addedAt: integer('added_at').notNull(),
    archivedAt: integer('archived_at'),

    // Conditional GET and health, so a source that quietly dies is visible.
    etag: text('etag'),
    lastModified: text('last_modified'),
    lastFetchedAt: integer('last_fetched_at'),
    lastStatus: text('last_status'),
    lastError: text('last_error'),
    /** Postings returned by the last successful fetch. Zero for a while means a dead source. */
    lastCount: integer('last_count'),

    /**
     * When an `ats` board first came back empty, in an unbroken run of empties.
     * Null while it is producing, and cleared the moment it produces again.
     *
     * This is what `decayAtsBoards` reads to switch a board off — see it for why
     * discovered sources need an off-ramp that seeded ones do not.
     *
     * **Only `ats` rows ever set it, and that exclusion is not tidiness.** A 304
     * from an RSS or API board is a *success* carrying zero postings — the normal
     * state for a feed that has not changed — so counting empties there would
     * decay every healthy board in the table within weeks. An ATS API sends no
     * conditional request and answers with the employer's current openings, so
     * zero there really does mean zero.
     */
    emptySince: integer('empty_since'),
  },
  table => [index('idx_job_sources_active').on(table.archivedAt)],
)

/**
 * One job posting.
 *
 * **The id carries the month, and that is the whole dedupe design.** It is a
 * hash of normalized company, title, location **and `YYYY-MM`** — taken from the
 * posting's own date, falling back to first-seen only when a source ships none.
 * Link hashing, which is how `articles` dedupes, fails outright here: the same
 * role appears on five boards under five URLs, and hashing links multiplies it
 * by five instead of merging it. The month is what makes a genuine repost months
 * later a *new* job rather than a silent collision with the old one.
 *
 * `identity` is the same hash **without** the month. It is what
 * `job_deliveries` keys on, and it is the only thing that can recognise "this is
 * the posting you already saw" across a month boundary or a pruning.
 *
 * Delivery is a column here, not on `job_matches`, for the reason it is on
 * `articles`: a posting is scored by every search that could want it and sent by
 * exactly one, so "which search sent this" has a single answer.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    /** Month-less identity. See above — this is what prevents a re-send. */
    identity: text('identity').notNull(),
    /** The source this posting was first seen in. Others may carry it too. */
    sourceId: text('source_id').notNull(),

    company: text('company').notNull(),
    title: text('title').notNull(),
    location: text('location'),
    remote: text('remote', { enum: ['remote', 'hybrid', 'onsite', 'unknown'] }).notNull(),
    url: text('url').notNull(),
    /** Plain text, stripped at ingest. What the scorer and the writer read. */
    description: text('description'),
    /** Verbatim, because pay is stated in a dozen incompatible ways or not at all. */
    salaryText: text('salary_text'),
    contractType: text('contract_type'),
    /**
     * The **source's** tags, kept as an audit trail and never filtered on.
     *
     * Measured worthless: Remotive returned a graphic-design role tagged
     * `golang`, `php`, `rust` and `unity`; RemoteOK returned a construction
     * estimator tagged `golang`, `infosec` and `engineer`. Boards let employers
     * tag freely and agencies tag exhaustively. Kept only so a future argument
     * about a specific posting can be settled against what its board actually
     * said.
     */
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
    /**
     * Tags derived from this posting's own words at ingest — the ones that are
     * actually filtered on.
     *
     * Namespaced by kind: `domain:software`, `discipline:software.frontend`,
     * `skill:chemistry.chromatography`, `level:senior`.
     *
     * **An audit trail, not what the filter reads.** Tagging moved to filter
     * time — see `jobTags` in `src/services/job-filter.ts` — because tags frozen
     * at ingest describe a posting with whatever vocabulary existed that day, so
     * a domain added later would never reach a row already stored. This column
     * records what the vocabulary said when the posting arrived, which is what
     * makes an argument about a specific posting settleable.
     */
    derivedTags: text('derived_tags', { mode: 'json' }).$type<string[]>().notNull(),

    /** The source's own date. Null when it ships none — see the id note above. */
    postedAt: integer('posted_at'),
    discoveredAt: integer('discovered_at').notNull(),

    deliveredAt: integer('delivered_at'),
    deliveredSearch: text('delivered_search'),
  },
  table => [
    index('idx_jobs_undelivered').on(table.deliveredAt, table.discoveredAt),
    index('idx_jobs_identity').on(table.identity),
  ],
)

/**
 * One row per (posting, search): what that search made of that posting.
 *
 * The job-side `article_beats`, and it exists for the same reason — a posting
 * can be wanted by more than one search and must be stored once and sent once.
 * The scoring columns fill in when the batch scorer runs; the row exists from
 * the moment a posting clears a search's deterministic filters.
 *
 * `mismatches` is what makes a verdict answerable rather than a number. The
 * scorer names the axes a posting falls short on — seniority, location, stack,
 * pay — for winners and near-misses alike, so "why did you send me this?" and
 * "why didn't you?" have the same kind of answer.
 */
export const jobMatches = sqliteTable(
  'job_matches',
  {
    jobId: text('job_id').notNull(),
    searchSlug: text('search_slug').notNull(),

    /** 0–100. Null until the scorer has seen it. */
    fit: integer('fit'),
    /** At most 20 words, concrete. Written for winners and near-misses alike. */
    reason: text('reason'),
    mismatches: text('mismatches', { mode: 'json' }).$type<string[]>(),
    scoredAt: integer('scored_at'),
  },
  table => [
    primaryKey({ columns: [table.jobId, table.searchSlug] }),
    index('idx_job_matches_unscored').on(table.searchSlug, table.scoredAt),
    index('idx_job_matches_fit').on(table.searchSlug, table.fit),
  ],
)

/**
 * Every posting actually delivered. **Never pruned.**
 *
 * This is what prevents a re-send, and it exists because the rule that protects
 * the news pipeline does not hold here. There, an ingest window well below
 * retention means a pruned article is refused on age before it can be
 * re-ingested. Here, a source that ships **no posting date** makes age fall back
 * to first-seen — so a posting pruned at 60 days and crawled again the next day
 * reads as zero days old, passes the window, takes a fresh `YYYY-MM` in its key,
 * and lands as a new row with a null `deliveredAt`. No tuning of the two windows
 * prevents that. This table does, by construction.
 *
 * Affordable for the reason `feedback` is: it grows only when something actually
 * reached the reader, which is a handful a week at ~100 bytes.
 *
 * Keyed on the **month-less** identity, so a genuine repost past
 * `redeliveryGuardDays` is allowed through — that is the behaviour the reader
 * asked for. `deliveredAt` is overwritten on re-delivery rather than appended,
 * because the only question this table answers is "how long ago was this seen".
 *
 * Title, company and URL are copied at delivery so a row outlives the `jobs` row
 * it came from — the same denormalization argument `feedback` makes.
 */
export const jobDeliveries = sqliteTable('job_deliveries', {
  identity: text('identity').primaryKey(),
  company: text('company').notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  searchSlug: text('search_slug').notNull(),
  deliveredAt: integer('delivered_at').notNull(),
})

/**
 * One job run, and the reason the schedule can fire daily.
 *
 * **`startedAt` is what makes the cadence every-two-days**, not the cron. A
 * day-of-month step fires on the 1st, 3rd … 31st and then the 1st again, so
 * seven month boundaries a year give two consecutive runs; and a missed schedule
 * firing on boot already put two runs in flight at once in this repo's history.
 * A stored timestamp makes the cadence a property of the data rather than of the
 * cron string or of process uptime.
 *
 * The counters are the other half: the news pipeline reports a run into the void
 * and nothing can answer "was last Tuesday quiet or broken?". `note` carries the
 * one-line reason a run did nothing — a portfolio that would not fetch, no
 * active searches — which is the difference between those two.
 */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    startedAt: integer('started_at').notNull(),
    /** Null while in flight. A row that never finishes is a crashed run. */
    finishedAt: integer('finished_at'),
    fetched: integer('fetched').notNull().default(0),
    stored: integer('stored').notNull().default(0),
    /** Postings that survived the deterministic filters and reached the model. */
    considered: integer('considered').notNull().default(0),
    scored: integer('scored').notNull().default(0),
    delivered: integer('delivered').notNull().default(0),
    note: text('note'),
  },
  table => [index('idx_job_runs_started').on(table.startedAt)],
)

export type JobRun = typeof jobRuns.$inferSelect

export type JobSource = typeof jobSources.$inferSelect
export type NewJobSource = typeof jobSources.$inferInsert
export type JobSourceKind = JobSource['kind']
export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
export type JobRemote = Job['remote']
export type JobMatchRow = typeof jobMatches.$inferSelect
export type JobDeliveryRow = typeof jobDeliveries.$inferSelect

/**
 * Telegram forum topics provisioned in a bot's chat — the "tabs".
 *
 * Keyed by `(botId, chatId, slug)`. The chat id is there because a topic id is
 * only meaningful inside one chat: point a bot at a different chat and the old
 * rows must not be reused as if they were valid there.
 *
 * **The bot id is there because a chat id does not identify a conversation.**
 * That is the part worth reading twice. In a *private* chat Telegram's
 * `chat.id` **is the user's id**, and user ids are global rather than per-bot —
 * so Newy and Joob, talking to the same person, both see chat `8401775038`.
 * Their conversations are distinct in the client and share nothing else, but on
 * this table they collided: two rows keyed `('8401775038', 'chat', …)` holding
 * two different thread ids.
 *
 * The failure was not a mixup, it was destructive. The second bot resolves its
 * Chat tab, finds the first bot's row, adopts a thread id that does not exist in
 * its own conversation, fails to send, and `invalidateTopic` then deletes the
 * *other* bot's row — which that bot recreates, and `createForumTopic` is not
 * idempotent, so a duplicate tab appears. Adding the column was the fix
 * ([ADR-0023](../../docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)).
 *
 * Note this is only true of private chats. Two supergroups are two ids, so the
 * old key was correct for that route and merely incomplete — which is exactly
 * why it looked right.
 *
 * `messageThreadId` is Telegram's, not ours — we can create a topic but never
 * choose its id, so this table is a cache of what Telegram assigned. A row going
 * stale (topic deleted on the phone) is expected, not exceptional.
 */
export const telegramTopics = sqliteTable(
  'telegram_topics',
  {
    /** Which bot owns this tab — `newy`, `joob`. See the note above. */
    botId: text('bot_id').notNull(),
    chatId: text('chat_id').notNull(),
    slug: text('slug').notNull(),
    messageThreadId: integer('message_thread_id').notNull(),
    /**
     * The tab name Telegram was last told, so a renamed topic can be pushed with
     * `editForumTopic` rather than silently applying only to tabs created
     * afterwards. There is no `getForumTopic` to read it back with, so
     * remembering what we sent is the only way to know whether it has drifted.
     *
     * Nullable for rows written before names were tracked. Null reads as
     * "unknown", which costs exactly one rename on the next resolve.
     */
    name: text('name'),
    createdAt: integer('created_at').notNull(),
  },
  table => [primaryKey({ columns: [table.botId, table.chatId, table.slug] })],
)

export type TelegramTopicRow = typeof telegramTopics.$inferSelect

/**
 * One row per scheduled pipeline, holding the moment its last run was allowed to
 * start. The lock that stops two runs of the same pipeline overlapping.
 *
 * **This is not a duplicate of `job_runs.startedAt`, and the split is the
 * point.** `job_runs` is the log: one row per run, with counters, a finish time
 * and a note, written so a run can be read back afterwards. This table is the
 * permission to *become* one of those runs — a single row, overwritten, never
 * read for reporting. Keeping the log as the lock is what the jobs gate did, and
 * it could not be made safe: deciding from a `select` and then writing an
 * `insert` leaves a gap in which a second run reads the same answer and starts
 * too ([ADR-0034](../../docs/decisions/0034-a-pipeline-claims-its-cycle.md)).
 *
 * Deliberately not keyed to a schedule or a fire time. The two runs that
 * collided on 2026-08-16 were different occurrences of different schedules —
 * the 14th's 20:00 and the 15th's 10:00 — so anything keyed by which fire it was
 * would have given them separate keys and let both through. What has to be
 * bounded is the gap between *starts*, whatever the runs believe they are.
 */
export const pipelineCycles = sqliteTable('pipeline_cycles', {
  /** The pipeline, not the run: `news`, `jobs`. */
  id: text('id').primaryKey(),
  /** When the run holding this cycle was allowed to start. */
  startedAt: integer('started_at').notNull(),
})

export type PipelineCycleRow = typeof pipelineCycles.$inferSelect

export type Beat = typeof beats.$inferSelect
export type NewBeat = typeof beats.$inferInsert
export type BeatFeedRow = typeof beatFeeds.$inferSelect
export type Article = typeof articles.$inferSelect
export type NewArticle = typeof articles.$inferInsert
export type ArticleBeatRow = typeof articleBeats.$inferSelect
export type FeedStateRow = typeof feedState.$inferSelect
export type FeedbackRow = typeof feedback.$inferSelect
export type MemoryRow = typeof memories.$inferSelect

export type DeliveryKind = NonNullable<Article['deliveryKind']>
export type Vote = FeedbackRow['vote']
export type MemoryTier = MemoryRow['tier']

// ---------------------------------------------------------------------------
// Leads — the prospecting pipeline
// ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
//
// Its own tables beside the job ones, sharing everything below them. Nothing
// here is read or written by the job pipeline, and the leads workflow reads
// `jobs` **read-only**, as a signal source.
// ---------------------------------------------------------------------------

/**
 * What the reader sells, and who should buy it. The lead-side counterpart to
 * `job_searches`, and deliberately much smaller.
 *
 * ADR-0038 recorded why this is not a `job_searches` row with a mode flag: four
 * of that table's columns flip meaning here and two go dead. `domain` is the one
 * that settles it — on a search it is the *role's* field, and a reader selling a
 * horizontal service (visuals, copy, photography) wants clients in **every**
 * industry, so the column would have to mean the buyer's sector here and the
 * role's field there.
 *
 * Written by `/client` and `/reclient`, which
 * [invariant 8](../../AGENTS.md#invariants) permits for the same reason it
 * permits `/target`: configuration a *future* run reads, never anything a run
 * produced.
 */
export const clientProfiles = sqliteTable(
  'client_profiles',
  {
    slug: text('slug').primaryKey(),
    /** Names this profile in the footer of every lead it wins. */
    label: text('label').notNull(),
    /** Verbatim, in the reader's own language — what they typed. */
    request: text('request').notNull(),

    /**
     * What the reader sells, in one line, as the targeter understood it.
     *
     * Separate from `request` because the request is one sentence about buyers
     * *and* offer, and the scorer needs the offer on its own. The portfolio is
     * still the rubric; this is the label on it.
     */
    offer: text('offer').notNull(),

    /**
     * Buyer industries worth pitching. **Empty means any**, and empty is the
     * common, correct answer for a horizontal service.
     *
     * Free-form as the reader said them, not a taxonomy key. There is no
     * vocabulary of buyer industries in this repo, and inventing one would repeat
     * the mistake ADR-0028 had to undo: a curated list deciding which customers
     * the reader is allowed to want.
     */
    industries: text('industries', { mode: 'json' }).$type<string[]>().notNull(),
    /** Free-form place names. Empty means anywhere. */
    locations: text('locations', { mode: 'json' }).$type<string[]>().notNull(),
    /**
     * Which signal kinds count for this profile — a subset of
     * `LEAD_SIGNAL_KINDS`. Empty means all of them.
     *
     * This is the profile's main lever, and it is a *source-side* one on purpose.
     * ADR-0038: lead intake is unbounded, so the cap belongs on what is fetched
     * and considered rather than on a criterion applied afterwards.
     */
    signalKinds: text('signal_kinds', { mode: 'json' }).$type<string[]>().notNull(),
    /** Terms that reject a lead outright, whatever else it says. */
    dealbreakers: text('dealbreakers', { mode: 'json' }).$type<string[]>().notNull(),
    /** Smallest engagement worth the reader's time, in `currency`. Null means unstated. */
    minDealSize: integer('min_deal_size'),
    currency: text('currency'),

    /** Everything a filter cannot express. Read by the scorer, not by the filter. */
    notes: text('notes'),
    /** 0–100. Null means `leadPipeline.defaultFitThreshold`. */
    fitThreshold: integer('fit_threshold'),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** Set to stop prospecting for this profile without losing its history. */
    archivedAt: integer('archived_at'),
  },
  table => [index('idx_client_profiles_active').on(table.archivedAt)],
)

/**
 * A company that might need what the reader sells.
 *
 * **The primary key is the normalized host, stored readable rather than hashed**
 * — see `lead-identity.ts`. A lead is a company, and the host is the only thing
 * about a company that code establishes; every other attribute here arrives as a
 * model's phrasing or a page's marketing copy, which ADR-0026 measured to be
 * unusable as a key.
 *
 * Note what is *not* on this row: a fit score. Scores live on `lead_matches`,
 * because a company can be a strong lead for one client profile and a waste of a
 * message for another — exactly as `job_matches` splits a posting's fit per
 * search.
 */
export const leads = sqliteTable(
  'leads',
  {
    /** The normalized host. `acme.com`, or `acme.myshopify.com` on a platform. */
    id: text('id').primaryKey(),
    /** As last seen. Display only — never part of the key. */
    company: text('company').notNull(),
    /** Free-form, as a page or a model gave it. Used by the clustering pass. */
    location: text('location'),
    /** Where the company lives. The canonical https form of the host. */
    url: text('url').notNull(),

    /**
     * Text pulled from the company's own page, capped at
     * `leadPipeline.maxPageChars`.
     *
     * This is what the filter and the text scorer actually read, and it is
     * **evidence off a page rather than prose from a model** — the rule ADR-0026
     * established when a lead described only by a model's one-line "why" was
     * rejected by every `mustHave` there was, so the source delivered nothing
     * while every counter said it ran.
     */
    pageText: text('page_text'),
    /** When that page was last read, so a stale lead can be refreshed. */
    pageFetchedAt: integer('page_fetched_at'),

    /**
     * What the vision model said about the company's visuals, and when.
     *
     * **Stored so it is paid for once per company rather than once per signal.**
     * Vision is the most expensive call in the system and a company's site does
     * not change weekly; it is re-run after `leadPipeline.visionStaleDays`, or
     * when a signal implies the visuals moved.
     *
     * A judgement, never evidence. It may weigh in a fit score and it may shape
     * the outreach line; it may never be read by a filter, because a hard filter
     * reading model-written text lets a lead pass on invented grounds.
     */
    visionVerdict: text('vision_verdict'),
    visionAt: integer('vision_at'),

    discoveredAt: integer('discovered_at').notNull(),
    /** Bumped by every new signal. What retention is measured from. */
    lastSignalAt: integer('last_signal_at').notNull(),
  },
  table => [index('idx_leads_last_signal').on(table.lastSignalAt)],
)

/**
 * One dated public event that makes a company worth contacting *now*.
 *
 * The signal is what bounds an otherwise unbounded universe: every company on
 * the web is a candidate client, and "they raised on Tuesday" is what makes the
 * set finite. It is also the entire content of the reader's opening line, which
 * is why the source URL and the date are kept rather than summarized away.
 *
 * `id = hash(leadId + kind + canonicalSourceUrl)` — the **date is deliberately
 * not in the key**, because feeds disagree by hours about the same announcement
 * and including it would re-split what this exists to merge.
 */
export const leadSignals = sqliteTable(
  'lead_signals',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull(),
    /** `hiring` | `funding` | `launch` | `rebrand`. A closed set — see `leads.ts`. */
    kind: text('kind').notNull(),
    /** Where it was seen. Canonicalized, so three feeds carrying it are one row. */
    sourceUrl: text('source_url').notNull(),
    /** Which source produced it — a job source id, a feed url, `jobs-table`. */
    origin: text('origin').notNull(),
    /** The event's own date. What recency is judged on. */
    occurredAt: integer('occurred_at').notNull(),
    /** One line of what happened, for the message. */
    summary: text('summary').notNull(),
    discoveredAt: integer('discovered_at').notNull(),
  },
  table => [
    index('idx_lead_signals_lead').on(table.leadId, table.occurredAt),
    index('idx_lead_signals_recent').on(table.occurredAt),
  ],
)

/**
 * How well one lead fits one client profile, for one signal.
 *
 * Keyed on the signal rather than only on the lead, because the *reason to make
 * contact* is what is being scored: the same company is a weak lead on a routine
 * hire and a strong one the week it raises. That is also what makes re-surfacing
 * possible at all — see `lead_deliveries`.
 */
export const leadMatches = sqliteTable(
  'lead_matches',
  {
    leadId: text('lead_id').notNull(),
    signalId: text('signal_id').notNull(),
    profileSlug: text('profile_slug').notNull(),

    /** 0–100. Null until the text scorer has seen it. */
    fit: integer('fit'),
    /** At most 20 words, concrete. Written for winners and near-misses alike. */
    reason: text('reason'),
    /** Named gaps — budget, timing, fit, reachability — so `/why` can answer. */
    mismatches: text('mismatches', { mode: 'json' }).$type<string[]>(),
    /**
     * The opening the writer proposed, kept so the reader can ask for it again
     * without a second model call.
     */
    angle: text('angle'),
    scoredAt: integer('scored_at'),
  },
  table => [
    primaryKey({ columns: [table.leadId, table.signalId, table.profileSlug] }),
    index('idx_lead_matches_unscored').on(table.profileSlug, table.scoredAt),
    index('idx_lead_matches_fit').on(table.profileSlug, table.fit),
  ],
)

/**
 * Every lead actually delivered. **Never pruned.**
 *
 * **Keyed `(leadId, signalId)`, and that is the sharpest difference from
 * `job_deliveries`** — which is keyed on identity alone and exists so a company
 * never arrives twice. That rule is wrong here: a company passed over in March
 * that raised a Series A in August is the best lead of the month, and a ledger
 * built to suppress it would suppress the thing the pipeline is for.
 *
 * What bounds it instead is `leadPipeline.cooldownDays`, enforced against the
 * lead's most recent delivery regardless of signal — so a company that raises,
 * launches and hires in one week arrives once, carrying whichever signal scored
 * best.
 */
export const leadDeliveries = sqliteTable(
  'lead_deliveries',
  {
    leadId: text('lead_id').notNull(),
    signalId: text('signal_id').notNull(),
    company: text('company').notNull(),
    url: text('url').notNull(),
    profileSlug: text('profile_slug').notNull(),
    signalKind: text('signal_kind').notNull(),
    deliveredAt: integer('delivered_at').notNull(),
  },
  table => [
    primaryKey({ columns: [table.leadId, table.signalId] }),
    index('idx_lead_deliveries_lead').on(table.leadId, table.deliveredAt),
  ],
)

/**
 * One leads run, and the reason its schedule can fire daily.
 *
 * The same shape and the same argument as `job_runs`: `startedAt` is what makes
 * the cadence, not the cron, because a day-of-month step double-fires across
 * month boundaries and a missed schedule fires on boot.
 *
 * `visionCalls` is counted separately from `scored` because it is the number that
 * costs money. A run where it equals `leadPipeline.maxVisionCallsPerRun` hit the
 * cap, which is the signal that a filter or a threshold is letting too much
 * through — visible here rather than only on an invoice.
 */
export const leadRuns = sqliteTable(
  'lead_runs',
  {
    id: text('id').primaryKey(),
    startedAt: integer('started_at').notNull(),
    /** Null while in flight. A row that never finishes is a crashed run. */
    finishedAt: integer('finished_at'),
    /** Signals seen from all sources, before dedupe. */
    fetched: integer('fetched').notNull().default(0),
    /** Signals that were new, and the leads they resolved to. */
    stored: integer('stored').notNull().default(0),
    /** Leads that survived the deterministic filter and reached the text scorer. */
    considered: integer('considered').notNull().default(0),
    scored: integer('scored').notNull().default(0),
    visionCalls: integer('vision_calls').notNull().default(0),
    delivered: integer('delivered').notNull().default(0),
    /** The one-line reason a run did nothing, so quiet and broken look different. */
    note: text('note'),
  },
  table => [index('idx_lead_runs_started').on(table.startedAt)],
)

export type ClientProfile = typeof clientProfiles.$inferSelect
export type NewClientProfile = typeof clientProfiles.$inferInsert
export type Lead = typeof leads.$inferSelect
export type NewLead = typeof leads.$inferInsert
export type LeadSignal = typeof leadSignals.$inferSelect
export type NewLeadSignal = typeof leadSignals.$inferInsert
export type LeadMatchRow = typeof leadMatches.$inferSelect
export type LeadDeliveryRow = typeof leadDeliveries.$inferSelect
export type LeadRunRow = typeof leadRuns.$inferSelect
