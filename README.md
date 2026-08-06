# ava-agent

A personal Telegram orchestrator that curates RSS news through category-expert
sub-agents, on a schedule.

## Names

**Ava is the system, not an agent.** It is the repo, the database, the container,
the `AVA_*` environment — everything that outlives any one agent. Agents living
inside it have their own names, and **Newy** is the first: the conversational
agent behind the Chat tab, and the one whose face the bot wears.

The distinction matters because the system is built to hold more than one of
them, sharing Ava's memory and Ava's tables. Anything named `ava` in a path, a
variable or a volume is the system; a name in a prompt or a tab is an agent. See
[ADR-0022](docs/decisions/0022-ava-is-the-system-agents-have-names.md).

## Architecture

```
┌─ container (no inbound ports) ──────────────┐
│  Mastra          agents + workflows          │   ┌─ ava.db (libsql/Turso) ─┐
│  scheduler       native cron, Studio UI      │──▶│  mastra_* domains       │
│  Telegram        long-polling, outbound only │   │  feed_state/items/      │
└──────────────────────────────────────────────┘   │  feedback (Drizzle)     │
                                                   └─────────────────────────┘
                                                   ┌─ traces.db ─────────────┐
                                                   │  observability only     │
                                                   └─────────────────────────┘
```

**Mastra reasons, libSQL remembers.** Every LLM call happens in the container;
all durable state lives in libSQL. Nothing needs to reach the container from the
network — it polls Telegram and calls the model gateway outbound — so it runs
unchanged on a laptop, a Pi, a VPS, or Fly.

Two databases, split by lifetime: `ava.db` holds everything worth keeping,
`traces.db` is high-volume and disposable, so trace churn never contends for
locks with real data and the file can be deleted at any time.

### The pipeline

`ingest → cluster → rank → compose`, one workflow for every beat:

1. **ingest** — conditional GET per feed (ETag/Last-Modified), items older than
   `maxItemAgeDays` dropped, insert deduped on a hash of the canonical link.
2. **cluster** — lexical Jaccard over normalized titles, so one story carried by
   five outlets is ranked and delivered once.
3. **rank** — one cheap-model call scores every new item against the category
   rubric plus your recent 👍/👎.
4. **compose** — a strong model writes the digest for the handful that cleared
   the threshold.

Only steps 3 and 4 call a model. That's deliberate: a scheduled job that lets an
LLM pick its own control flow is how you get surprise bills and duplicate
messages.

A seventh schedule, `prune-items`, runs at 04:00 and deletes items older than
`retentionDays`, so the database stops growing without bound. It calls no model
either. Retention must stay well above `maxItemAgeDays` — freeing an id frees it
for re-ingest, and the ingest window is what stops a deleted story coming back
([0012](docs/decisions/0012-thirty-day-retention-on-items.md)).

## Setup

```bash
pnpm install
cp .env.example .env     # add OPENROUTER_API_KEY at minimum
pnpm dev                 # Studio at http://localhost:4111
```

Only `OPENROUTER_API_KEY` is required to start — Telegram variables are
validated lazily, so the news pipeline is fully usable before the bot exists.

On first boot the `beats` table is seeded from
[`src/config/seed-beats.ts`](src/config/seed-beats.ts) so there is something to
read. After that the table is the authority — the file is a starting state, not
configuration.

In Studio, open **Workflows → curateAll** and run it with `{}` for every beat, or
`{ "beats": ["design"] }` for one. **Workflows → Schedules** lists five declared
fire times: three digests, the nightly prune, and the weekly memory review.

## Adding a beat

A beat is a row in `beats` plus its feeds in `beat_feeds` — slug, subtopics,
rubric, and optional thresholds that fall back to `src/config/pipeline.ts` when
null. Nothing is derived at boot any more, so a beat added while the process is
running is picked up by the next digest with no restart
([ADR-0019](docs/decisions/0019-beats-as-reader-owned-data.md)). What makes each
curator expert on its beat is its rubric, passed in the ranker's prompt, plus a
per-beat feedback history and Newy's notes about the reader.

A story carried by two beats' feeds is stored once and scored by both, and is
delivered by whichever scored it higher. The others keep their score and a
one-line reason, so you can ask why something was skipped.

Then verify the feeds resolve:

```bash
pnpm feeds:check
```

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Mastra Studio — run agents and workflows, read traces |
| `pnpm build` | Bundle to `.mastra/output` |
| `pnpm workflow:run <target>` | Fire a scheduled workflow by hand against a running `pnpm dev`. **Spends money and sends to Telegram** — every other script here is a dry run. `--help` lists the targets and what each one costs |
| `pnpm feeds:check` | Confirm every subscribed feed is reachable and parses |
| `pnpm catchup:check` | Show what a boot would do about a pipeline that has gone quiet |
| `pnpm sonar:check "<slug or text>"` | Dry-run the `sonar` job source — companies, careers pages, what survives the filter. Calls a model |
| `pnpm finder:check "<topic>"` | Find candidate sources and measure **which of them break a story and which repeat it late**. `--against <url>` races them past feeds you already have |
| `pnpm rssfinder:check "<subject or domain>"` | Ask rssfinder.app what feeds it knows about a subject or a site. Add `--verify` to fetch each one |
| `pnpm db:generate` | Emit a migration after editing `src/db/schema.ts` |
| `pnpm db:studio` | Browse the database |
| `pnpm typecheck` | `tsc --noEmit` |

## Deployment

```bash
docker compose up -d --build
```

State lives in the `ava-data` volume, so back it up — it holds your dedupe
history and the feedback that trains the rankers.

### Coming back after a long absence

Schedules survive a restart, which means a machine that was off for a fortnight
comes back and simply waits for the next digest hour. So a boot **checks how long
each pipeline has been quiet** and fires the ones that have stopped, unless their
next scheduled fire is within half an hour:

| Pipeline | Normal cadence | Fires on boot after |
| --- | --- | --- |
| News (`curate-all`) | three digests a day | **7 days** without an ingest |
| Jobs (`find-jobs`) | a run every two days | **3 days** without a run |

Two bars rather than one, because a week of silence is twenty missed digests but
only three missed job runs. Three days for jobs rather than two so the bar sits
just above what a *healthy* jobs pipeline can drift to on its own (~68h), which is
what keeps an ordinary restart from costing a scoring run. The cadence itself is
untouched either way — the 08:00 digest still happens.

Both numbers are in [`src/config/catchup.ts`](src/config/catchup.ts), the
reasoning is in [ADR-0025](docs/decisions/0025-a-boot-catch-up-for-a-stale-pipeline.md),
and `pnpm catchup:check` prints what a boot right now would decide. The one thing
worth knowing: restarting the container while a pipeline is past its bar now costs
a real run, models included.

### Moving an existing database into the volume

**Do this before the first `compose up` if you have been running `pnpm dev`**,
because an empty volume against a chat you already use is not a clean start:

- `telegram_topics` is empty, so `resolveTopics()` creates a **second** set of
  tabs. `createForumTopic` is not idempotent and `deleteForumTopic` is not wired
  — the cleanup is manual, on the phone.
- `beats` re-seeds from `src/config/seed-beats.ts`, so every beat you made with
  `/follow` is gone.
- `feed_state` is empty, so the next digest re-ingests every feed from scratch
  and re-delivers what you have already read.

Stop the dev server first — a libsql database is only complete once it has
checkpointed, and a live `.db` file without its `-wal` sibling is missing
whatever has not been flushed:

```bash
ls .data/                       # copy ava.db-wal and -shm too if they exist
docker volume create ava-data
docker run --rm -v ava-data:/data -v "$(pwd)/.data:/seed:ro" node:22-slim \
  sh -c "cp /seed/ava.db* /data/ && chown -R 1000:1000 /data"
```

`traces.db` is disposable and does not need copying. Check a row count you know
before trusting the copy.

### The bot provisions itself

Bring the container up against a fresh bot token and it publishes its own
identity on boot — no retyping anything into @BotFather:

| What | From | Method |
| --- | --- | --- |
| The `/` command menu | `TRANSLATIONS`, `BEAT_COMMANDS`, `summary` | `setMyCommands` |
| Name, and both descriptions | [`src/config/bot-profile.ts`](src/config/bot-profile.ts) | `setMyName`, `setMyShortDescription`, `setMyDescription` |
| The tabs | [`src/config/topics.ts`](src/config/topics.ts) | `createForumTopic`, on first use |

The profile **reads before it writes**, so editing the config is what changes the
bot and a restart loop costs nothing — `setMyName` is flood-limited hard enough
that pushing it on every boot would eventually lock the bot out of renaming
itself. The command menu is a full replacement every boot, which is safe for
`setMyCommands` and is what keeps the config the source of truth.

**One step no API can do: Threaded Mode.** It is a BotFather toggle, and without
it the tabs degrade to one flat stream:

```
@BotFather → /mybots → <your bot> → Bot Settings → Threads Settings → Threaded Mode
```

`pnpm telegram:check` reports, for every configured bot, whether it is on, which
tabs exist, and any profile
field the next boot would push. It is read-only — safe against a running bot.

To run stateless instead, point `AVA_DATA_DB_URL` at a Turso database and drop
the volume. Turso *is* libSQL, so this is a URL change, not a code change:

```bash
turso db create ava
turso db show ava --url && turso db tokens create ava
```

## Why it looks like this

Non-obvious decisions are recorded as ADRs in
[`docs/decisions/`](docs/decisions/README.md) — including the ones that were
reversed, which are usually the informative ones:

- [0001](docs/decisions/0001-mastra-in-a-container-with-no-inbound-ports.md) — why nothing reaches the container from the network
- [0003](docs/decisions/0003-convex-for-storage-and-scheduling.md) → [0005](docs/decisions/0005-two-libsql-databases-instead-of-convex.md) — Convex was adopted, then dropped when each of its three advantages dissolved
- [0004](docs/decisions/0004-native-mastra-schedules-over-a-job-queue.md) — why a durable job queue isn't needed for an idempotent pipeline
- [0007](docs/decisions/0007-lexical-clustering-instead-of-embeddings.md) — why clustering is free, and what would justify paying for it

[`CLAUDE.md`](CLAUDE.md) carries the operational invariants for anyone — human or
agent — picking the repo up cold.

## Status

Working: ingest, dedupe, clustering, ranking, digest composition, schedules, and
Telegram delivery — one message per article, into the **News** tab. Items are
marked delivered as they land, so a failure partway through a batch doesn't
re-send what already arrived.

Newy, the conversational half, answers in the **Chat** tab and only there; a
message typed in another tab is answered in Chat instead. Her tools are read-only
over the news tables. See
[ADR-0009](docs/decisions/0009-telegram-topics-as-tabs.md) and
[ADR-0010](docs/decisions/0010-ava-answers-only-in-the-chat-tab.md).

She also remembers you. Facts you mention are written to a `memories` table as
she goes — split into lasting ones (your name, where you live) and recent ones
(what you ate, what you're working on), each dated, and injected into her prompt
every turn. Nothing is ever overwritten, so a fact that changes reads as a
history rather than a correction: *blond since January, dark before that*. See
[ADR-0014](docs/decisions/0014-two-tier-memory-for-ava.md).

Once a week a review agent reads the notes, promotes the ones that turned out to
be lasting — a new job, a person's name — and deletes the ordinary days
([ADR-0015](docs/decisions/0015-weekly-memory-review.md)).

Two slash commands turn an article into reading practice. Swipe to reply on any
delivered article and send `/translearn` for it back in your own language with
the English original behind almost every word, or `/translate` for the same thing
glossed only on the terms worth watching:

> Les modèles OlmoEarth sont notre famille de modèles de fondation
> (foundation models) d'observation de la Terre, pré-entraînés (pretrained) sur
> environ 10 téraoctets de données satellitaires multimodales.

Your language is not configured anywhere — it is read from what Newy has noted
about you. What *is* configured is how good your English already is:
`translation.readerLevel` in [`src/config/translation.ts`](src/config/translation.ts)
is a CEFR level, and it is what stops the glosses landing on words you have known
for years. Headings, lists and code blocks are preserved, and code is repaired
and fenced rather than flattened into prose.

Output lands in a third tab, **Translations**, because a full article arrives as
several messages over a few minutes
([ADR-0017](docs/decisions/0017-translation-commands.md)).

A third command explains an article instead of translating it. Swipe and send
`/summarize` for a few hundred words on what it is, what changed, the concrete
numbers, and the caveats the digest card had no room for — noticeably more than
the digest already gave you. It writes in English by default, or in whatever
language you name after it:

```
/summarize        → English
/summarize fr     → French
/summarize ru     → Russian
/summarize deutsch
```

A code, an English name or the language's own name all work; the footer reports
which language it actually used, so a typo is visible rather than silent. This
one answers in **Chat**, not in Translations — it is one short message, and the
tab split is about length, not about being a command
([ADR-0018](docs/decisions/0018-summarize-command.md)).

Not yet wired: the 👍/👎 feedback loop. The inbound path exists now, but nothing
handles a reaction yet.
