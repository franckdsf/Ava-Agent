---
slice: kit-on-jobs-and-news
branch: main, one commit per step, as slices 1–2
status: active
---

> **Intent before implementation.** This file describes what we agreed to build, not what exists.
> If it disagrees with the repo, **the repo is right and this file should already be gone** —
> see [README.md](./README.md).

# Slice 3 — jobs and news on the kit, one run log, `notify()`, C8

After this lands, all three pipelines claim, release, schedule and catch up through one
`definePipeline`. A failed Telegram notice leaves a log line. No pipeline can be scheduled outside the kit
without a check failing.

---

## 1. Problem

**What is broken or missing.**

- **News spends its cycle on an early failure** ([F4](../audit/03-FLAWS.md#-f4--a-news-claim-is-not-released-on-an-early-failure)).
  A locked database in `feedsForBeats()` costs a digest.
- **Eight pipeline notices fail silently** ([F5](../audit/03-FLAWS.md#-f5--fifteen-silent-failures)).
  One of them is the only signal the reader gets that a run was skipped.
- **"When did it last run" has three answers** ([F6](../audit/03-FLAWS.md#-f6--three-answers-to-when-did-it-last-run)):
  `feed_state` for news, `job_runs` for jobs, and `pipeline_cycles` for leads.
- **Jobs keeps its catch-up bar in prose.** Its coupling to the gate is held by one test, which has
  to be kept in step with the gate by hand.
- **Jobs and news still claim by hand**, so the next fix to the claim can again miss a pipeline,
  which is how F1 happened.

**How we would know it worked.**

| Observable | Script |
| --- | --- |
| `claimCycle` is imported by `pipeline-kit.ts` and nothing else in `src/` | C8, in `pnpm verify` |
| C4 baseline: `curate-all.ts`, `find-jobs.ts`, `find-leads.ts` and `clients.ts` go to **0**, and `targets.ts` goes from 2 to 1 (13 → 2 in `src/`) | `pnpm verify:catch` |
| A throw in `feedsForBeats()` leaves the `news` cycle where it was | a kit test, in `pnpm verify` |
| `catchup:check` lists news, jobs and leads, each read from `pipeline_cycles` | `pnpm catchup:check` |
| `job_runs` and `lead_runs` row counts equal the `pipeline_runs` rows for that pipeline after migrating a copy of the live `ava.db` | one-off, read by hand |
| The schedule store holds **one** `curate-all` row after a boot, not two | the Mastra-sweep test, step 4 |

**Which invariant this sits closest to.** 6 (single replica): the claim is what keeps two
overlapping runs apart, and this moves it for the two pipelines that collided on 2026-08-16. Also 4: the
migration copies data, so part of it is hand-written SQL.

---

## 2. Architecture

**Schema.** One app table replaces two (D2). Drizzle owns it.

```
pipeline_runs   id · pipeline · started_at · finished_at · fetched · stored · considered
                · scored · delivered · note · detail (json, nullable)
                index (pipeline, started_at) — "this pipeline's runs, newest first", the db:studio question
job_runs        dropped, rows copied in with pipeline = 'jobs'
lead_runs       dropped, rows copied in with pipeline = 'leads', vision_calls → detail
```

The five shared counters are the ones jobs and leads both have. News maps onto them as
`feedsFetched → fetched`, `discovered → stored`, `scored`, `sent → delivered`; `considered` stays 0.
`detail` holds what only one pipeline has: `visionCalls` for leads, `linked` for news.

**Workflows.** No new surface. Three scheduled workflows change where their claim and schedule come
from:

```
src/mastra/workflows/find-jobs.ts    scheduled  08:00, 20:00   JOBS.open · JOBS.schedule ('jobs-daily', unchanged)
src/mastra/workflows/curate-all.ts   scheduled  10:00, 20:00   NEWS.open · NEWS.schedule (two rows → one, see Flow)
src/mastra/workflows/find-leads.ts   scheduled  09:00, 21:00   already on the kit; moves to the run log
```

**Telegram surface.** No change to what arrives or where. `notify` sends the same text to the same tab. The only
difference is a log line when the send fails.

**Flow — the news schedule rows.** Today `curate-all` declares `digest-1000` and `digest-2000`. The kit
renders one row per pipeline with one cron (`0 10,20 * * *`). In 1.52.1, Mastra's declarative sync
deletes any `wf_<workflow>__*` row the workflow no longer declares (`chunk-TELMC4PK.js`, the
"orphaned declarative schedule" loop). So the two rows become one at the first boot, with no
migration. That also fixes a side effect: a boot replays one missed fire per row. On 2026-08-16 that put two
digest runs 146 ms apart ([ADR-0033](../decisions/0033-a-delivery-is-claimed-before-it-is-sent.md)). With one row there
is one replay.

This contradicts the kit's own warning ("a stranded row is still active"), which predates the sweep.
The warning gets corrected in the same step.

**State a scheduled call may write.** None changes. No model call moves. The window before spending holds
database reads only: searches, beats, feeds, profiles, and the run row's insert.

---

## 3. Program design

**Files created or changed:**

```
src/db/schema.ts                     pipelineRuns; jobRuns, leadRuns removed
drizzle/0027_<generated>.sql         create pipeline_runs                         — pnpm db:generate
drizzle/0028_<custom>.sql            INSERT … SELECT from both, header says why   — drizzle-kit generate --custom
drizzle/0029_<generated>.sql         drop job_runs, lead_runs                     — pnpm db:generate
src/db/runs.ts                       startRun · finishRun (new; jobs.ts and leads.ts lose theirs)
src/db/jobs.ts                       − lastRunStartedAt, startJobRun, finishJobRun
src/db/leads.ts                      − startLeadRun, finishLeadRun
src/mastra/pipeline-kit.ts           open() inserts the run row inside the window and returns its id
src/mastra/pipelines.ts              + JOBS, NEWS; PIPELINES = [NEWS, JOBS, LEADS]
src/mastra/boot-catchup.ts           CATCHUP_TARGETS = PIPELINES.map(catchupTarget); hand entries gone
src/services/telegram.ts             + notify on the transport
src/config/catchup.ts                jobs comment: "nothing enforcing it" → definePipeline does
src/config/pipeline.ts               newsMinRunGapMs() → NEWS.intervalHours, derived from digestHours
scripts/checks/c8-one-cadence.mjs    new; wired into verify:rules
scripts/checks/c4-baseline.json      four entries go, targets.ts 2 → 1
src/mastra/__tests__/boot-catchup.test.ts   the jobs ceiling case goes; kit cases run over PIPELINES
docs/decisions/0045-…md              one run log, written by the kit — landed with step 1; 0034 and 0025 partly superseded
```

**Signatures:**

```ts
// src/db/runs.ts
type RunCounters = { fetched?: number; stored?: number; considered?: number; scored?: number;
                     delivered?: number; note?: string | null; detail?: Record<string, number> }
startRun(pipeline: string): Promise<string>
finishRun(id: string, counters: RunCounters): Promise<void>

// src/mastra/pipeline-kit.ts — Opened gains the run id; the callback no longer starts the run
type Opened<T> = { ok: true; value: T; runId: string } | { ok: false; note: string }
open<T>(options: { force?: boolean },
        beforeSpending: (w: { abandon(note: string): Abandoned }) => Promise<T | Abandoned>): Promise<Opened<T>>
//   order inside: claim → beforeSpending → startRun(def.id) → resolve. A throw from either releases.

// src/services/telegram.ts — on TelegramTransport<Slug>
notify(text: string, target: SendTarget<Slug>): Promise<boolean>   // never throws; false + console.error on failure

// src/mastra/pipelines.ts
export const NEWS = definePipeline({ id: 'news', workflowId: 'curate-all', scheduleId: 'digest',
  runHours: pipeline.digestHours, intervalHours: minDigestGapHours() / 2, staleAfterDays: catchup.newsStaleAfterDays })
export const JOBS = definePipeline({ id: 'jobs', workflowId: 'find-jobs', scheduleId: 'jobs-daily',
  runHours: jobPipeline.runHours, intervalHours: jobPipeline.intervalHours, staleAfterDays: catchup.jobsStaleAfterDays })
```

The run row is written by the kit because a run always starts the same way, and today that start is
copied three times. Putting it inside the window keeps the 2026-08-23 case covered: when `startRun`
loses the lock, the claim is released.

**What each window holds:**

| Pipeline | Inside `open` (spends nothing) | `abandon` when |
| --- | --- | --- |
| jobs | `activeSearches()` | no active searches |
| news | `activeBeats()`, `feedsForBeats()`, dedupe | no beats, or no feeds between them |
| leads | `activeProfiles()` | no active profiles (unchanged) |

News has one behaviour change. Today a run with beats but no live feeds keeps its claim and reports nothing.
After this, it hands the claim back. That matches the other two pipelines and costs nothing, because a run with no feeds fetched nothing.

**Tunables.** None new. `NEWS.intervalHours` is `newsMinRunGapMs()`'s existing derivation, moved.

Cadence check at load, worked out in advance:

| Pipeline | Gate | Widest gap | Ceiling | Bar |
| --- | --- | --- | --- | --- |
| news | 5h | 14h | 20h | 168h |
| jobs | 20h | 12h | 33h | 72h |
| leads | 44h | 12h | 57h | 72h |

**C8 — what it can actually hold.** As worded, "every scheduled workflow takes its schedule from
`definePipeline`", it would fail on three workflows that are not pipelines: `prune-articles` (daily), `review-feeds` and
`review-memories` (both weekly). They have no gate, no claim and no catch-up, and the kit's `runHours` cannot express a weekday. So C8
holds two things:

1. `claimCycle` is imported only by `src/mastra/pipeline-kit.ts`. Tests are exempt. This is the half that would
   have caught F1 and F4.
2. A `schedule:` in `createWorkflow` is `<NAME>.schedule`, unless a `// C8: maintenance — <why>`
   comment sits directly above it. A new pipeline then has to choose one of the two in writing, and the three
   exempt workflows are named where they are declared.

**`notify` reaches beyond the workflows, deliberately.** The send swallows in `commands/clients.ts`
(2) and `commands/targets.ts` (1) are the same shape, and changing them is one line each. They stay on the
C4 baseline otherwise until slice 5. Left alone: `saveSuggestion(...).catch`, `ensureBeatTopic` in
`telegram.ts`, and the two scripts. None of them is a notice.

**Checks:**

```
pipeline-kit.test.ts    the run row is written inside the window; a startRun throw releases;
                        abandon writes no run row; runId is returned
runs.test.ts            (real SQLite) the copy migration carries job_runs and lead_runs rows,
                        vision_calls lands in detail
boot-catchup.test.ts    kit cases run over PIPELINES, so news and jobs gain the leads cases;
                        "jobs at the top of its healthy range" deleted (definePipeline holds it)
telegram.test.ts        notify on a rejecting send resolves false and logs
schedule-sweep.test.ts  a Mastra with two declared rows, then one → one row left (no bots constructed)
c8 fixtures             a claimCycle import outside the kit fails; an undeclared schedule fails;
                        the maintenance comment passes
pnpm verify · pnpm catchup:check
```

**Decisions I am least confident about.**

1. **Deleting a test assertion.** You named this one, and AGENTS.md says an existing assertion never changes
   without your approval, so this is the place to approve it. The case being deleted checks
   `interval + 24`, a single-fire formula that is already wrong for two fires (the real ceiling is 33h). The
   kit's 33h check takes over that guard.
2. **`detail` as JSON, not a `vision_calls` column.** One counter that only one pipeline has does not
   justify a column every row carries. The cost: `db:studio` shows it as a string.
3. **The schedule sweep is read from source, not observed.** If the step-4 test shows Mastra keeping the
   old rows, the fallback is to keep `digest-1000` and `digest-2000` by letting the kit take one
   schedule id per fire hour. That is a small change to the kit, and it keeps the double replay.

**Out of scope, stated so it is not mistaken for forgotten:** the start/finish run report (the
blueprint's other kit row) stays as three inline renderers. It is the same shape as today, and nothing in this
slice needs it.

---

## 4. Slices

One commit each, `pnpm verify` green at every one:

```
1. pipeline_runs + the three migrations + db/runs.ts; the kit writes the run row; leads moves onto it
     → a forced leads run (workflow:run, after your go) writes one pipeline_runs row
2. notify() + the 11 swallows; C4 baseline entries removed
3. JOBS on the kit; jobs hand entry and lastRunStartedAt gone; the ceiling test deleted
     → catchup:check shows jobs from pipeline_cycles
4. NEWS on the kit, one schedule row; the sweep test; the stranded-row comments corrected
     → catchup:check shows news from pipeline_cycles
5. C8 + its fixtures; AGENTS.md "Current state" and ADR-0044's applies_to updated;
   this file deleted
```

Step 1 runs the copy migration against a **copy** of the live `ava.db` before the commit, to check that the row
counts match.

---

## Landing

- [ ] `pnpm verify` green
- [ ] `pnpm catchup:check` run and its output read
- [ ] `pnpm db:generate` run for both schema moves, the custom migration's header written
- [ ] `invariant-reviewer` spawned and clean, or its findings approved
- [ ] ADR-0045 written (step 1); the GOTCHAS line on stranded schedule rows corrected
- [ ] **This file deleted**
