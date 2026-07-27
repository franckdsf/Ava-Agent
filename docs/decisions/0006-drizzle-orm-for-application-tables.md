# ADR-0006: Drizzle ORM for application tables

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

The app's tables were first written as raw SQL with `CREATE TABLE IF NOT EXISTS`
applied lazily at startup, plus hand-written row mappers.

Two problems, both structural rather than cosmetic:

1. **No migration path.** `IF NOT EXISTS` creates tables but cannot alter them.
   The first added column would mean hand-written `ALTER TABLE` statements and
   manually tracking which had been applied.
2. **Unchecked casts.** Mappers were full of `row.score as number | null`.
   Renaming a column left TypeScript silent and broke at runtime.

Prisma was considered and rejected: a separate schema DSL, a generate step, and a
heavier runtime, buying nothing at this size.

## Decision

Use Drizzle ORM for the app's tables, with `drizzle-kit` for migrations.

Schema lives in `src/db/schema.ts` as TypeScript. Migrations are generated into
`drizzle/`, committed, and applied at first use by `migrate()` in
`src/db/client.ts` — so there is no separate migrate step to forget in
development or in the container.

**Ownership boundary:** Drizzle owns only the tables declared in `schema.ts`.
Mastra creates and migrates its own `mastra_*` tables in the same database,
independently. Neither knows about the other, and they must not be made to.

## Consequences

**Good:** column renames are compile-time errors, migrations are versioned and
reviewable in diffs, and `pnpm db:studio` gives a database browser for free.

**Costs:**
- Two dependencies and a generate step — `pnpm db:generate` must be run after
  every `schema.ts` edit, or the migration silently lags the code.
- `db.batch()` is typed as a non-empty tuple, which a dynamically built array
  cannot satisfy. One contained cast lives in `batchAll()` in `src/db/client.ts`
  rather than being repeated at each call site.

**Revisit if:** the schema stops changing entirely, which would remove the main
justification. Unlikely while the ranking pipeline is still being tuned.
