# ADR-0007: Lexical clustering instead of embeddings

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

The same story reaches multiple feeds. Ranking and delivering it once is the
single biggest quality win in the pipeline, and it has to happen *before* the
ranking call so duplicates aren't paid for.

The obvious approach is embedding every title and clustering by cosine
similarity. OpenRouter does serve embeddings, so it was available. But it adds a
model call per item on the highest-volume path — arXiv alone contributes ~220
items a day — for a problem where headlines covering one story share most of
their words.

## Decision

Cluster with Jaccard similarity over normalized title tokens. No model call, no
vector store, no embedding cost.

Two refinements were added after running it against live feeds, not from
reasoning about it:

1. **Keep short numeric tokens.** The original length filter discarded `"26"` and
   `"5"` — exactly the version and date tokens that distinguish one release from
   another.
2. **Block merges on version/date mismatch** (`canMerge`). Templated titles such
   as `"Everything we covered at Release Notes <Month> '<YY>"` overlap so heavily
   that similarity clears any usable threshold. Five separate livestream recaps
   collapsed into one story. When both titles name a version or date and those
   disagree, they are different stories regardless of similarity score.

Short titles (<4 meaningful tokens) additionally require near-identity (≥0.8),
because they overlap too easily to trust at the normal threshold.

## Consequences

**Good:** free, instant, no external dependency, and fully inspectable — a
mis-merge can be read directly off the token sets.

**Costs:**
- Misses genuine duplicates worded differently ("OpenAI ships X" vs "X is here").
  Embeddings would catch those.
- The heuristic is tuned against observed feed data, so it carries assumptions
  about how these particular sources title things.
- A two-part series sharing a title prefix still merges. Judged acceptable.

**Revisit if:** digests visibly repeat the same story from different outlets.
That is the signal that lexical matching has run out, and `ConvexVector` or a
libSQL vector index becomes worth its cost. Before changing
`clusterSimilarityThreshold`, re-run ingest and inspect the actual merges — this
was tuned empirically and should be re-tuned the same way.
