# ADR-0003: Convex for storage and scheduling

- **Status:** Superseded by [ADR-0005](0005-two-libsql-databases-instead-of-convex.md). Never implemented.
- **Date:** 2026-07-27

Kept because the evaluation was real and the reasoning is worth not repeating.

## Context

The pipeline needs durable state (dedupe history, feed ETags, feedback, agent
memory) and a scheduler. Convex was proposed as both, and it is a genuinely
strong fit on paper:

- An official `@mastra/convex` adapter exists — `ConvexStore` implements the
  Mastra storage contract, `ConvexVector` does embeddings and cosine search.
- Built-in cron jobs and a durable scheduler.
- Transactional mutations, which makes "have I seen this GUID?" plus the insert
  atomic — the correct primitive for dedupe.
- Reactive queries pushed over WebSocket.

The proposed design had Convex crons write a `jobs` row, with the container
holding a live subscription and claiming work — preserving
[ADR-0001](0001-mastra-in-a-container-with-no-inbound-ports.md) while adding
durability across container downtime.

## Decision

Adopt Convex for storage, scheduling, and a durable job queue. Mastra remains
the reasoning layer and never runs inside Convex.

## Consequences

**Good:** managed durability with no DB operations, a stateless container, and
real-time available for free if a dashboard is ever wanted.

**Costs:**
- `ConvexStore` does not implement the observability domain, so traces need
  `MastraCompositeStore` routing them elsewhere.
- A 1 MiB record cap (irrelevant for text, fatal for base64 attachments).
- A second service and a second TypeScript world: `convex/` has its own runtime,
  bundler, and codegen, and npm dependencies need `"use node"` actions.

## Why this was superseded

Convex's three differentiators each dissolved within hours:

1. **Real-time** — the web dashboard was declined; Telegram is a push channel
   with no subscriber, so reactivity bought nothing.
2. **Scheduling** — Mastra turned out to have native declarative workflow
   schedules with a Studio UI (see [ADR-0004](0004-native-mastra-schedules-over-a-job-queue.md)).
3. **Durability** — the argument was overstated. This pipeline is idempotent, so
   a missed run self-heals; see ADR-0004.

That left "a managed database," which did not justify a second service.
