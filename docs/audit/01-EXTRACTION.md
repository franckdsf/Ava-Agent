---
audited_at: f6c2b89
---

# 01 — Extraction: the architecture as implemented

> Frozen. This describes the repo at `f6c2b89`, derived by reading the code, not the docs. It is
> not updated as the refactor lands — see [README.md](README.md#when-the-refactor-lands).
> Counts come from scripts run against that commit; where a number is quoted, the command that
> produced it is in [Method](#method).

No judgement here. Where something looks wrong it is marked **→ 02** (a doc disagrees) or
**→ 03** (a defect candidate) and left for those documents.

---

## 1. What it is

One Node process running a Mastra server, deployed as one Docker container per reader, holding:

- **two Telegram bots** on two tokens — **Newy** (news) and **Joob** (jobs and leads) — long-polled,
  each with a forum chat split into tabs;
- **three scheduled pipelines** — news (`curate-all`), jobs (`find-jobs`), leads (`find-leads`) —
  plus four maintenance workflows;
- **one libSQL database** shared by drizzle (22 app tables) and Mastra (`mastra_*`), and a second,
  disposable one for traces.

**Size:** 114 files and 27,839 lines in `src/`, of which **11,398 (41%) are comment lines**. 22
scripts in `scripts/`. **No tests under `src/`.** 43 ADRs, 9 gotcha files.

## 2. Layout and layers

```
src/
  config/     30 files  tunables, vocabularies, command definitions, seeds, bot profiles, env
  lib/         2 files  project-root.ts, libsql-url.ts — path anchoring
  db/         13 files  drizzle schema + one repository module per table family
  services/   30 files  fetching, parsing, filtering, identity, Telegram transport
  mastra/
    index.ts            composition root: registers agents and workflows, fires boot tasks
    agents/   14 files  Agent definitions AND the functions that call them
    workflows/ 7 files  the pipelines
    commands/  6 files  slash-command handlers
    tools/     6 files  tools the conversational agents call
    (root)     6 files  channels, joob-channels, chat-surface, boot-catchup, storage, index
```

### Who imports whom

Runtime and type import edges between layers (`relative` imports only; 0 cycles — C2):

| from ↓ to → | config | lib | db | services | agents | tools | commands | workflows | mastra root |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| config | 8 | | 1ᵗ | | | | | | |
| db | 8 | 2 | 30 | **1** | | | | | |
| services | 36 | | 15 | 30 | **2** | | | | |
| agents | 31 | | 5 | 5 | 3 | 7 | | | **3** |
| tools | 7 | | 10 | 2 | **2** | | | | |
| commands | 13 | | 11 | 20 | **5** | | 3 | | |
| workflows | 21 | | 19 | 27 | 6 | | | | |
| mastra root | 15 | 1 | 7 | 9 | 13 | | 5 | 9 | 6 |

ᵗ type-only.

**The direction is overwhelmingly downward** — `mastra/*` → `services` → `db` → `config`. The edges
that go the other way or sideways:

| Edge | What crosses |
| --- | --- |
| `db/jobs.ts` → `services/job-identity.ts` | `advertKey` — the dedupe key, computed in a service, used by the repository |
| `services/job-scout.ts` → `mastra/agents/job-scout.ts` | `proposeCompanies` — a service calls a model function |
| `services/lead-scout.ts` → `mastra/agents/lead-scout.ts` | a type only |
| `agents/newy.ts`, `agents/joob.ts` → `mastra/channels.ts`, `chat-surface.ts` | the agent definition needs its Telegram surface |
| `commands/*` → `agents/*` (5) | `summarizeSource`, `translateChunk`, `parseTarget`, `parseClient`, `nameBeat` |
| `tools/*` → `agents/*` (2) | `summarizeSource`, `slugFromTitle` |

### Packages by layer

| Package | Used in |
| --- | --- |
| `drizzle-orm` | `db/` (13), and **outside it**: `commands/beats.ts`, `tools/news.ts`, `services/lead-signals.ts` |
| `@mastra/core` | `mastra/*`, and `services/job-scout.ts` |
| `@chat-adapter/telegram` | `agents/newy.ts`, `agents/joob.ts`, `services/telegram*.ts` |
| `zod` | `config/env.ts`, `agents/`, `tools/`, `workflows/` |
| `rss-parser`, `youtube-caption-extractor`, `replicate` | one service or tool each |

## 3. The composition root — `src/mastra/index.ts`

One `new Mastra({...})` registers **every agent** (spread from per-file `*Agents` maps or single
`[id]: agent` entries) and **seven workflows**, with `storage` from `mastra/storage.ts`. Then four
fire-and-forget tasks, each with its own `.catch` that logs:

1. `seedBeats()` — writes starter beats if `beats` is empty;
2. `seedJobSources()` — the same for `job_sources`;
3. `registerChatCommands(mastra, newy.getChannels())` and `registerJoobCommands(...)` — slash
   commands, the command menu, and the bot profile, per bot;
4. `catchUpOnBoot(mastra)` — fires a pipeline that is past its staleness bar.

**There is no migrate step at boot.** Every repository function awaits a memoised `migrate()`
(`db/client.ts`). Measured: **97 of 102** exported functions in `db/*.ts` await it; the 5 that do
not are pure helpers (`hoursSince`, `memoryId`, `shortTermCutoff`) or delegate to one that does.

## 4. Data

**One libSQL client** (`db/client.ts`, `rawClient()`) is shared by drizzle and Mastra's
`LibSQLStore`, with `timeout` set per connection for file URLs. Traces go to a second database
through `ObservabilityLibSQL`.

**22 drizzle tables**, in families:

| Family | Tables | Repository |
| --- | --- | --- |
| news | `beats`, `beat_feeds`, `beat_revisions`, `feed_state`, `articles`, `article_beats`, `feedback` | `beats.ts`, `feeds.ts`, `articles.ts`, `feedback.ts` |
| memory | `memories` | `memories.ts` |
| jobs | `job_searches`, `job_sources`, `jobs`, `job_matches`, `job_deliveries`, `job_runs` | `job-searches.ts`, `jobs.ts` |
| leads | `client_profiles`, `leads`, `lead_signals`, `lead_matches`, `lead_deliveries`, `lead_runs` | `leads.ts` |
| shared | `telegram_topics`, `pipeline_cycles` | `topics.ts`, `cycles.ts` |

Plus FTS5 virtual tables created by hand-written migrations (`drizzle/0005`, `0010`).

**Every write to an app table is inside `src/db/`** — no `insert`/`update`/`delete` on a drizzle
table anywhere else. **Reads are not:** `db()` is called directly in `tools/news.ts` (7×),
`commands/beats.ts`, `workflows/find-leads.ts` (through a dynamic `import()`) and
`services/lead-signals.ts`. **→ 03**

**"When did this pipeline last run" has three sources:** the gate reads `pipeline_cycles`
(`claimCycle`, ADR-0034); the boot catch-up reads `job_runs` for jobs and `feed_state` for news;
`job_runs` / `lead_runs` are also a run log written after a successful claim. **→ 03**

## 5. The pipelines

All three scheduled pipelines have **the same shape**, written out three times:

| Stage | news `curate-all` (805 lines) | jobs `find-jobs` (987) | leads `find-leads` (667) |
| --- | --- | --- | --- |
| claim + gather | `ingest` — `claimCycle('news')`, fetch feeds | `ingest` — `claimCycle('jobs')`, fetch sources | `collect-signals` — `claimCycle('leads')` |
| score, per unit | `.foreach(rankBeat)` per beat | `.foreach(scoreSearch)` per search | `.foreach(scoreProfile)` per profile |
| assign | `assignBest` — a story to one beat | `assignBest` — a job to one search | — |
| deliver, per unit | `.foreach(deliverBeat)` | `.foreach(deliverSearch)` | `.foreach(deliverProfile)` |
| report | `report` | `report` (+ retention) | `report` |
| delivery claim | `claimForDelivery` (articles) | `job_deliveries` | `claimLeadDelivery` |
| schedule | `pipeline.digestHours` (10, 20) | `jobPipeline.runHours` (8, 20) | `leadPipeline.runHour` (9) — **one** fire |
| gate | `newsMinRunGapMs()` | `intervalHours` 20 | `intervalHours` 44 |
| boot catch-up | yes (7 days) | yes (3 days) | **no** |

**→ 03** for the leads row: one daily fire into a 44h gate, and no catch-up — the shape commit
`7762cf4` fixed for jobs.

**Maintenance workflows:** `prune-articles` (daily), `review-feeds` (weekly), `review-memories`
(weekly), and `discover-feeds` — the only one with no schedule, started by `/follow`.

## 6. Model calls

**19 `Agent`s are constructed, in 13 files, all in `mastra/agents/`**, and all registered in
`index.ts`. Every
model id is a zod-validated `AVA_MODEL_*` variable in `config/env.ts` with a default and the
measurement that chose it beside it.

`mastra/agents/` holds **two kinds of thing**: the agent definitions, and exported **functions that
call them** — `summarizeSource`, `translateChunk`, `parseTarget`, `parseClient`, `proposeCompanies`,
`nameBeat`, and the scorers. Those functions are imported by `services/`, `commands/`, `tools/` and
`workflows/`.

`.generate()` is called in 11 files: 10 in `agents/`, and **`workflows/curate-all.ts` (2)** — the
news ranker calls its agent inline rather than through a function in `agents/`.

**`withRetry`** (`services/structured-output.ts`) re-prompts a malformed structured answer. Used by
the batch scorers — `job-scorer`, `lead-scorer`, `lead-scout`, `lead-targeter`, and the ranker in
`curate-all` — **5 of the 11** model-calling files.

## 7. The Telegram surface

Two bots, defined in `config/bots.ts`, each with a parallel set of files:

| | Newy | Joob |
| --- | --- | --- |
| agent | `agents/newy.ts` | `agents/joob.ts` |
| command registrar | `mastra/channels.ts` | `mastra/joob-channels.ts` |
| transport instance | `services/newy-telegram.ts` | `services/joob-telegram.ts` |
| tabs | `config/newy-topics.ts` | `config/joob-topics.ts` |
| commands | `translation.ts`, `summary.ts`, `beat-commands.ts` | `job-commands.ts`, `lead-commands.ts` |
| profile | `config/bot-profile.ts` — both |

Each registrar is one catch-all `onSlashCommand` that dispatches by an `is*Command` predicate to a
`run*` handler in `commands/`, ends every branch in a message, then fire-and-forgets
`publishCommands` and `publishProfile`. The two registrars are the same code with different tables.

Free text goes to the agent through the Chat SDK; `chat-surface.ts`'s `routeToChatTab` moves a
message typed in a non-Chat tab (ADR-0010). Transport, tabs and replies are `services/telegram.ts`,
`telegram-topics.ts` and `telegram-reply.ts`; `telegram-topics.ts` makes 10 direct Bot API calls.

## 8. Services, by what they touch

| Kind | Files |
| --- | --- |
| **pure** — no network, no db, no model | `cluster`, `job-identity`, `job-tags`, `lead-identity`, `structured-output`, `arxiv` |
| **network only** | `feed-check`, `feed-discovery`, `feed-finder`, `feed-timeliness`, `page-fetch`, `portfolio`, `rss-finder`, `youtube` |
| **network + db** | `article`, `ats`, `job-fetch`, `job-hn`, `rss` |
| **db only** | `job-filter`, `lead-filter`, `lead-signals`, `quoted-article` |
| **model** | `job-scout`, `lead-scout` (through `mastra/agents/`) |
| **Telegram** | `telegram`, `telegram-topics`, `telegram-reply`, `newy-telegram`, `joob-telegram` |

## 9. Configuration

`src/config/` holds **five kinds of thing** under one name:

| Kind | Examples |
| --- | --- |
| tunables | `pipeline`, `jobs` (`jobPipeline`), `leads` (`leadPipeline`), `catchup`, `memory`, `database` |
| vocabularies | `job-taxonomy` (`DOMAINS`, `SENIORITY`), `leads` (`PLATFORM_HOSTS`, `LEAD_SIGNAL_KINDS`), `feed-finder` (`RACE_STOPWORDS`) |
| command and tab definitions | `beat-commands`, `job-commands`, `lead-commands`, `translation`, `summary`, `*-topics`, `topics` |
| seeds | `seed-beats`, `seed-job-sources` |
| identity and env | `env`, `bots`, `bot-profile` |

`env.ts` throws at import on an invalid core environment, and builds a bot's variables when that bot
is constructed. **Two other files read `process.env` directly:** `config/dev-server.ts` (`PORT`,
`AVA_DEV_SERVER_URL`, for scripts) and `services/portfolio.ts` (`PORTFOLIO_FEED_URL`,
`PORTFOLIO_FEED_TOKEN`) — outside the zod schema. **→ 03**

## 10. Verification as it exists

| What | Where | Offline? |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | yes |
| rule checks C1–C4, their tests | `scripts/checks/` (added at `f6c2b89`) | yes |
| **unit tests in disguise** | `check-leads.ts` (49 assertions), `check-catchup.ts` (18), `check-feed-review.ts` (13) — hand-rolled `check()` harnesses, no live calls | yes |
| live probes | the other twelve `check-*.ts` — feeds, models, Telegram, sources | no |
| the real pipeline | `pnpm workflow:run` | no — spends |

**→ 03**: 80 offline assertions run only when someone remembers the script; none run on commit.

## 11. Conventions the code actually follows

Measured, not taken from a doc:

- **kebab-case files**, one concern per file, `.js` suffixes on relative imports (all 399 in `src/`).
- **Named `function` declarations** — 298 exported, 0 exported arrow constants, **0 default exports**,
  3 classes.
- **No semicolons, single quotes** in `src/` (38 semicolon-terminated lines in 27,839).
- **Comment-dense by design** — 41% of lines; doc comments explain *why* and cite ADRs (170 `ADR-`
  references in `src/`).
- **A failure that must not stop a run is caught and logged**, and every fire-and-forget at boot has
  its own `.catch`. The exception is 15 `.catch(() => {})`, now baselined by C4.
- **Measurements live beside the number they chose** — model ids, thresholds and gates all carry the
  date and result that set them.
- **The code cites numbered invariants** — "invariant 8" 38 times, "invariant 2" 36 times, about 160
  in all across `src/` and the ADRs. **→ 02**

---

## Method

Every number above was produced at `f6c2b89` by one of these, run from the repo root:

- line counts: `git ls-files src | xargs wc -l`
- the layer matrix and package table: a script reusing `scripts/checks/_lib.mjs`'s tokenizer and C2's
  import grammar, walking `src/**/*.ts`
- `migrate()` coverage: every `export function` in `src/db/*.ts` tested for `await migrate()`
- writes outside `db/`: `grep -rnoE "\.(insert|update|delete)\((\w+)\)" src`
- model call sites: `grep -rnE "\.(generate|stream)\(" src`, `grep -rn "new Agent(" src`
- assertions in scripts: `^\s*check\(` per `scripts/check-*.ts`
- numbered invariants: `grep -rhoE "[Ii]nvariant [0-9]+" src scripts docs/decisions`
