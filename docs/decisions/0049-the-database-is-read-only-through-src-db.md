---
id: 0049
applies_to: ["src/db/**", "src/mastra/tools/news.ts", "src/lib/url.ts", "src/services/posting-fields.ts", "src/services/page-fetch.ts", "scripts/checks/c6-data-access.mjs"]
status: accepted
supersedes: []
verify: "pnpm verify"
---

# ADR-0049: The database is read only through `src/db/`, and a helper exists once

- **Status:** Accepted
- **Date:** 2026-10-13
- **Bears on:** [ADR-0006](0006-drizzle-orm-for-application-tables.md) (drizzle owns the app tables —
  now also the only place that holds it), [ADR-0011](0011-fts5-for-article-search.md) (the FTS5 query
  it describes in `tools/news.ts` now runs from `db/articles.ts`; the tool keeps the term quoting and
  the AND-then-OR fallback), [ADR-0043](0043-what-a-conversation-may-write-is-decided-by-what-reads-it-back.md)
  (the news tools now import only read functions), [04-BLUEPRINT](../audit/04-BLUEPRINT.md) Parts 5–7

## Context

The audit ([03 F9](../audit/03-FLAWS.md#-f9--reads-outside-srcdb)) found every write in `src/db/`
but reads in four other files: Newy's news tools (seven queries, the FTS5 `MATCH` among them),
`/beat`, the leads pipeline's hiring signals, and `find-leads`, which reached the database through
three dynamic `import()`s nothing explained. Nothing was corrupted, but a column rename had four
more places to break. Two things the audit did not count: `/beat`'s stats and the `news-stats` tool
ran the same query, and `read-article` re-ran `getArticle`'s.

[F10](../audit/03-FLAWS.md#-f10--helpers-twice-and-three-times) found helpers copied between files:
`hostOf` three times, `parseDate` twice, a page fetch twice. Beside `parseDate` sat two more copied
helpers, `clean` and `truncate`, and `clean` had a third copy in `job-hn.ts`.

## Decision

**Every read and write of the app tables is a named function in `src/db/`.** The news tools,
`/beat`, `hiringSignalsFromJobs` and `find-leads` call `deliveredArticles`, `searchArticleIds`,
`articlesByIds`, `verdictsForArticles`, `beatActivity`, `votes`, `recentPostings` and `getSignal`.
**The FTS5 statement in `db/articles.ts` is the one whole statement written as raw SQL** — the rest
of `src/db/` uses `sql` only for expressions inside the builder (`coalesce`, `max`, `not in`).

**C6 holds it.** Outside `src/db/`: no value import from `drizzle-orm`; no `db` or `migrate` from
`db/client`, static or dynamic; no table from `db/schema` — row types stay importable. `rawClient`
is allowed, for `mastra/storage.ts` handing the connection to Mastra's store (invariant 4). Over
`src/`, tests exempt. Landed with no baseline; on the pre-slice tree it flags the four files.

**Each helper exists once:**

| Helper | Home | Note |
| --- | --- | --- |
| `hostOf` | `src/lib/url.ts` | **strict** — `feed-finder` adds the scheme to a bare domain at its call site |
| `clean`, `truncate`, `parseDate` | `src/services/posting-fields.ts` | a leaf, so `job-fetch → ats` keeps its direction (C2) |
| page fetch | `src/services/page-fetch.ts` | `feed-discovery` and the job scout wrap it with their own agent and timeout |

`normalizeHost` (`lead-identity.ts`) is not a copy of `hostOf` — it reduces a host to the company
that owns it — and stays.

## Consequences

- **Pinned before it moved.** `src/mastra/tools/__tests__/news.test.ts` was written against the old
  code: window, beat filter, the AND-then-OR search, bm25 order, an article on two beats once,
  counts, votes. It passed unchanged after the move. The two leads reads gained a test they never had.
- **`hostOf` is strict, chosen over lenient.** A lenient one would have started accepting bare hosts
  in feed discovery and timeliness, which never pass one today. The cost is `withScheme()` in
  `feed-finder`.
- **`page-fetch.ts` used to say `feed-discovery` kept its copy on purpose** — folding it in would edit
  a working path in a second pipeline. The blueprint's "one `fetchPage`" overrode that; the copy was
  the same fetch, and the note is rewritten. Checked live: `discoverSiteFeed` resolved two sites.
- **C6 is a text check.** A query built from a table reached through a re-export would pass it.
  Accepted for the reason every check here is text-based (`scripts/checks/_lib.mjs`).
- **Not done:** an import allowlist so `tools/` and `commands/` reach only *read* functions in
  `src/db/` — CONVENTIONS still marks "nothing conversational writes what a run produced" ⏳.

## Verify

`pnpm verify` — C6 (`pnpm verify:data`), `news.test.ts`, `reads.test.ts`, `url.test.ts` and
`posting-fields.test.ts` among the tests.
