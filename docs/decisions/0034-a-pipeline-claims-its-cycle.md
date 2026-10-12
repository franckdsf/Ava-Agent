---
id: 0034
applies_to: ["src/db/cycles.ts", "src/mastra/workflows/curate-all.ts", "src/mastra/workflows/find-jobs.ts", "src/mastra/pipeline-kit.ts"]
status: partly-superseded
supersedes: []
verify: "pnpm catchup:check"
---

# ADR-0034: A pipeline claims its cycle in one write, rather than checking and then starting

- **Status:** Partly superseded by [ADR-0045](0045-one-run-log-for-every-pipeline.md) — the run log.
- **Date:** 2026-08-17

## Context

[ADR-0033](0033-a-delivery-is-claimed-before-it-is-sent.md) stopped two
overlapping `curate-all` runs delivering the same story twice, by claiming each
story before sending it. It did nothing about the second run *existing*: it still
fetched every feed, ranked every article and wrote every summary, then threw all
of it away at the claim. The reader was protected; the bill was not.

The obvious fix was the gate `find-jobs` already had, and reading it closely is
what produced this ADR. It is:

```ts
const last = await lastRunStartedAt()                     // a SELECT
if (!force && elapsedHours < jobPipeline.intervalHours) return []
// … several awaits later …
const runId = await startJobRun()                         // an unconditional INSERT
```

**That is the same read-then-write shape as the delivery bug, one level up.** Two
fires arriving together both run the SELECT before either runs the INSERT, both
read yesterday's timestamp, and both proceed. The docblock above it said
`job_runs.startedAt` made two runs in flight "impossible", and
[ADR-0025](0025-a-boot-catch-up-for-a-stale-pipeline.md) repeated the claim. It
was true of the case it was written for — yesterday's run against today's fire —
and false of the case that actually happened on 2026-08-16, where a boot replayed
missed fires 146 ms apart.

The window is widest exactly when the risk is highest: at boot, `migrate()` runs
on the first query of the process, so the gap between that SELECT and that INSERT
is at its largest in the one situation that fires several schedules at once.

Copying that gate to `curate-all` would therefore have bought very little, and
would have looked like a fix.

## Decision

**Both pipelines claim their cycle in a single guarded write before doing any
work, and only the caller the write answers may run.**

A new one-row-per-pipeline table, `pipeline_cycles`, holds the moment the last
run was *allowed to start*. `claimCycle(id, minGapMs, { force })` in
`src/db/cycles.ts` is the whole mechanism:

- `insert … on conflict do nothing … returning` covers the first run on a fresh
  volume, where there is no row to update. Of two runs racing an empty table
  exactly one insert lands.
- `update … where started_at < now - minGapMs … returning` covers every run after
  that. SQLite serialises writers, so of two runs holding the same cutoff exactly
  one matches the row.

Either way the decision comes out of a guarded write, never out of a preceding
read. A caller that gets no row back is turned away and says so in the log.

**`job_runs` stays the log and stops being the lock.** It keeps the counters, the
finish time and the note, and `lastRunStartedAt()` still answers the boot
catch-up's staleness question. What it no longer does is decide.

**The jobs interval is unchanged at `jobPipeline.intervalHours`.** Nothing about
that number was wrong; only the way it was enforced.

**The news interval is derived, not written down:** half the tightest gap between
consecutive `pipeline.digestHours`, via `newsMinRunGapMs()`. Today that is 5
hours, from a tightest gap of 10 (10:00 → 20:00 — not the 12 that "twice a day"
suggests, because the fires are unevenly spaced).

Deriving it is the point. A literal `9` would have been a third knob tied to the
cadence with nothing enforcing the relationship — the trap
`catchup.newsStaleAfterDays` already documents and `pnpm catchup:check` exists to
catch. Add an 08:00 digest and the tightest gap becomes 2 hours; a hardcoded 9
would then silently swallow two digests a day, visible only as the reader getting
less news. Half, because the runs this stops start milliseconds apart, so
everything above a few seconds is margin for a digest that fires *late* — 5 hours
of lateness is tolerated before a legitimate fire would be refused.

**The guard sits below the beat resolution and above the fetch.** Above it, a run
narrowed to a slug that does not exist would spend the cycle and lock out the
next real digest for hours; below the fetch, a duplicate has already paid for the
feeds and is about to pay for the ranker.

## Consequences

**Good:** a replayed boot no longer pays twice for the same news, which is a
ranking pass and a set of writer calls, or for the same jobs run, whose scoring
call is this system's single most expensive request. A gate that was advertising
a guarantee it did not provide now provides it. And the news cadence has one
source of truth: change `digestHours` and the guard follows.

**Costs:**

- **Two mechanisms now stand between a fire and a delivery**, and they are not
  redundant — the cycle claim stops a run *spending*, the delivery claim stops
  the reader *seeing* a duplicate. Anyone deleting one because "the other covers
  it" will be wrong in one direction or the other. A forced run bypasses the
  first and is still caught by the second, which is the case that shows why both
  exist.
- **A crashed run still holds its cycle**, deliberately, and for the same reason
  the old gate used `startedAt` rather than `finishedAt`: it spent the fetches
  and the model calls. The cost is that a run that dies in its first second
  blocks the next news fire for up to 5 hours, and the next jobs fire for 20.
  Nothing retries and nothing says so beyond a log line.
- **`force` is a real hole, and has to be.** `workflow:run` and Studio need to be
  able to fire a run deliberately; that run stamps the cycle but does not respect
  it. Two forced runs at once are exactly as overlapped as before, and only
  ADR-0033's delivery claim stands between them and a duplicate.
- **One more table.** It duplicates, in a narrow sense, a timestamp `job_runs`
  already holds. The split is deliberate — log versus lock — but it is a second
  place to look when asking "when did jobs last run", and the two can disagree
  if a forced run stamps one and not the other.

**Revisit if:** a pipeline gains a second schedule whose fires are *meant* to be
close together — the guard is a flat minimum gap and knows nothing about which
fire it is refusing. Or if runs start needing to be resumable, at which point a
crashed run holding its cycle stops being the conservative choice and the claim
needs a lease that expires.
