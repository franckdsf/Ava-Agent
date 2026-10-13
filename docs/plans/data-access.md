---
slice: data-access
branch: main
status: active
---

> **Intent before implementation.** This file describes what we agreed to build, not what exists.
> If it disagrees with the repo, **the repo is right and this file should already be gone** —
> see [README.md](./README.md).

# Slice 7 — Data access stays in `src/db/`, and the small copies are one

After this lands a column rename breaks only `src/db/`, the news tools read through named
repository functions, and `hostOf`, `parseDate` and a page fetch each exist once — held by C6.

[04-BLUEPRINT Parts 5 and 6](../audit/04-BLUEPRINT.md#part-5--data-access-stays-in-srcdb-f9-d2),
fixing [03 F9](../audit/03-FLAWS.md#-f9--reads-outside-srcdb) and
[F10](../audit/03-FLAWS.md#-f10--helpers-twice-and-three-times). F11 is already done (D3).

---

## 1. Problem

**Measured at `1c58dce`, unchanged since the audit.** Four files query the database outside
`src/db/`: `tools/news.ts` (7 queries, one of them the FTS5 `MATCH`), `commands/beats.ts` (1),
`services/lead-signals.ts` (1), `workflows/find-leads.ts` (1, through three dynamic `import()`s).
Every write is already in `src/db/`, so nothing is corrupted — but a schema change has four more
places to break, and nothing says so.

**Two things the audit did not count:**

- **One query is written twice.** `/beat`'s stats (`commands/beats.ts` `beatStats`) and the
  `news-stats` tool run the same linked / ranked / delivered query over `article_beats ⋈ articles`.
- **`read-article` re-queries what `getArticle` in `db/articles.ts` already returns.**

**The small copies:**

| Helper | Copies | Same? |
| --- | --- | --- |
| `hostOf` | `feed-discovery`, `feed-timeliness`, `feed-finder` | the first two identical; `feed-finder` also accepts a bare `example.com` |
| `parseDate` | `ats`, `job-fetch` | identical — and so are `truncate` and the trimmed-string helper beside them |
| `fetchPage` | `feed-discovery` | a copy of `services/page-fetch.ts`, same headers, redirect and non-200 handling |

Not copies, and kept: `job-scout`'s `fetchPage` (a documented wrapper that pins the scout's own
timeout and agent onto the shared one) and `lead-identity`'s `normalizeHost` (reduces to the
registrable domain and keeps platform tenants — a different function).

**How we would know it worked.** C6 passes with no baseline; `drizzle-orm` and `db()` appear in no
file outside `src/db/`; each helper is defined once; the news tools return what they returned
before, pinned by a test written first.

**Invariants it sits closest to.** **4** — drizzle owns the app tables: the FTS5 `MATCH`, the one
runtime raw SQL, moves from `tools/news.ts` to `db/articles.ts`, and AGENTS.md's invariant-4 line
that names its location changes with it. **8** — nothing here writes; the moved reads stay reads.

---

## 2. Architecture

**Schema** — none, no migration. **Surface** — no new command, tab, workflow or tool; every tool's
input and output schema unchanged. **State a scheduled call may write** — none: no write moves.

```
src/db/articles.ts         + deliveredArticles, searchArticleIds (FTS5), articlesByIds,
                             verdictsForArticles, beatActivity — getArticle reused
src/db/feedback.ts         + votes({ beat?, vote?, limit })
src/db/jobs.ts             + recentPostings(since, limit)
src/db/leads.ts            + getSignal(id)
src/mastra/tools/news.ts   shaping and tool contracts only — no drizzle-orm, no db()
src/mastra/commands/beats.ts      beatStats → beatActivity
src/services/lead-signals.ts      → recentPostings
src/mastra/workflows/find-leads.ts  signalFor → getSignal, the dynamic imports gone
src/lib/url.ts             hostOf — the one copy
src/services/posting-fields.ts    parseDate, truncate, the trimmed-string helper — a leaf, so
                                  ats ← job-fetch keeps its direction (C2)
src/services/feed-discovery.ts    fetchPage → page-fetch with discovery's agent and timeout
scripts/checks/c6-data-access.mjs + its test
```

---

## 3. Program design

```ts
// src/db/articles.ts
deliveredArticles(opts: { beat?: string; since: number; limit: number }): Promise<ArticleRow[]>
searchArticleIds(match: string, beat: string | undefined, limit: number): Promise<string[]>
articlesByIds(ids: string[]): Promise<ArticleRow[]>         // in the order given — bm25's
verdictsForArticles(ids: string[]): Promise<ArticleVerdictRow[]>   // one query, score desc
beatActivity(slug: string, since: number): Promise<{ linked: number; ranked: number; delivered: number }>

// src/db/feedback.ts
votes(opts: { beat?: string; vote?: Vote; limit: number }): Promise<{ title; source; vote; beat }[]>

// src/db/jobs.ts
recentPostings(since: number, limit: number): Promise<Pick<Job, 'company' | 'title' | …>[]>

// src/db/leads.ts
getSignal(id: string): Promise<LeadSignal | null>

// src/lib/url.ts
hostOf(url: string): string | null       // hostname, www. dropped, lowercased; null if not a URL
```

`searchTerms` (the quoting that keeps a reader's punctuation away from FTS5 syntax) and the
AND-then-OR fallback stay in the tool: they decide what the reader's phrase means, which is the
tool's job. The repository takes a match expression and runs it.

**C6 — data access:**

1. No `drizzle-orm` import outside `src/db/` (`import type` allowed).
2. No `db` or `migrate` import from `db/client`, static or dynamic, outside `src/db/`.
3. No value import of a table from `db/schema` outside `src/db/` (types allowed).

Over `src/`, tests exempt. **`rawClient` is allowed:** `mastra/storage.ts` hands the connection to
Mastra's `LibSQLStore`, which is Mastra owning `mastra_*` (invariant 4), not app data access.

**Tunables** — none.

**Checks:**

```
src/mastra/tools/__tests__/news.test.ts   written FIRST, on a seeded database, against today's code:
                                          recent-news (beat filter, window), search-news (AND, the
                                          OR fallback, bm25 order kept, punctuation, the beat EXISTS
                                          not duplicating), read-article, news-stats, my-feedback
src/mastra/commands/__tests__/…           /beat stats — the same numbers as news-stats
scripts/checks/__tests__/c6-data-access.test.ts
pnpm verify
```

**Decisions — agreed 2026-10-13: 1 strict, 2 (a).**

1. **One `hostOf`, strict; `feed-finder` adds the scheme at its call site.** No caller's result
   changes. The alternative — one lenient `hostOf` for all three — would start accepting bare
   hosts in feed discovery and timeliness, which never pass one today. **I recommend strict.**
2. **The audit documents: may a slice add an "as built" note?** `audit/README.md` says they are
   frozen and "never updated to match the new code"; slices 4+5 and 6 each added an *As built*
   note and corrected a Part 7 row anyway. Either (a) the README allows a dated *As built* note
   and a corrected check row, never a rewrite of the audited text — **I recommend this**: the notes
   are what the wrap-up's `docs/ARCHITECTURE.md` will be built from — or (b) those notes move to
   the ADRs and the blueprint is restored to its audited text.

---

## 4. Slices

```
1. news.test.ts on today's code                          → the tools' answers are pinned
2. news.ts reads → db/articles.ts, db/feedback.ts         → pure move; the pin stays green
3. beats.ts, lead-signals.ts, find-leads.ts reads → db/   → beatActivity shared with news-stats
4. hostOf, posting-fields, feed-discovery's fetchPage     → each helper once
5. C6 + its test; AGENTS (invariant 4's FTS line), CONVENTIONS, COMMANDS; ADR; decision 2
```

Each step `pnpm verify` green, reviewed, its own `(clean)` commit.

---

## Landing

- [ ] `pnpm verify` green
- [ ] `pnpm feeds:check` or `discovery:check` read — step 4 touches feed discovery's fetch
- [ ] `invariant-reviewer` spawned and clean, or its findings approved
- [ ] ADR: the data boundary is `src/db/`, with the one raw-SQL exception named; bears on 0005,
      0006, 0011. Blueprint Parts 5–7 checked against what landed
- [ ] **This file deleted** — and with it the last slice; the wrap-up (ARCHITECTURE.md, the audit
      frozen) is next
