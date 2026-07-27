# ADR-0008: Categories as configuration, one parameterized curator

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

The requirement was "different agents for different categories, so each one is
expert at filtering its beat" — starting with computer science and design.

Read literally that means one agent class per category. It is also the wrong
shape: category three becomes a copy-paste of category two, and every prompt
improvement has to be applied N times.

## Context of "expertise"

An expert curator differs from a generic one in exactly two ways: the standard it
judges against, and what it has learned the reader actually wants. Neither
requires separate code.

## Decision

One workflow and one agent factory, parameterized by a `CategoryDefinition` in
`src/config/categories.ts`. Adding a beat means adding an array entry — agents,
schedules, and feeds are all derived from `CATEGORIES`.

Expertise comes from two sources:

1. **The rubric**, baked into the agent's instructions per category.
2. **The feedback history**, joined per category at run time and passed **in the
   prompt, not in the instructions** — so it cannot go stale between restarts.
   👍/👎 on an AI paper trains the CS ranker without touching the design one.

Each category gets **two** agents, split by cost profile: a cheap ranker that
sees hundreds of items per run, and a strong digest writer that sees a handful.

Two rules that fall out of this and are easy to get wrong later:

- Items are labelled with a **subtopic** during ranking, so digests can be
  sectioned without a second model call.
- Dedupe is **global, not per-category**. A story that hits two beats is stored
  once and tagged, never delivered twice.

## Consequences

**Good:** a new category is a config edit. Prompt improvements to the ranker
benefit every beat at once. All rubrics sit side by side in one reviewable file.

**Costs:**
- Per-category behaviour is limited to what the `CategoryDefinition` shape
  expresses. A beat needing genuinely different *mechanics* — not just a
  different standard — would need the shape extended or an escape hatch.
- All rankers share one prompt skeleton, so a change to it affects every category
  simultaneously.

**Revisit if:** a category needs a different pipeline rather than a different
rubric — for example one requiring full-article fetch before ranking. Extend
`CategoryDefinition` first; only fork the workflow if that genuinely fails.
