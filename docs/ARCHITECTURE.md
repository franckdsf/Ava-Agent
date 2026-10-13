# Architecture

How the code is put together **as built** — the shapes every change is expected to fit, and the
check that holds each one. What it does and how to run it: [README.md](../README.md). Why each
choice was made: the [ADRs](decisions/README.md), linked inline. How it got here: the frozen
[audit](audit/README.md), whose blueprint this replaces.

**One principle runs through all of it: a second copy is a missing definition.** When two files
differ only in data — a name, a slug, a table — the data becomes a definition and the code is
written once against it. The refactor of October 2026 applied it to bots, commands, pipelines, model
calls and database reads; the sections below are what it left.

---

## The folders

| Folder | Holds | Held by |
| --- | --- | --- |
| `src/bots/` | one data file per bot — id, env prefix, tabs, profile — and `BOTS` | C7 names the bots from these files |
| `src/config/` | every tunable, each beside the measurement that chose it; `env.ts` holds model ids | 👁 — no number in logic |
| `src/db/` | the schema and **every** read and write of the app tables | C6 |
| `src/lib/` | dependency-free helpers: `resolveFromRoot`, `resolveDbUrl`, `hostOf` | C3 |
| `src/services/` | pure logic and outbound I/O — feeds, boards, filters, Telegram transport | C7 (names no bot) |
| `src/mastra/agents/` | every `new Agent(`, every prompt, and `structured()` — the one model call | C5 |
| `src/mastra/commands/` | slash commands, one `Command` object beside its handler | — |
| `src/mastra/tools/` | what a conversational agent may call — reads, and the writes ADR-0043 allows | 👁 invariant 8 |
| `src/mastra/workflows/` | the scheduled and reader-triggered runs, each its own steps | C8 |
| `src/mastra/` (top) | what is built once for every bot and pipeline: registrar, chat routing, the kit, catch-up | C7, C8 |

There is no strict layering beyond these boundaries — `services/job-scout.ts` calls an agent
function, `db/jobs.ts` uses `services/job-identity.ts` — and C2 keeps any of it from becoming a
cycle.

---

## A bot is data

A bot is **three places**: its data file in `src/bots/`, its agent in `src/mastra/agents/<bot>.ts`
(prompt and tools), and its surface in `src/mastra/commands/<bot>.ts` (its commands, `/start`, how it
says a command failed). Everything else is built from those, once:

| Built once | Where | From |
| --- | --- | --- |
| `transportFor(bot)` — the Telegram transport, memoised | `src/bots/index.ts` | the data file |
| `createChatAgent(surface, spec)` — polling adapter, memory, chat-tab routing | `src/mastra/agents/chat-agent.ts` | the surface and the agent's spec |
| `registerBot(mastra, surface, channels)` — slash dispatch, menu, `/start`, unknown reply, profile | `src/mastra/registrar.ts` | the surface |
| `runCommand(command, ctx, failed)` — one try/catch, one deferred acknowledgement | `src/mastra/commands/command.ts` | each `Command` |

**A command is one object** — `name`, `description`, `help`, `usage`, `tab`, `working`, `run` — so the
menu, `/start` and the unknown-command reply are derived from the same list and cannot disagree.

**A third bot is** those three files plus its command files, and two registry lines: `BOTS` in
`src/bots/index.ts` (the data, which services read) and `CHAT_BOTS` in `src/mastra/chat-bots.ts`
(agent and surface, which import agents — so the data layer cannot hold them). The condition for
splitting Joob into a third bot is in [AGENTS.md](../AGENTS.md#names).
[ADR-0047](decisions/0047-a-bot-is-data-and-a-command-is-one-object.md) · [ADR-0023](decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)

---

## A pipeline is its own steps inside a shared kit

The three scheduled pipelines — news (`curate-all`), jobs (`find-jobs`), leads (`find-leads`) — keep
their own steps; they have different purposes and a generic pipeline was ruled out. What they share
is what surrounds the steps, in `src/mastra/pipeline-kit.ts`, and each is one `definePipeline` in
`src/mastra/pipelines.ts`:

```ts
export const LEADS = definePipeline({
  id: 'leads', workflowId: 'find-leads', scheduleId: 'leads-daily',
  runHours: leadPipeline.runHours,          // every fire past the first is a retry
  intervalHours: leadPipeline.intervalHours, // the gate decides, not the cron
  staleAfterDays: catchup.leadsStaleAfterDays,
})
```

| The kit owns | How |
| --- | --- |
| **cadence** | fires, gate and catch-up threshold in one definition, so they cannot disagree; `schedule` is derived for `createWorkflow` |
| **the claim** | `open({ force }, beforeSpending)` claims the `pipeline_cycles` row; a throw or `abandon(note)` inside the callback hands it back, and everything after `open` resolves has spent it ([ADR-0034](decisions/0034-a-pipeline-claims-its-cycle.md)) |
| **the run log** | `open` writes the `pipeline_runs` row, the pipeline finishes it with its counters ([ADR-0045](decisions/0045-one-run-log-for-every-pipeline.md)) |
| **catch-up** | `boot-catchup.ts` iterates `PIPELINES`, so a defined pipeline is caught up by being defined |

**Notices are the transport's, not the kit's** — the blueprint put `notify` in the kit; it landed on
the bot's transport, so a command's "working on it" uses it too. It resolves `false` and logs rather
than throwing. It is for notices only: a failed *delivery* must throw, so its claim is released.

The three **maintenance** workflows — prune, the weekly feed review, the weekly memory review — have
no gate, claim or catch-up, and say why on a `// C8: maintenance` line. `discover-feeds` is
reader-triggered by `/follow`. **Delivery claims stay per pipeline** (`claimForDelivery`,
`job_deliveries`, `claimLeadDelivery`): they guard different keys over different tables. C8 refuses a
claim or a schedule written outside the kit.
[ADR-0044](decisions/0044-a-pipeline-s-cadence-is-one-definition.md) · invariant 2,
[ADR-0042](decisions/0042-a-scheduled-model-call-has-a-shape-not-a-list.md)

---

## A model is asked through `structured()`

Every model call in `src/` is `structured(agent, input, schema, { attempts, … })` in
`src/mastra/agents/structured.ts` — `withRetry` around the one `agent.generate()`. `attempts` is
required, so how many times each call asks is written at the call site. It returns `null` when
every attempt failed and the caller decides what that means: a batch left unscored, a degraded
message, or — with `orThrow` — an error carrying the real cause. `reject` retries an answer that
parsed but is unusable (the writers' `leakedStructure` guard).

Agents live where their prompt lives: `src/mastra/agents/`. A model is chosen by `pnpm bench`, on the
real call path, against the incumbent — so a benched number goes through `structured()` too. The two
chat agents are driven by Mastra's channel layer, not a call in `src/`, and do not pass through it.
C5 refuses `new Agent(` outside `agents/` and `.generate(` / `.stream(` outside `structured.ts`.
[ADR-0048](decisions/0048-a-model-is-asked-through-structured-with-its-attempts-written.md) ·
[ADR-0046](decisions/0046-a-model-is-chosen-by-pnpm-bench.md)

---

## The database is read only through `src/db/`

Two libSQL databases: **data** (`AVA_DATA_DB_URL`) holds the app tables, which drizzle owns, and
Mastra's `mastra_*` tables on the same connection; **traces** is disposable
([ADR-0005](decisions/0005-two-libsql-databases-instead-of-convex.md), invariant 4). Every read and
write of the app tables is a named function in `src/db/` — the news tools call `deliveredArticles`
and `searchArticleIds`, not a query builder. **The FTS5 statement in `db/articles.ts` is the one
whole statement written as raw SQL**; the term quoting that keeps a reader's punctuation out of FTS5
syntax stays in the tool, which decides what a phrase means
([ADR-0011](decisions/0011-fts5-for-article-search.md)).

C6 refuses `drizzle-orm`, anything from `db/client` and a table from `db/schema` outside `src/db/`;
row types stay importable, and `mastra/storage.ts` may take `rawClient` to hand Mastra its store.
A schema edit means `pnpm db:generate` in the same commit.
[ADR-0049](decisions/0049-the-database-is-read-only-through-src-db.md) ·
[ADR-0006](decisions/0006-drizzle-orm-for-application-tables.md)

---

## Helpers that exist once

| Helper | Home | Note |
| --- | --- | --- |
| `hostOf` | `src/lib/url.ts` | strict — a caller holding a bare domain adds the scheme (`feed-finder`) |
| `clean`, `truncate`, `parseDate` | `src/services/posting-fields.ts` | every job source's field normalizers |
| page fetch | `src/services/page-fetch.ts` | reads no config; `feed-discovery` and the job scout wrap it with their own agent and timeout |
| retry on a malformed answer | `src/services/structured-output.ts` | `withRetry` and `leakedStructure`, used only by `structured()` |
| a path or database URL | `src/lib/project-root.ts`, `src/lib/libsql-url.ts` | never resolve against cwd (C3) |

Not copies, and kept apart on purpose: `normalizeHost` in `lead-identity.ts` (the company a host
belongs to, not the host), and each pipeline's delivery claim.

---

## What holds it

| Check | Holds | Run alone |
| --- | --- | --- |
| C1 | docs, anchors, backticked paths, `pnpm` commands and ADR `applies_to` resolve | `pnpm verify:docs` |
| C2 | no import cycle | `pnpm verify:cycles` |
| C3 | no path resolved against cwd | `pnpm verify:paths` |
| C4 | no error swallowed silently | `pnpm verify:catch` |
| C5 | agents in `agents/`, model calls through `structured()` | `pnpm verify:models` |
| C6 | the database through `src/db/` | `pnpm verify:data` |
| C7 | the code shared by every bot names no bot | `pnpm verify:bots` |
| C8 | every pipeline's cadence and claim from `definePipeline` | `pnpm verify:cadence` |

All eight run in `pnpm verify`, which the `pre-commit` hook runs. Every check is a text check over
`src/` — they read source, not an AST, for the reason in `scripts/checks/_lib.mjs` — so each can be
fooled on purpose; none has a baseline except C4's ratchet. The rules no machine holds are the 👁 and
⏳ rows of [CONVENTIONS §1](CONVENTIONS.md#1-rule-to-mechanism-map).
