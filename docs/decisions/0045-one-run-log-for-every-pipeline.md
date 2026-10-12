---
id: 0045
applies_to: ["src/db/runs.ts", "src/db/schema.ts", "src/mastra/pipeline-kit.ts", "drizzle/0028_copy_run_logs.sql"]
status: accepted
supersedes: ["0034", "0025"]
verify: "pnpm verify"
---

# ADR-0045: One run log for every pipeline, written by the kit

- **Status:** Accepted
- **Date:** 2026-10-12
- **Partly supersedes:** [ADR-0034](0034-a-pipeline-claims-its-cycle.md) ("`job_runs` stays the
  log"), [ADR-0025](0025-a-boot-catch-up-for-a-stale-pipeline.md) (jobs staleness read from
  `job_runs.startedAt`)
- **Bears on:** [ADR-0044](0044-a-pipeline-s-cadence-is-one-definition.md), whose "the run log is
  untouched" cost this pays

## Context

Each pipeline kept its own log. `job_runs` and `lead_runs` had the same five counters, a finish
time and a note, and they had two writers: `startJobRun` and `startLeadRun`. News kept no log at all,
so "was last Tuesday quiet or broken?" had no answer for it. No code reads these rows. The only reader was
`lastRunStartedAt()`, which fed the jobs boot catch-up, and audit F6 already moved that question to
`pipeline_cycles`. The logs are read in `db:studio` when something goes wrong.

[Audit D2](../audit/04-BLUEPRINT.md#decisions) chose to keep the stats as one log keyed by
pipeline, rather than drop them and keep only `pipeline_cycles`.

## Decision

**`pipeline_runs` is the log for every pipeline**: one row per run, keyed by the `pipeline_cycles`
id. It has the five counters every pipeline has (`fetched`, `stored`, `considered`, `scored`,
`delivered`), plus `note` and `detail`.

**What only one pipeline counts goes in `detail`**, a JSON object, not a column the others would
carry empty: leads' `visionCalls`, and news' `linked`. Chosen by the reader over a column per counter.

**The kit writes the row.** `open()` inserts it after the window's callback succeeds, still inside
the guard that releases the claim. It returns the id as `runId`, and the pipeline only ever finishes that row.
Starting a run was copied in every pipeline. It is also where a run lost the write lock on 2026-08-23.
Written by the kit, that failure hands the cycle back for every pipeline at once.

**The existing rows are kept.** `0028_copy_run_logs.sql` copies both tables before `0029` drops
them, with `vision_calls` moved into `detail`. On the reader's local database, 32 `job_runs` rows became 32
`pipeline_runs` rows.

## Cost

- **`detail` is text in `db:studio`.** It can't be sorted or summed like a column without
  `json_extract`.
- **Jobs writes the log before it is on the kit.** Until slice 3 moves it, `find-jobs` calls
  `startRun('jobs')` by hand inside its own window, a fourth copy of the shape for one step.
- **A hand-written migration.** Drizzle can't express a data copy (invariant 4's exception). Its
  test migrates a scratch database to just before it, so a wrong column order fails `pnpm verify`.

## Verify

`pnpm verify` runs `src/db/__tests__/runs.test.ts` (the copy carries every row, `vision_calls` into
`detail`, and the old tables are gone) and the run-log cases in
`src/mastra/__tests__/pipeline-kit.test.ts`. Those cases check that the row is written, that an
abandoned or throwing run writes none, and that the row losing the lock releases the claim.
