---
audited_at: f6c2b89
---

# 04 — Blueprint: the target

> Written from [01](01-EXTRACTION.md), [02](02-DIVERGENCE.md) and [03](03-FLAWS.md) at `f6c2b89`.
> **Agreed on 2026-10-12** — see [Decisions](#decisions). Its durable
> parts move to `docs/ARCHITECTURE.md` and ADRs, and each slice gets a plan in `docs/plans/`.

**The goal, as set:** remove duplication. The repo has ~41 operations (7 workflows, ~19 slash
commands, 15 tools) spread over 114 files, and a third agent costs four copied files. Removing the
copies is what makes the third agent cheap. Not the goal: one generic pipeline — the three pipelines
have different purposes and keep their own steps.

---

## Part 0 — Principles

The boilerplate's five ([audit/](README.md#the-five-principles)) hold. This refactor adds one, which
is the lens for everything below:

> **P6 — A second copy is a missing definition.** When two files differ only in data — a name, a
> slug, a table — the data becomes a definition and the code is written once against it. Measured
> before and after: the overlap in [03 F3](03-FLAWS.md#-f3--a-bot-is-four-copied-files) and the file
> count are the numbers each slice reports.

And from P1, applied to the model boundary: **a rule needs a place before it needs a check.** "Model
calls only in X" is unenforceable until X exists.

---

## Part 1 — A bot is a definition (F3, F12)

**Today:** four files per bot plus three edits, and two registrars that are the same code.

**Target:** one file per bot, holding everything that is *data* about it. Everything else is built
from it by code written once.

> *As built (slices 4+5):* three places, not one file — the data file is a leaf so workflows and
> commands can import it without a cycle (C2), and the agent stays in `src/mastra/agents/` for C5.
> [ADR-0047](../decisions/0047-a-bot-is-data-and-a-command-is-one-object.md).

```ts
// src/bots/joob.ts — the whole of what makes Joob, Joob
export const JOOB: BotDefinition<'chat' | 'jobs' | 'leads'> = {
  id: 'joob',
  envPrefix: 'JOOB_',
  topics: { chat: {…}, jobs: {…}, leads: {…} },     // was config/joob-topics.ts
  profile: {…},                                      // was half of config/bot-profile.ts
  commands: [target, targets, untarget, client, …],  // Part 2
  agent: { instructions, tools, model: env.AVA_MODEL_ORCHESTRATOR },
}
```

Built from it, once, for every bot:

| Function | Replaces |
| --- | --- |
| `transportFor(bot)` — memoised `createTelegramTransport` | `services/newy-telegram.ts`, `services/joob-telegram.ts` |
| `registerBot(mastra, bot)` — slash dispatch, menu, `/start`, unknown, profile | `mastra/channels.ts` + `mastra/joob-channels.ts` (and their duplicated `welcome`, `unknown`, `commandMenu`, `commandList`) |
| `createChatAgent(bot)` — polling adapter, Chat-tab routing, memory | the shared half of `agents/newy.ts` + `agents/joob.ts` (65% overlap) |
| `BOTS` registry | `config/bots.ts`, `config/bot-profile.ts`, `config/newy-topics.ts`, `config/joob-topics.ts` |

**A third agent becomes:** one file in `src/bots/`, its commands and its workflows, and one line in
the registry. **Enforced by** a check that no identifier names a bot (`newy`, `joob`, `NEWY_`…)
outside `src/bots/` — the bot-agnostic code then cannot quietly grow a special case.

## Part 2 — A command is a definition beside its handler (F12)

**Today:** a command's text lives in `config/*-commands.ts` and its handler in
`mastra/commands/*.ts`, joined by an `is*Command` predicate and a `run*Command` switch.

**Target:** one object, in one file:

```ts
export const pause: Command = {
  name: '/pause',
  description: 'Stop a beat from ingesting, ranking and sending',
  help: 'stop a beat without losing it — nothing is deleted. `/pause design`.',
  usage: '`/pause <slug>` — for example `/pause design`.',
  run: async (ctx, args) => { … },   // ctx: the bot, its transport, mastra, the event
}
```

The registrar derives the menu, `/start`'s help and the unknown-command reply from the bot's list —
the drift `channels.ts` guards against by convention becomes impossible by construction.
`config/beat-commands.ts`, `job-commands.ts`, `lead-commands.ts` and the command halves of
`translation.ts` and `summary.ts` fold into the handlers. `commands/clients.ts` and
`commands/targets.ts` (23% overlap: `reply`, `describeChanges`, `renderCriteria`) share one
criteria-editing helper — they edit the same kind of row in two tables.

## Part 3 — A pipeline kit, not a generic pipeline (F2 → F1, F4, F5, F6)

Each pipeline keeps its own steps. What it stops doing is re-implementing what surrounds them:

```ts
export const leads = definePipeline({
  id: 'leads',
  bot: JOOB,
  fires: [9, 21],            // every fire is a retry; the gate decides
  gateHours: 44,
  staleAfterDays: 4,         // boot catch-up — registered by being defined
})

// in the first step:
const run = await leads.begin({ force })     // claims the cycle
if (!run) return []                           // refused — the kit has logged why
const profiles = await activeProfiles()
if (profiles.length === 0) return run.abandon('no client profiles — use /client')  // releases
run.spend()                                   // the point of no return: from here the cycle is used
```

| The kit owns | Fixes |
| --- | --- |
| **cadence** — fires, gate and catch-up threshold in one definition, so they cannot disagree | F1 (one fire, no catch-up); the coupling `config/catchup.ts` warns about in prose |
| **claim with an unspent window** — any throw or `abandon()` before `spend()` releases the claim | F1 (`SQLITE_BUSY`, no profiles), F4 (news) |
| **catch-up for every defined pipeline** — `boot-catchup.ts` iterates the registry | F1 (leads unknown to it) |
| **one "last run"** — `pipeline_cycles` | F6 |
| **`notify(bot, text, tab)`** — best-effort, logs, never throws | F5 — the C4 baseline drains to zero |
| **the run report** — start/finish notices from `config/run-notices.ts` | three inline copies |

**Delivery claims stay per pipeline for now** — `claimForDelivery`, `job_deliveries`,
`claimLeadDelivery` guard different keys over different tables, and merging them is a schema change
with no duplication payoff large enough to justify it. The run log is [D2](#decisions).

## Part 4 — The model boundary has a place (F7)

**`src/mastra/agents/` is the boundary, and the only one.** Every `new Agent(` and every
`.generate()` / `.stream()` is in it; everything outside calls a typed function it exports. That is
already true for 10 of 11 call sites — the move is small:

- the news ranker's inline `.generate()` in `workflows/curate-all.ts` moves into `agents/curator.ts`;
- every structured call goes through one helper — `structured(agent, prompt, schema, { attempts })`,
  `withRetry` inside — so the retry choice is a visible argument rather than a forgotten import.
  `attempts: 1` is allowed; it has to be written.

Anyone may *call* an `agents/` function — the `services/job-scout.ts` edge is legitimate under this
rule. ADR-0042 ("a scheduled model call has a shape") then has a place to point at. **Enforced by** a
check: `new Agent(`, `.generate(`, `.stream(` occur only under `src/mastra/agents/`.

> *As built (slice 6):* the boundary is the function, not the folder — `.generate(` only in
> `agents/structured.ts`, so a call inside `agents/` cannot skip `attempts` either. 17 calls, not 11;
> `/target` now asks twice like `/client`, and a job-scout parse failure is a problem on the sonar row.
> [ADR-0048](../decisions/0048-a-model-is-asked-through-structured-with-its-attempts-written.md).

## Part 5 — Data access stays in `src/db/` (F9, D2)

Every write already does. Reads join them: the queries in `tools/news.ts`, `commands/beats.ts`,
`services/lead-signals.ts` and `workflows/find-leads.ts` (with its three dynamic imports) become
repository functions. The one exception is named, not implied: the FTS5 `MATCH` in `tools/news.ts`
moves to `db/articles.ts`, which is then the only runtime raw SQL. **Enforced by** a check:
`drizzle-orm` and `db()` are imported only under `src/db/`.

## Part 6 — The small copies (F10, F11)

One `hostOf`, one `fetchPage` (in `services/page-fetch.ts`, which exists to be it), one `parseDate`.
The Mastra skill: one tracked copy ([D3](#decisions)).

---

## Part 7 — Enforcement

New rule checks, each added in the slice that makes it true:

| Check | Holds | Lands with |
| --- | --- | --- |
| C5 model boundary | `new Agent(` only in `src/mastra/agents/`; `.generate(` / `.stream(` only in `agents/structured.ts`. *Corrected when it landed:* the folder alone would have let a call inside it skip `attempts` | Part 4 |
| C6 data access | `drizzle-orm` / `db()` only in `src/db/` | Part 5 |
| C7 bot-agnostic | no bot name in the code shared by every bot — services, db, lib, config, the registrar, runner, builder and routing. *Corrected when it landed:* "outside `src/bots/`" would have forbidden a bot's own workflows and commands, which Part 1 says it brings | Part 1 |
| C8 one cadence | every scheduled `createWorkflow` gets its schedule from `definePipeline` | Part 3 |

And from 02: **D1** — number the nine invariants again in AGENTS.md so ~160 citations resolve; D2–D6
corrected in the same commit.

## Part 8 — Build order

Step 1 of the boilerplate's order (enforcement first) is done. Then, each one a slice with its own
plan, its measured before/after (files, lines, overlap), and `pnpm verify` green:

| # | Slice | Why here |
| --- | --- | --- |
| 0 | **Docs**: D1–D6 | Cheap; the plans below cite the invariants by number. |
| 1 | **Tests first** (F8): the 80 assertions into `__tests__/`; tests for the claim's release semantics and the F1 cadence arithmetic | Nothing else is safe to move without them. |
| 2 | **Pipeline kit, on leads** — F1 fixed by adopting it, not by patching | The smallest pipeline and the one with a live flaw: proves the kit. |
| 3 | **Kit on jobs, then news** (F4) — then C8; C4's baseline drains as `notify()` lands | Replicate the proven shape. |
| 4 | **Bots as definitions, Joob first** (8 files name it, against 10 for Newy) — then C7 | The core of the goal. |
| 5 | **Commands as definitions** — folds into Part 1's registrar | Depends on 4. |
| 6 | **Model boundary** — then C5 | Small once 4 has moved the agents. |
| 7 | **Data access and small copies** — then C6 | Touches files the earlier slices already opened. |

**One slice at a time, and each one finished before the next starts** — the predecessor's lesson was
twenty dialects from building breadth-first.

**What should disappear**, estimated and to be measured per slice: the two transport files, one
registrar, both topic files, `bots.ts` and `bot-profile.ts` (into the bot files), the three
`*-commands.ts` configs, `job_runs`/`lead_runs` handling folded into one log (D2), three duplicate helpers.
**What appears:** `src/bots/` (one file per bot plus the registry), the pipeline kit, and the
registrar and agent builder written once.

---

## Decisions

Asked as ❓ and answered on 2026-10-12.

| | Question | Decided |
| --- | --- | --- |
| D1 | **Layout:** consolidate within today's layer folders, or move to feature folders (`news/`, `jobs/`, `leads/`)? | **Consolidate within layers.** The file count comes down from merging copies, not from moving them; a move rewrites every `applies_to` and import for no reduction. Revisit after slice 5 if navigation still hurts. |
| D2 | **Run log:** `job_runs` and `lead_runs` — keep them, or drop them and keep only `pipeline_cycles`? | **Keep the stats**, as one `pipeline_runs` log keyed by pipeline (news gains one). No code reads them (only `job_runs.startedAt`, by the boot catch-up the kit replaces); they are read in `db:studio` when something goes wrong. The migration copies the existing rows. |
| D3 | **The Mastra skill:** is `.agents/skills/` or `.claude/skills/` the source? | **`.agents/` is the only tracked copy.** Claude Code reads project skills from `.claude/skills/` only, so `pnpm prepare` copies each skill there; the copy is gitignored. Not a symlink: git on Windows stores one as a plain file, which is how the skill came to be committed twice. Done ahead of the slices — it touches nothing they do. |
| D4 | **Slice 2's second fire for leads:** `[9, 21]`, or keep one fire and rely on catch-up? | **Two fires**, as jobs — the measured fix; spend is unchanged because the gate decides. Lands with the kit in slice 2, not as a third copy of the patch. |
