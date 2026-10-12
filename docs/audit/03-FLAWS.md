---
audited_at: f6c2b89
---

# 03 — Flaws: defects, evidence, and fixes

> Frozen at `f6c2b89`. Each flaw carries its evidence, the mechanism that produced it, and a fix
> written to be lifted into the blueprint. Candidates checked and downgraded are kept, with why.

**Severity** — 🔴 **Critical**: loses or corrupts data, or sends what it must not · 🟠 **High**: fails
under realistic conditions · 🟡 **Medium**: degrades correctness or maintainability · 🔵 **Low**:
hygiene.

| # | Flaw | Severity |
| --- | --- | --- |
| F1 | The leads pipeline lacks both fixes the jobs pipeline got for the same failure | 🟠 |
| F2 | Pipeline mechanics are copied per pipeline, so a fix lands in one copy | 🟠 |
| F3 | Each bot is a parallel set of files that differ only in data | 🟡 |
| F4 | A news claim is not released when the run fails before fetching | 🟡 |
| F5 | Fifteen failures are swallowed without a log line | 🟡 |
| F6 | "When did this pipeline last run" has three sources | 🟡 |
| F7 | The model boundary has no single place | 🟡 |
| F8 | 80 offline assertions run only when someone remembers the script | 🟡 |
| F9 | Reads outside the repository layer | 🔵 |
| F10 | Helpers defined two and three times | 🔵 |
| F11 | The Mastra skill is tracked twice | 🔵 |
| F12 | `src/config/` holds five kinds of thing under one name | 🔵 |
| — | Portfolio variables read outside the env schema | downgraded |

**F2 and F3 are the root; most of the rest are instances.** F1 is F2 having happened.

---

## 🟠 F1 — Leads did not get the jobs fix

`7762cf4` fixed two failures in `find-jobs`. `find-leads` has the same shape and neither fix:

| | jobs | leads |
| --- | --- | --- |
| fires | `runHours: [8, 20]` — a refused fire has a second chance | `runHour: 9` — one fire a day |
| gate | 20h | 44h |
| claim released when nothing was spent | yes — no searches, or `startJobRun()` throws (`find-jobs.ts:212-219`) | **no** (`find-leads.ts:127-151`) |
| boot catch-up | yes, 3 days | **none** — `boot-catchup.ts` does not know leads exists |

**What it costs, worked from the code:**

- **An off-rhythm run pushes the next one back a day.** The scheduler replays a missed fire at boot,
  at whatever hour the container came up (the mechanism `7762cf4` measured). A run at 15:00 is
  refused at 09:00 the next day (18h) and the day after (42h < 44h); the next run is 66h later, not
  48h. Any run after 11:00 costs a day.
- **A run with no client profiles spends the cycle.** The claim is written, `activeProfiles()` is
  empty, the step returns — and the 44h are gone. A reader who types `/client` right after waits up to
  two days for the first result.
- **The 2026-08-23 failure is still live here.** That day `startJobRun()` lost the write lock with
  `SQLITE_BUSY` and a run that did nothing spent its cycle. `startLeadRun()` sits in the same place,
  after the claim, unreleased.

**Fix:** not a third copy of the patch — F2.

## 🟠 F2 — Pipeline mechanics are written three times

All three pipelines are *claim → score per unit → assign → deliver per unit → report*
([01 §5](01-EXTRACTION.md#5-the-pipelines)), written out in 805, 987 and 667 lines. Their purposes
differ and should stay separate. What is copied is the **mechanics around** the purpose:

| Mechanic | news | jobs | leads |
| --- | --- | --- | --- |
| schedule + gate | `digestHours` + `newsMinRunGapMs()` | `runHours` + `intervalHours` | `runHour` + `intervalHours` |
| claim release before spending | no (F4) | yes | no (F1) |
| run log | none | `job_runs` | `lead_runs` |
| boot catch-up | yes | yes | no |
| delivery claim | `claimForDelivery` / `releaseDelivery` | `job_deliveries` | `claimLeadDelivery` / `releaseLeadDelivery` |
| start/finish notices | `runNotices.news` | inline | inline |

Each row was solved once and copied by hand, or not copied at all. **That is F1's mechanism:** the
fix was correct and landed in one of three copies. **Fix:** a pipeline *kit*, not a generic pipeline
— one definition of the cadence (fires + gate + catch-up), one claim that releases itself on an early
exit, one run log, one delivery claim, one best-effort notice. Each pipeline keeps its own steps.

## 🟡 F3 — A bot is four copied files

Per bot: `agents/<bot>.ts`, `mastra/<bot>-channels.ts`, `services/<bot>-telegram.ts`,
`config/<bot>-topics.ts`, plus entries in `bots.ts`, `bot-profile.ts` and `index.ts`. Measured overlap
after normalising names: agents **65%**, registrars **53%**; `welcome`, `unknown`, `commandMenu` and
`commandList` are each defined twice. The transport files are one line of code each
(`createTelegramTransport(BOT)`) and differ only in their comments; the topic files differ only in
slugs, emoji and titles.

`BotDefinition` in `config/bots.ts` is already the right idea — id, env prefix, topics, profile — but
it stops at data. Transport, registrar and agent are still written per bot instead of built from it.
**Cost:** a third agent is four new files and three edits, and a fix to one registrar does not reach
the other. **Fix:** a bot is one definition — its data, its commands and its agent's instructions —
and one set of functions builds everything else from it.

## 🟡 F4 — A news claim is not released on an early failure

`curate-all.ts:161` claims the cycle, then `feedsForBeats()` runs with no `try`/release. A throw there
— a locked database, as on 2026-08-23 — spends the gap before anything was fetched, so that digest
does not happen. Smaller than F1 because the gap is hours, not days; same cause.

## 🟡 F5 — Fifteen silent failures

`.catch(() => {})` 15 times in 8 files (baselined by C4). Mostly best-effort Telegram notices, where
not failing the run is right; but a notice that never arrived leaves no trace, and one of them is the
"I couldn't read your portfolio" message (`find-leads.ts`) — the only signal a reader gets that a run
was skipped. **Fix:** one `notify()` that logs and never throws; the kit's best-effort send.

## 🟡 F6 — Three answers to "when did it last run"

The gate reads `pipeline_cycles` (ADR-0034). Boot catch-up reads `job_runs` for jobs and
`feed_state.lastFetchedAt` for news. `job_runs` and `lead_runs` are also a run log, written just after a
successful claim; news keeps none. They agree in practice because the run log is written right after
the claim — until a run dies between the two (F1). **Fix:** `pipeline_cycles` is the one answer; a run
log, if kept, is one table keyed by pipeline.

## 🟡 F7 — The model boundary has no place

`mastra/agents/` holds both the 19 `Agent` definitions and the functions that call them
(`summarizeSource`, `translateChunk`, `parseTarget`, `proposeCompanies`…). `services/job-scout.ts`
imports one upward. `workflows/curate-all.ts` calls `.generate()` inline. `withRetry` is used in 5 of
the 11 model-calling files — right for the batch scorers, but there is no shared shape that makes the
choice visible. ADR-0042 ("a scheduled model call has a shape") has nothing to point at. **Fix:** name
the place; then C-check that `new Agent(` and `.generate(` occur nowhere else.

## 🟡 F8 — Unit tests in disguise

`check-leads.ts` (49 assertions), `check-catchup.ts` (18), `check-feed-review.ts` (13) — hand-rolled
`check()` harnesses with no network, no model, no `.env`. Exactly what vitest is for, and they run
only when someone remembers the script. They are also the safety net the refactor needs: the catch-up
decision table, the lead filters and the feed review are logic the kit and the bot definitions will
move. **Fix:** move them into `__tests__/` first, before anything they cover is touched.

## 🔵 F9 — Reads outside `src/db/`

`db()` is queried directly in `tools/news.ts` (7×), `commands/beats.ts`, `services/lead-signals.ts`
and `workflows/find-leads.ts` — the last through three dynamic `import()`s for no reason the code
states. Every write stays in `db/`, so nothing is corrupted; but a column rename has four more places
to break. `tools/news.ts`'s FTS5 query is the legitimate exception (D2).

## 🔵 F10 — Helpers twice and three times

`hostOf` in `feed-discovery`, `feed-finder`, `feed-timeliness`; `fetchPage` in `feed-discovery`,
`job-scout`, `page-fetch` (which exists to be the one); `parseDate` in `ats`, `job-fetch`.

## 🔵 F11 — The Mastra skill, tracked twice

`.agents/skills/mastra/` and `.claude/skills/mastra/` — 20 tracked files, identical today, both added
in the first commit. Two copies drift the day one is updated. Possibly deliberate (one per agent
tool); if so it wants one copy and a link, or a line saying which is the source.

## 🔵 F12 — `src/config/`, five kinds of thing

Tunables, vocabularies, command definitions, seeds, and bot identity — 30 files
([01 §9](01-EXTRACTION.md#9-configuration)). A command is defined in `config/*-commands.ts` and
handled in `mastra/commands/*.ts`, so one command is always two files. Part of F3's shape.

## Downgraded — portfolio variables outside the schema

`services/portfolio.ts` reads `PORTFOLIO_FEED_URL` / `PORTFOLIO_FEED_TOKEN` from `process.env`
directly. Downgraded: both are optional, documented in `.env.example`, and an unset URL throws a named
`PortfolioError` at the point of use, which the pipelines report to the reader. The only loss is that
a malformed URL is caught at the first run rather than at boot.

---

## Priority for the refactor

1. **F8** — the tests first. Nothing else is safe to move without them.
2. **F2 → F1, F4, F5, F6** — the pipeline kit. One change, and four flaws stop being possible.
3. **F3 + F12** — bots and commands as definitions. Where the file count comes down.
4. **F7** — the model boundary, then its check.
5. **F9–F11** — as the files they live in are touched.
