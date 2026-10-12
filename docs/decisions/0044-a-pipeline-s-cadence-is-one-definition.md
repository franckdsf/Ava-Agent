---
id: 0044
applies_to: ["src/mastra/pipeline-kit.ts", "src/mastra/pipelines.ts", "src/mastra/boot-catchup.ts", "src/config/catchup.ts", "src/config/leads.ts", "src/config/jobs.ts", "src/config/pipeline.ts", "src/mastra/workflows/curate-all.ts", "src/mastra/workflows/find-jobs.ts", "src/mastra/workflows/find-leads.ts", "scripts/checks/c8-one-cadence.mjs"]
status: accepted
supersedes: []
verify: "pnpm verify"
---

# ADR-0044: A pipeline's cadence is one definition, and its claim is handed back before it is spent

- **Status:** Accepted
- **Date:** 2026-10-12
- **Bears on:** [ADR-0025](0025-a-boot-catch-up-for-a-stale-pipeline.md) (catch-up),
  [ADR-0034](0034-a-pipeline-claims-its-cycle.md) (the claim), [ADR-0038](0038-leads-a-prospecting-pipeline-in-joobs-chat.md) (leads)

## Context

`7762cf4` fixed two failures in `find-jobs`. A single daily fire meant a run that the scheduler
replayed at boot, off its rhythm, was refused at the next day's only fire. A claim written before
any work also spent the cycle even when the run died on its first statement (`SQLITE_BUSY`,
2026-08-23). `find-leads` had the same shape and got neither fix. The boot catch-up did not know
leads existed. In leads that cost a day after any off-rhythm run (66h, not 54h), and a full 44h
cycle for a run with no client profiles
([audit F1](../audit/03-FLAWS.md#-f1--leads-did-not-get-the-jobs-fix)).

The cause was not the leads code. Each pipeline mechanic had been solved once and copied by hand,
or not copied at all ([F2](../audit/03-FLAWS.md#-f2--pipeline-mechanics-are-written-three-times)).
A third copy of the patch would have waited for the next fix to miss one of the three.

## Decision

**A pipeline is declared with `definePipeline`** (`src/mastra/pipeline-kit.ts`). Its fire hours,
its gate, its catch-up bar, its workflow id and its schedule id live in one object. The workflow
takes its id and its schedule from that object, and the boot catch-up builds its target from it.
Defining a pipeline in `src/mastra/pipelines.ts` is what registers it for catch-up.

**The three cadence numbers are checked against each other at load.** The longest healthy wait
between runs is the gate, plus the widest gap between fires, plus an hour for DST. A catch-up bar
at or under that ceiling would let a boot spend a cycle that the next fire was about to start, so
`definePipeline` throws (P4). Until now this rule lived in a comment in `config/catchup.ts` and in
one test that covered jobs only.

**The window before spending is a callback.** `open({ force }, beforeSpending)` claims the cycle.
If the callback throws, or calls `abandon(note)`, the claim is released. Once the callback returns,
the cycle is spent. The callback holds only what spends nothing: no source is fetched and no model
is called. The audit blueprint sketched `begin()` / `spend()` instead, but nothing can catch a throw
between those two calls, and that is exactly where `SQLITE_BUSY` struck.

**A kit pipeline's "last run" is its `pipeline_cycles` row**, the same row its gate reads
([F6](../audit/03-FLAWS.md#-f6--three-answers-to-when-did-it-last-run)). A released claim restores
the previous stamp, so a run that stopped before spending anything does not count as a run.

Leads is the first pipeline on the kit: fires at 09:00 and 21:00, a 44h gate, and a 3-day bar
against a 57h ceiling.

## Cost

- **Two shapes coexist until slice 3.** News and jobs still claim by hand and are listed in
  `CATCHUP_TARGETS` by hand. Jobs reads its catch-up from `job_runs`. Until they move, anyone
  reading the code has two ways to learn.
- **One more nesting level** in each pipeline's first step, because the window is a callback.
- **The run log is untouched.** `lead_runs` is still written inside the window
  (`startLeadRun()`). The single `pipeline_runs` log of
  [audit D2](../audit/04-BLUEPRINT.md#decisions) waits for slice 3, so that it is designed from all
  three pipelines' columns and not from leads alone.
- **The DST hour is a judgement.** It makes the ceiling conservative by an hour. A bar sitting
  exactly on the unpadded ceiling is refused, even though it would only collide twice a year.

## Verify

`pnpm verify` runs `src/mastra/__tests__/pipeline-kit.test.ts` (the window and the cadence guard),
`src/db/__tests__/cadence.test.ts` (leads off-rhythm ≤ gate + 12h) and the kit cases in
`src/mastra/__tests__/boot-catchup.test.ts`. `pnpm catchup:check` shows what a boot would do now,
for every pipeline including leads.
