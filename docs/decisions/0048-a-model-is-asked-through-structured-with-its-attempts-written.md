---
id: 0048
applies_to: ["src/mastra/agents/**", "src/services/structured-output.ts", "scripts/checks/c5-model-boundary.mjs"]
status: accepted
supersedes: []
verify: "pnpm verify"
---

# ADR-0048: A model is asked through `structured()`, with how many times written at the call site

- **Status:** Accepted
- **Date:** 2026-10-13
- **Bears on:** [ADR-0042](0042-a-scheduled-model-call-has-a-shape-not-a-list.md) (a scheduled model
  call has a shape — this gives the shape a place), [ADR-0046](0046-a-model-is-chosen-by-pnpm-bench.md)
  (the bench resolves the real function, so it now measures `structured()` with each call's attempts),
  [04-BLUEPRINT](../audit/04-BLUEPRINT.md) Parts 4 and 7

## Context

The audit ([03 F7](../audit/03-FLAWS.md#-f7--the-model-boundary-has-no-place)) found no place for
model calls. By slice 6 the agents had all moved into `src/mastra/agents/`, but the 17 structured
calls in them handled a malformed answer three ways: nine through `withRetry` with their config's
`modelAttempts`, seven asking once and then throwing or falling back, and the translator with its own
loop. Nobody had chosen which, and it had already drifted twice:

- **`/target` asked once; its twin `/client` asked twice.** The same one-sentence parse, two counts.
- **The job scout turned an answer that did not parse into "found no companies".**
  `response.object?.leads ?? []` made a failed sonar call a quiet day on the source row, breaking the
  AGENTS.md rule that a failed model call must leave its batch untouched.

## Decision

**Every model call in `src/` is `structured(agent, input, schema, { attempts, … })`**
(`src/mastra/agents/structured.ts`). It is `withRetry` around the one `agent.generate()`, nothing
more. `attempts` is required, so `1` is written down rather than defaulted. It returns `null` when
every attempt failed and the caller decides what that means; with `orThrow: '<message>'` it throws
that message instead, with the last attempt's error in the text and as `cause` — so a 402 or a
timeout is logged as one, not as "the model returned junk".

| Call | Attempts | On failure |
| --- | --- | --- |
| news ranker, article writer | `pipeline.modelAttempts` | batch left unranked / excerpt |
| job scorer, job writer | `jobPipeline.modelAttempts` | batch left unscored / scorer's reason |
| lead scorer, vision, writer, scout | `leadPipeline.modelAttempts` | batch left unscored / carries on |
| `/client` (`parseClient`), `/target` (`parseTarget`) | the pipeline's `modelAttempts` (2) | throws |
| memory reviewer, beat namer, site scout, summarizer, translator, job scout | 1 | throws |
| tighter-target advice | 1 | `null`, the reply goes without it |

**Two counts changed, both agreed.** `/target` and `/retarget` ask twice, like `/client`; a second
call costs one more worst case behind the holding message — 9.2s on the 2026-10-12 bench, 15.5s on
the 2026-10-13 one, which ran through `structured()`: 6/6 parses, 0 retries, every parse exact. The job scout throws on an
unparseable answer, and `fetchSonarSource` records it as a problem on the sonar row — pinned first as
`it.fails` in `src/services/__tests__/job-scout.test.ts`. Every other count is what it was.

**The translator keeps its loop** around a one-attempt call: it re-asks on *content* (an echoed or
gloss-free translation), which `structured()`'s `reject` could express but would change when the
second answer is preferred. That loop keeps the better of two.

**C5 holds it.** `new Agent(` only under `src/mastra/agents/`; `.generate(` and `.stream(` (and their
`Legacy` variants) only in `structured.ts`. Over `src/`; comments, strings and tests exempt. Landed
with no baseline. `scripts/` is out of scope: the bench builds clones and calls its judge directly.

## Consequences

- **Changing a count is a one-line edit at the call site, and a bench question.** The table above is
  what the code says on 2026-10-13; the call sites are the source.
- **The boundary is the function, not the folder.** A file in `agents/` calling `.generate(` fails C5
  like any other — the blueprint wrote "only in `src/mastra/agents/`", which would have let the
  drift continue inside it.
- **`orThrow` is beyond the plan's signature**, added after step 1: without it six sites would each
  have needed three lines to keep the real error. The cost is an overload on `structured()`.
- **Error messages changed shape.** A thrown failure reads `<message> (<real error>)` where it read
  `<message>` or the bare provider error. No caller matches on an error's class or message; `/client`
  and `/target` failures now name the cause to the reader through Joob's `failed` line.
- **C5 is a text check.** `agent['generate'](…)` passes it. Accepted for the reason every check here
  is text-based (`scripts/checks/_lib.mjs`).
- **Not done: the chat agents.** Newy and Joob are driven by Mastra's channel layer, not by a call in
  `src/`, so they never reach `structured()` and C5 has nothing to say about them.

## Verify

`pnpm verify` — C5 (`pnpm verify:models`), `structured.test.ts` and `job-scout.test.ts` among the
tests. `pnpm bench job-targeter` runs the real `parseTarget` against a live model.
