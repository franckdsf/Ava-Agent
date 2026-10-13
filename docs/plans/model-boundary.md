---
slice: model-boundary
branch: main
status: active
---

> **Intent before implementation.** This file describes what we agreed to build, not what exists.
> If it disagrees with the repo, **the repo is right and this file should already be gone** —
> see [README.md](./README.md).

# Slice 6 — The model boundary has a place

After this lands every model call in `src/` goes through one function that takes its retry count as a
required argument, so "how many times is this asked" is written at every call site — and a check
keeps model calls inside `src/mastra/agents/`.

[04-BLUEPRINT Part 4](../audit/04-BLUEPRINT.md#part-4--the-model-boundary-has-a-place-f7), fixing
[03 F7](../audit/03-FLAWS.md#-f7--the-model-boundary-has-no-place).

---

## 1. Problem

**Half of Part 4 is already true.** Measured at `7f34aa3`: every `new Agent(` and `.generate(` in
`src/` is under `src/mastra/agents/` — the news ranker's inline call in `curate-all.ts` moved there
during the bench work. Outside `src/`, only `scripts/bench/kit.ts` calls `.generate(` (the bench's
judge), by design ([ADR-0046](../decisions/0046-a-model-is-chosen-by-pnpm-bench.md)).

**What is still missing is the shape.** The 17 calls, all structured, handle a bad answer three ways:

| How a malformed answer is handled | Calls |
| --- | --- |
| `withRetry(config.modelAttempts, …)` → null, the caller degrades | curator ×2, job-scorer ×2, lead-scorer ×3, lead-scout, lead-targeter |
| one attempt; throws, or returns a fallback | job-targeter ×2, memory reviewer, beat namer, site scout, job scout, summarizer |
| its own loop (re-asks once on a degenerate translation) | translator |

Nothing makes the choice visible, so it drifts. Two cases it has already cost:

- **`/target` parses once; `/client` parses twice.** Twin commands, the same kind of model call
  (`parseTarget` against `parseClient` with `leadPipeline.modelAttempts`). The targeter is the agent
  ADR-0046 caught failing 10 of 24 parses.
- **The job scout reports a failed call as "found no one".** `proposeCompanies` returns
  `response.object?.leads ?? []`, so an answer that does not parse becomes an empty list. Its caller
  in `services/job-scout.ts` records a *thrown* error as a problem on the source row — which is how
  "sonar failed" is told apart from "sonar found nothing" — but a parse failure never throws. This
  breaks the AGENTS.md rule *a model call that fails must leave its batch untouched, not settle it*.

**How we would know it worked.** `.generate(` appears in exactly one file in `src/`; every call site
passes `attempts`; C5 passes with no baseline; the job scout's parse failure lands as a problem line.

**Invariants it sits closest to.** **2** — a scheduled model call has a shape
([ADR-0042](../decisions/0042-a-scheduled-model-call-has-a-shape-not-a-list.md)): this gives that
shape a place, and no call gains control flow or write authority. **8** — no call's writes change.

---

## 2. Architecture

**Schema** — none. **Surface** — no new command, tab, workflow or tool.

```
src/mastra/agents/structured.ts   code   structured(agent, input, schema, { attempts, … }) — the only .generate(
src/services/structured-output.ts        withRetry and leakedStructure stay: pure, already tested
src/mastra/agents/*.ts                   every call site moves onto structured(); behaviour kept except the two below
scripts/checks/c5-model-boundary.mjs     the check, with its test
```

**Flow** — unchanged except the two decisions below. **State a scheduled call may write** —
unchanged: each call's result is still validated by code before anything is stored.

---

## 3. Program design

```ts
// src/mastra/agents/structured.ts
export async function structured<S extends z.ZodType>(
  agent: Agent,
  input: Parameters<Agent['generate']>[0],
  schema: S,
  options: {
    /** How many times to ask. Required, so `1` is a choice written down, not a default. */
    attempts: number
    /** Why a parsed answer is still unusable — retried like an unparseable one. */
    reject?: (object: z.infer<S>) => string | null
    onAttemptFailed?: (attempt: number, error: unknown) => void
    /** Throw this message instead of returning null, the last attempt's error as `cause`. */
    orThrow?: string
  },
): Promise<z.infer<S> | null>      // null when every attempt failed — the caller decides what that means
```

`orThrow` (agreed after step 1) is for the six sites that throw today: without it a 402 or a
timeout would be logged as "returned no parsable object".

It is `withRetry` around `agent.generate(input, { structuredOutput: { schema } })`, nothing more.
Call sites that throw on null today keep throwing — they check for null instead of
`response.object`. The translator keeps its degenerate-answer loop around `structured(…, { attempts: 1 })`:
that loop retries on *content*, not on parsing.

**C5 — the model boundary:**

1. `new Agent(` only under `src/mastra/agents/`.
2. `.generate(` and `.stream(` only in the file that defines `structured()`.

Over `src/`, tests exempt. `scripts/` is out of scope: the bench builds clones and calls its judge
directly, which is its job (ADR-0046).

**Tunables** — none new. `/target` reads `jobPipeline.modelAttempts` (2) if decision 1 is yes.

**Checks:**

```
src/mastra/agents/__tests__/structured.test.ts   a fake agent: good answer → once; null then good → twice;
                                                 throw counts as a failed attempt; rejected answer retried;
                                                 attempts exhausted → null
src/mastra/agents/__tests__/job-scout.test.ts    written FIRST, as it.fails: a parse failure must throw,
                                                 not return [] — flips to `it` with decision 2
scripts/checks/__tests__/c5-model-boundary.test.ts
pnpm verify
```

**Decisions for you.**

1. **`/target` and `/retarget` ask twice, like `/client`.** A visible change only when the first
   answer is malformed: the reader waits for a second call instead of getting an error. The holding
   message added last slice covers the wait. **I recommend yes.**
2. **A job-scout parse failure throws, and lands as a problem on the sonar row**, instead of
   counting as "no companies". The run continues either way — the caller already catches per search.
   **I recommend yes.** It is a bug by the AGENTS.md rule, so it is pinned by a test before the fix.
3. **Everything else keeps its count**, now written: the scorers, rankers and writers keep their
   config's `modelAttempts`; the memory reviewer, beat namer, site scout, summarizer, tighter-target
   advice and translator keep `attempts: 1`. Changing any of those is a bench question, not this
   slice's.

---

## 4. Slices

```
1. structured.ts + its test                                → the shape exists and is proven alone
2. the nine withRetry sites onto structured()              → pure move, verify green
3. the seven single-attempt sites + the translator, attempts: 1  → pure move; .generate( in one file
4. job-scout test as it.fails, then the fix (decision 2); /target attempts (decision 1)
5. C5 + its test; CONVENTIONS, COMMANDS, AGENTS; ADR      → the rule is held by a machine
```

Each step `pnpm verify` green, reviewed, its own `(clean)` commit — step 4 is `(fix)`.

---

## Landing

- [ ] `pnpm verify` green
- [ ] `pnpm bench job-targeter` run — it goes through the real `parseTarget`, so it proves the new
      shape against a live model (the job scout has no bench task; its test covers decision 2)
- [ ] `invariant-reviewer` spawned and clean, or its findings approved
- [ ] ADR: the model boundary is `src/mastra/agents/`, and every call states its attempts; bears on
      ADR-0042. Blueprint Part 4/7 rows checked against what landed
- [ ] **This file deleted**
