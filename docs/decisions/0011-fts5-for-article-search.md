# ADR-0011: FTS5 for article search, not embeddings

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Ava's `search-news` tool built one `LIKE '%<entire query>%'` pattern from the
reader's whole phrase and matched it as a single contiguous substring across
title and excerpt. Any multi-word question missed almost by construction.

Found from a real conversation, not from reading the code. The reader asked
*"What does the 500$ rl fine tune model does better?"* about an article that was
in the database and had been delivered to them:

> A $500 RL fine-tune of a 9B open model beat frontier models on catalog review

Replaying that turn, the model issued four searches and every one returned
nothing. It then told the reader it didn't know which model they meant. Measured
against the live database:

| query | hits |
| --- | --- |
| `RL fine tune model $500` | 0 |
| `fine tune` | 0 |
| `fine-tune` | 2 |
| `$500` | 1 |

A single hyphen was the whole failure. `fine tune` could not match `fine-tune`,
because nothing tokenized either side.

The tempting fix was embedding the titles and retrieving by cosine similarity.
That would have worked, and it would also have been the wrong first move: the
problem on the table was tokenization, not semantics, and [ADR-0007](0007-lexical-clustering-instead-of-embeddings.md)
already declined embeddings on the neighbouring problem for reasons that still
hold — a model call per item on the ingest path, a vector store, and a backfill
of everything already stored.

## Decision

An SQLite **FTS5** index over `items`, with porter stemming and bm25 relevance
ranking. No model call, no vector store, no new dependency — FTS5 is compiled
into the libSQL build already in use (verified before committing to this).

```sql
CREATE VIRTUAL TABLE items_fts USING fts5(
  title, excerpt, content,
  content='items', content_rowid='rowid',
  tokenize='porter unicode61'
);
```

External-content: the index stores no copy of the text, only postings pointing
back at `items` by rowid. Three triggers keep it in sync, and the `AFTER UPDATE`
one is scoped `OF title, excerpt, content` — without that column list, every
rank and every delivery would reindex rows whose text never changed.

Two decisions inside the query, both from observed behaviour rather than taste:

1. **Terms are quoted.** Punctuation is *match syntax* in FTS5, so an unquoted
   `fine-tune` parses as a column filter and fails with `no such column: tune`.
   Splitting on non-alphanumerics and quoting each term makes every one literal
   and leaves nothing a reader can type that reaches the query parser.
2. **AND first, then OR.** Requiring every term is the better answer when it
   lands, but the model guesses at wording it half-remembers — two of its four
   real attempts (`RLHF cheap fine-tune`, `500 dollars reinforcement learning
   model`) contain a term that appears nowhere. Under strict AND those return
   nothing, and nothing reads to the reader as an empty database rather than a
   near miss. Falling back to *any* term lets bm25 sort it out; a rare term like
   `500` outweighs a common one like `model`. Both empty still means both empty,
   so "I have nothing on that" survives as a real answer.

`search-news` also now returns `excerpt` and `reason` alongside the headline.
The old shape returned title/source/link/category/subtopic/score only, so even a
successful search handed the model a bare headline — which is the other half of
why that conversation went the way it did. The full body is deliberately still
withheld: `articleMaxChars` allows 8k, and fifteen of those per search is a bill.
Search *matches* on the body and *returns* the excerpt.

## Consequences

**Good:**

- Word order, case, punctuation and word endings stop mattering. All four
  searches from the original failed turn now return that article ranked first,
  and the same question answers correctly in 8.4s instead of failing in 25.5s.
- bm25 replaces `ORDER BY discoveredAt`, so results are ranked by relevance
  rather than recency for the first time.
- Free and instant. No embedding bill, no vector store, no per-item model call
  on the ingest path.
- The index is inspectable: `INSERT INTO items_fts(items_fts) VALUES('integrity-check')`
  verifies it against `items` on demand.

**Costs:**

- **Part of the app schema now lives outside `src/db/schema.ts`.** drizzle-kit
  cannot express a virtual table, so `drizzle/0005_items_fts.sql` is
  hand-written — generated with `drizzle-kit generate --custom` so the journal
  stays authoritative, but its contents are ours to maintain. This is a real
  dent in [invariant 4](../../AGENTS.md#invariants) and the reason this ADR
  exists rather than the change just landing.
- Three triggers are now load-bearing. Drop them and the index silently rots —
  reads keep working and quietly return stale rows. The integrity check catches
  it, but only if someone runs it.
- `searchNews` costs two queries on a miss (AND, then OR) and two on a hit
  (ranked ids, then the typed rows). Irrelevant at 288 rows; worth revisiting at
  a scale this database is not going to reach.
- OR fallback means a search rarely returns literally nothing, so "nothing
  found" is a weaker signal to the model than it was. Mitigated by bm25 ordering
  and by Ava's standing instruction not to invent.
- Still purely lexical. `OpenChat Vicuna Zephyr` correctly returns nothing here,
  but so would a genuinely synonymous phrasing.

**Revisit if:** searches miss articles whose wording shares no stem with the
question — the conceptual miss embeddings actually solve. That is the signal
this has run out, and it should be measured against real failed turns the way
this one was, not assumed. A libSQL vector index would then sit *beside* FTS5,
not replace it.
