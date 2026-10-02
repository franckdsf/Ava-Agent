---
id: 0005
applies_to: ["src/db/client.ts", "src/mastra/storage.ts", "src/lib/libsql-url.ts", "docker-compose.yml"]
status: amended
supersedes: ["0003"]
---

# ADR-0005: Two libSQL databases instead of Convex

- **Status:** Accepted (amended 2026-10-02)
- **Date:** 2026-07-27
- **Supersedes:** [ADR-0003](0003-convex-for-storage-and-scheduling.md)

## Context

With real-time declined and scheduling moved in-process
([ADR-0004](0004-native-mastra-schedules-over-a-job-queue.md)), Convex was
reduced to "a managed database" — not enough to justify a second service, a
second TypeScript world, and a composite-storage workaround for its missing
observability domain.

Traces are also a genuinely different kind of data from everything else: high
volume, write-heavy, disposable, and read almost exclusively in Studio during
local tuning. Storing them next to real data means trace churn competes for write
locks with the dedupe and memory tables.

## Decision

Drop Convex. Use **two** libSQL databases, split by data lifetime rather than by
domain:

| Database | Holds | Lifetime |
| --- | --- | --- |
| `AVA_DATA_DB_URL` | Mastra memory/workflows/scores + app tables | Precious — back it up |
| `AVA_TRACES_DB_URL` | Observability only | Disposable — delete anytime |

Wired with `MastraCompositeStore`: `LibSQLStore` as `default`, `ObservabilityLibSQL`
overriding the `observability` domain.

`LibSQLConfig` accepts an existing `client`, so Mastra's store and Drizzle share
**one** connection to the data database. Two independent pools against the same
local file would contend for write locks.

Turso *is* libSQL — the same `@libsql/client`, no separate SDK. So `file:` in dev
and `libsql://` in production is a URL change, not a code change.

## Consequences

**Good:** one system, one language runtime, no codegen step, no admin key, no
separate deploy. `mastra dev` is the whole development loop.

**Costs:**
- With a `file:` URL, state lives on container disk and needs a volume plus your
  own backups. `docker-compose.yml` ships a named volume for this.
- No transactional guarantee across the app's writes the way Convex mutations
  gave. Dedupe instead relies on a primary key over the canonical link hash with
  `INSERT ... ON CONFLICT DO NOTHING`, which is sufficient.
- Real-time is gone. If a dashboard is ever wanted it must be built, not
  subscribed to.

**Revisit if:** a second consumer needs the data concurrently, or a web dashboard
becomes desirable — Turso plus a read replica handles the first; the second is a
genuine argument to reopen [ADR-0003](0003-convex-for-storage-and-scheduling.md).

---

## Amendments, 2026-10-02

**"One connection" was wrong; one *client* is what is shared.** On a local file,
`@libsql/client` hands the current connection to each `transaction()` and opens a
new one for the next statement, so the shared client fans out into several
connections over its life. Sharing it still matters — Mastra serializes its writes
per client — but it does not by itself avoid lock contention.

The cost showed up as a lost `PRAGMA busy_timeout`: Mastra sets it once at boot, on
a connection the first transaction then takes away, so every later connection
failed on a lock in about a millisecond instead of waiting. The 2026-09-28
`review-memories` catch-up died that way and stayed `running`. `src/db/client.ts`
now passes `timeout` (`dataDb.busyTimeoutMs`), which libsql applies to every
connection it opens — the same thing Mastra does for a local client it builds itself.
