# ADR-0004: Native Mastra schedules over a job queue

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

Digests fire three times a day per category. The initial design used an external
cron writing to a `jobs` table, with the container subscribing and claiming work
(see [ADR-0003](0003-convex-for-storage-and-scheduling.md)). The justification
was durability: a cron tick that fires while the process is dead is lost forever,
whereas a queued row waits.

Mastra turned out to support declarative schedules directly on a workflow:

```ts
schedule: [{ id, cron, timezone, inputData }]
```

Schedules appear in Studio at `/workflows/schedules` with next-fire time, full
trigger history, and durable pause/resume. Declaring one promotes the workflow to
the evented engine, which requires a storage adapter supporting concurrent
updates — verified as `true` for both LibSQL and Convex before deciding.

## Decision

Use native Mastra schedules. Six are generated from config — one per category per
digest hour — so a new category or a changed cadence requires no code edit.

## Consequences

**Good:** deletes the jobs table, the claim logic, and the subscription worker
outright. Schedules become visible and pausable in Studio, which is the only
dashboard this project has.

**Costs:**
- The scheduler is an in-process `setInterval` loop, so it needs the long-lived
  host from [ADR-0001](0001-mastra-in-a-container-with-no-inbound-ports.md) and
  will not fire on serverless.
- **A fire missed while the container is down is not replayed.** Resume
  recomputes the next fire time rather than backfilling.

### Why the missed-fire cost is acceptable

The original durability argument was overstated, and correcting it is the point
of this record. This pipeline is **idempotent**: items stay unsent until they are
actually sent, so an 8:00 digest missed while the box was down is not lost work —
the 13:00 run selects exactly the items 8:00 would have sent. The queue would
have bought replay of a run whose work self-heals anyway.

**Revisit if:** a delivery path is added where each fire has unique, unrecoverable
work — a "market open" alert that is worthless an hour later, for instance. That
is a real reason for a durable queue; "missed cron" alone is not.
