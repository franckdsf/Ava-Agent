---
id: 0025
applies_to: ["src/mastra/boot-catchup.ts", "src/config/catchup.ts"]
status: partly-superseded
supersedes: []
verify: "pnpm catchup:check"
---

# ADR-0025: A boot fires a pipeline that has stopped running, on its own cadence

- **Status:** Partly superseded by [ADR-0045](0045-one-run-log-for-every-pipeline.md) — the run log.
- **Date:** 2026-08-04

## Context

Schedules are persisted rows ([ADR-0004](0004-native-mastra-schedules-over-a-job-queue.md)),
which is what makes them survive a restart — and is also the whole problem. A
schedule row knows its cron, its timezone and its `nextFireAt`. Nothing anywhere
reads the *gap*.

So a machine that was off for a fortnight comes back and behaves exactly like one
that was off for ten minutes: it computes the next fire and waits for it. The
reader turns the container back on in the evening and hears nothing until 08:00
the following morning; the job run, on a daily fire gated to every two days, can
be a further two days behind that. The pipeline is not broken and every counter
says so, which is precisely why nobody notices for a week.

Three ways not to fix it, and why:

- **Fire everything on every boot.** A restart to change a log level would then
  cost a curation run, and a crash loop would cost one per crash. Reasonable
  while a container restarts twice a month; wrong the first time it restarts
  twice an hour.
- **Fire the missed occurrences.** Cron catch-up semantics — seven backlogged
  digests after a week off. Mastra deliberately does not do this on resume, and
  it is the wrong answer here for the same reason: the reader wants *today's*
  news, not six mornings of it in one burst.
- **Let the reader ask.** A `/refresh` command. That is a real feature and a
  worse answer to this question: it requires the reader to have noticed, and
  "notice the machine has been quiet for a week" is the thing being fixed.

The job pipeline already has half of this reasoning in it. Its schedule fires
daily and a stored `job_runs.startedAt` gates it to every two days, because "a
missed schedule firing on boot, with two runs then in flight at once" had already
happened once. The cadence being a property of the *data* rather than of the cron
string is what makes a boot able to reason about it at all.

## Decision

**On boot, a pipeline that has gone quiet for longer than its own cadence allows
is fired immediately — unless its next scheduled fire is within thirty minutes,
in which case it is left to the scheduler.**

**The bar is per pipeline, because the cadences are an order apart.** Seven days
for news, which fires three times a day, so the bar is twenty missed fires. Three
days for jobs, which fires daily and gates itself to every other one, so the same
seven days would be three missed cycles — a fortnight of a reader seeing nothing
while the pipeline looked merely late. One number for both was the first draft
and was wrong in the direction that hurts: it made the *slower* pipeline, the one
whose silence is hardest to notice, the one that waited longest for help.

The numbers live in `src/config/catchup.ts`. The mechanism, in
`src/mastra/boot-catchup.ts`:

- **Staleness comes from the pipelines' own tables**, not from a marker this
  feature writes: `feed_state.lastFetchedAt` for news, `job_runs.startedAt` for
  jobs. Both are written by the runs themselves, so a catch-up that starts and
  then crashes still counts as having spent the cycle.
- **It fires the schedule, not the workflow.** `mastra.schedules.run(id)` starts
  what the cron would have started, from the `inputData` and `initialState` the
  declaration persisted, records a trigger row visible in Studio beside the cron
  fires, and does not move the cadence.
- **A paused schedule is never woken**, and a workflow with no active schedule
  is left alone.
- **It waits for the orchestration worker first.** The scheduler publishes
  `workflow.start`; a different worker consumes it, and both come up shortly
  *after* this module is evaluated.

**Three days for jobs, and not two, because the bar has to clear that pipeline's
own healthy range.** A daily fire gated at `jobPipeline.intervalHours` (44h) runs
every *other* fire: 48 hours apart on the usual rhythm, and up to
`intervalHours + 24` — 68 hours — after a run that started off the 08:00 rhythm,
which is precisely what a catch-up run itself produces. Two days (48h) falls
inside that, so a restart on an ordinary Tuesday would fire a run the next 08:00
would have started anyway, and that run's scoring call is this system's single
most expensive request. Seventy-two hours sits above the ceiling with four hours
to spare, which is the difference between "a cycle was genuinely missed" and "the
next run is due". Two was the first number chosen here and it was the wrong side
of that line; the cost of the correction is a jobs digest that can wait up to a
day longer after an outage. Seven days for news needs no such argument — nothing
healthy comes close to it.

This does not weaken [invariant 2](../../AGENTS.md#invariants). A catch-up fire
is the scheduled run, early: the same fixed control flow, the same classifiers
over a fixed row set. Nor does it touch
[invariant 8](../../AGENTS.md#invariants) — no conversation is involved, and
"nothing conversational may start `curateAll`" is unchanged. The new category is
narrow and worth naming: **the process itself may start a run, and only to
recover a schedule it can prove was missed.**

## Consequences

**Good:** a container that comes back after a long absence proves it within a
minute instead of at breakfast. The reader's first signal is a digest, not a
silence indistinguishable from a broken bot. A fresh volume — no `feed_state`, no
`job_runs` — reads as "never run" and is caught by the same path, so a
first-ever boot no longer waits for its first cron. And a decision that used to
be nowhere is now a pure function with `pnpm catchup:check` over it.

**Costs:**

- **A boot can spend money.** Restarting while news is a week stale costs a
  ranking pass and a handful of writer calls; restarting three days after the
  last jobs run costs a scoring call, this system's single most expensive
  request — one call, ~34k tokens, minutes long. That is the feature, but
  `docker compose up` is no longer free at every moment.
- **A crash loop can fire repeatedly.** What bounds it is that each run stamps
  its own staleness marker in the first seconds — ingest writes `feed_state`,
  `startJobRun()` writes `job_runs.startedAt` — so the *next* boot stands down. A
  restart inside that window starts a second run, and two runs delivering at once
  is the failure mode this repo has already had. Invariant 6 (single replica)
  already assumes nothing is racing the pipeline; this leans on that assumption
  slightly harder.
- **The staleness signal for news is indirect.** `feed_state.lastFetchedAt` means
  "ingest ran", not "a digest was delivered". A pipeline that ingests nightly and
  has delivered nothing for a month reads as fresh. That is the right reading for
  *this* decision — the schedule is running, and empty digests are a ranking
  question — but it is not the question a reader would ask.
- **Two knobs to keep in step with two cadences, and one of them is load-bearing
  arithmetic.** The jobs bar clears its pipeline's healthy ceiling by four hours;
  raising `jobPipeline.intervalHours` past 48 pushes that ceiling back through 72
  and turns ordinary restarts into scoring calls, with no error anywhere.
  `pnpm catchup:check` carries the case that fails when it happens — verified by
  raising the gate to 50 and watching it go red — which is the only thing
  enforcing a relationship the type system cannot see.

**Revisit if:** the container starts restarting often enough that a boot fire is
routine rather than exceptional (then the guard belongs in the workflows, as the
job pipeline's own gate already is); or if a second reader-facing "run it now"
path appears, at which point the two should share one entry point rather than
each having their own idea of what a run costs.
