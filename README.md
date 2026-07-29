# ava-agent

A personal Telegram orchestrator that curates RSS news through category-expert
sub-agents, on a schedule.

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

In Studio, open **Workflows → curateCategory**, run it with
`{ "categorySlug": "design" }`, and watch each step. **Workflows → Schedules**
lists the seven declared fire times — six digests and the nightly prune.

## Adding a category

Add an entry to [`src/config/categories.ts`](src/config/categories.ts) — slug,
subtopics, feeds, rubric, thresholds. Nothing else. The agents, the workflow and
the schedules are all derived from that array, and the rubric plus a per-category
feedback history is what makes each curator expert on its beat.

Then verify the feeds resolve:

```bash
pnpm feeds:check
```

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Mastra Studio — run agents and workflows, read traces |
| `pnpm build` | Bundle to `.mastra/output` |
| `pnpm feeds:check` | Confirm every configured feed is reachable and parses |
| `pnpm db:generate` | Emit a migration after editing `src/db/schema.ts` |
| `pnpm db:studio` | Browse the database |
| `pnpm typecheck` | `tsc --noEmit` |

## Deployment

```bash
docker compose up -d --build
```

State lives in the `ava-data` volume, so back it up — it holds your dedupe
history and the feedback that trains the rankers.

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

Ava, the conversational half, answers in the **Chat** tab and only there; a
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

Your language is not configured anywhere — it is read from what Ava has noted
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
