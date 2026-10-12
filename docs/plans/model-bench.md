---
slice: model-bench
branch: feat/model-bench
status: active
---

> **Intent before implementation.** This file describes what we agreed to build, not what exists.
> If it disagrees with the repo, **the repo is right and this file should already be gone** —
> see [README.md](./README.md).

# Model bench

Any pipeline model knob can be re-decided with one command — `pnpm bench <task>` — that runs a
field of models × reasoning efforts through the real call path and prints a ranked, judged,
costed table.

---

## 1. Problem

**What is broken or missing.** `src/config/env.ts` carries 17 `AVA_MODEL_*` knobs. Two of them —
translator and summarizer — have a re-runnable bench (`pnpm models:check`), and that bench cannot
rank two models that both work: it says so itself and hands the call to a human reading
transcripts. Every other measurement in `env.ts` was a one-off script that no longer exists, so
when a new model ships, nothing can say whether it beats the incumbent on *this* reader's ranker,
scorer or writer.

**How we would know it worked.**

- `pnpm bench ranker` against frozen fixtures prints a table where every entrant has: ok/clean
  runs, median latency, real cost per call, reasoning tokens, code-found flags, the judge's rank —
  and, for the ranker only, **agreement with the reader's own votes** in `feedback`, when the
  database it reads has any (see decision 3).
- The incumbent is always in the field, so every table answers "better than what runs now?".
- Re-running the same field on the same fixtures puts the same entrant first in ≥ 2 of 3 runs. If
  it does not, the task is inside its noise floor and the table says so rather than naming a winner.
- `pnpm models:check` is gone and `pnpm bench translator` / `pnpm bench summarizer` report at least
  what it did.

**Which invariant this sits closest to.** **8** — the bench calls the real functions a workflow
calls, and must write nothing those functions' callers would have written. They already return
rather than store (`scoreBatch`, `writeJobBrief`, … persist nothing themselves), and the bench
never calls a `save*`. **2** is untouched: no scheduled call changes shape.

**Out of scope, on purpose.**

- **Newy and Joob** (`AVA_MODEL_ORCHESTRATOR`) — conversational, tool-using, just moved to
  `deepseek-v4.1-flash`. Benching them needs fixture tools; a later slice if ever.
- **The three scouts** (`BEAT_SCOUT`, `JOB_SCOUT`, `LEAD_SCOUT`) — their quality is *what survives
  code verification of a live web search*, which `discovery:check`, `sonar:check` and
  `leadscout:check` already measure. A judge cannot tell a real careers page from a plausible one.

---

## 2. Architecture

**Schema** — none. The bench reads `articles`, `feedback`, `jobs`, `leads`, `lead_signals`,
`memories` and the CV/portfolio state; it writes no table.

**Commands** — one script, a task registry behind it:

```
scripts/bench.ts            pnpm bench <task> [--models a,b] [--runs 3] [--fixtures N] [--refresh]
```

| Task | Knob | Real function called | Code-provable checks (flags) |
| --- | --- | --- | --- |
| `ranker` | `RSS_RANKER` | `rankBatch` (extracted) | every id scored once · no foreign id · subtopic ∈ labels · score ∈ 0–100 · **agreement with `feedback` votes** |
| `article-writer` | `RSS_SUMMARIZER` | `writeArticleSummary` (extracted) | lede non-empty · point count in bounds · no frame phrase |
| `job-scorer` | `JOB_SCORER` | `scoreBatch` | every id once · no foreign id · fit ∈ 0–100 · reason non-empty |
| `job-writer` | `JOB_WRITER` | `writeJobBrief` | schema fields non-empty · length in bounds |
| `lead-scorer` | `LEAD_SCORER` | `scoreLeadBatch` | as job-scorer |
| `lead-writer` | `LEAD_WRITER` | `writeLeadBrief` | as job-writer |
| `lead-vision` | `LEAD_VISION` | `judgeLeadVisuals` | fields non-empty · no "I cannot see" refusal |
| `memory-reviewer` | `MEMORY_REVIEWER` | `reviewMemories` | promoted ids ⊆ input ids |
| `translator` | `TRANSLATOR` | `translateChunk` | ported from `check-models.ts` metrics |
| `summarizer` | `SUMMARIZER` | `summarizeSource` | ported from `check-models.ts` metrics |
| `beat-namer`, `job-targeter`, `lead-targeter` | their knobs | `nameBeat`, `parseTarget`, `parseClient` | schema-only; fixtures are hand-written one-liners |

**Telegram surface** — none. Both bot tokens are deleted from `process.env` before anything
imports, as `check-models.ts` does today.

**Flow** — per task:

```
fixtures   read once from the db → .data/bench/fixtures/<task>.json   (gitignored: carries the CV)
           later runs reuse the file; --refresh re-reads. Same inputs across runs = comparable runs.
field      candidates × efforts → entrants, shuffled, blind-labelled A, B, C…
generate   per entrant per run: register a clone of the real agent under the REAL id in a
           throwaway Mastra, call the real function (withRetry included — retries are part of
           what a model costs), measure ms / tokens / reasoning / cost, run the task's check()
judge      one call, all answers, blind, on the task's criteria + the flags as evidence
out        table to stdout · transcript to .data/bench/runs/<task>_<timestamp>.md
```

Cost: a field of 5 models × 2 efforts × 3 runs = 30 generations + 1 judge. On the ranker that is
cents; on the job scorer (~20k-token CV per call) it is the expensive one — the plan prints
`entrants × runs = N calls` before spending anything, as cuisko's does.

**State a scheduled call may write** — none. Nothing here is scheduled.

---

## 3. Program design

**Files created or changed:**

```
src/mastra/agents/curator.ts       + rankBatch, writeArticleSummary, renderRankingPrompt,
                                     renderArticleForWriter (moved) — mirrors scoreBatch
src/mastra/agents/job-scorer.ts    + renderJobScoringPrompt, renderJobBriefPrompt
src/mastra/agents/lead-scorer.ts   + renderLeadBriefPrompt, renderLeadVisionPrompt
src/mastra/workflows/curate-all.ts  calls rankBatch / writeArticleSummary instead of inline generate
src/mastra/workflows/find-jobs.ts   calls the render* functions — no behaviour change
src/mastra/workflows/find-leads.ts  same
src/config/bench.ts                judge model, default runs, concurrency, timeouts — each with why
scripts/bench.ts                   argv → task → runBench
scripts/bench/kit.ts               runBench: field, pool, clone, attempt, judge, table, transcript
scripts/bench/clone.ts             the Measured agent + clone(), lifted out of check-models.ts
scripts/bench/tasks/<task>.ts      one per row above: fixtures(), call(), check(), criteria
scripts/bench/__tests__/           pool order, blind labelling, table on a failed field — offline
scripts/check-models.ts            deleted in the last slice
docs/COMMANDS.md                   models:check row → bench row
src/config/env.ts                  each benched knob's comment points at `pnpm bench <task>`
```

**Signatures:**

```ts
type Effort = false | 'low' | 'medium' | 'high' | number   // number → reasoning.max_tokens
type Candidate = { model: string; efforts: readonly Effort[] }

interface BenchTask<Fixture, Output> {
  title: string                                   // 'ranker'
  knob: keyof Env                                 // 'AVA_MODEL_RSS_RANKER' — the incumbent
  agentId: string                                 // the id the real function resolves
  agent: Agent                                    // the real one, cloned per entrant
  field: readonly Candidate[]                     // edit this list; incumbent added if missing
  fixtures(count: number): Promise<Fixture[]>     // read from the db, frozen to .data/bench
  call(mastra: Mastra, fixture: Fixture): Promise<Output | null>   // the real function
  check?(output: Output, fixture: Fixture): string[]                // one string per defect
  score?(outputs: Output[], fixtures: Fixture[]): Record<string, number>  // ranker: vote agreement
  criteria: readonly string[]                     // heaviest first
}

runBench(task, options: { models?: string[]; runs: number; fixtures: number; refresh: boolean })
  : Promise<{ ok: number; clean: number; total: number; spent: number; transcript: string }>
```

`call` returning `null` is a failed run, exactly as `withRetry` exhausting its attempts is in
production — the bench does not get a kinder definition of failure than the pipeline.

**Tunables** — `src/config/bench.ts`: judge model, runs (3), concurrency, per-call and judge
timeouts. Defaults taken from cuisko's bench and from `check-models.ts` (concurrency 8 there,
15 there — pick 8 and say why: OpenRouter 429s read as bad models). Nothing in `.env`.

**Checks:**

```
pnpm verify                        offline tests for pool, labelling, table, and the extracted
                                   render* functions (same string as the inline code produced)
pnpm bench ranker --runs 1         live smoke: one field, read the table AND the transcript
```

**Decisions I am least confident about**

1. **Reasoning effort on a clone** — low risk. The clone sets `providerOptions.openrouter.reasoning`
   in `defaultOptions`, the same place Newy and Joob set it and where it demonstrably reaches
   OpenRouter. The `reasoning` column still watches it: an effort that buys 0 reasoning tokens was
   dropped.
2. **Real cost** — likely. Mastra 1.52's `generate` result exposes `providerMetadata`
   (`stream/base/output.d.ts`), so `openrouter.usage.cost` is reachable if the clone sends
   `usage: { include: true }`. Unconfirmed until the first live call; the fallback is
   `check-models.ts`'s price-list × tokens, labelled as an estimate in the table.
3. **What a scorer is ranked against** — open, under separate analysis. Measured 2026-10-12 on the
   local DB: `feedback` has **0** votes, `leads`/`lead_matches` are **empty**, `job_matches` has
   17,261 incumbent scores and `job_deliveries` 206 rows, with no negative signal anywhere. So the
   ranker's vote agreement depends on the production DB having votes, and the lead tasks have no
   local fixtures. Until this is decided, scorer tables show the judge and run-to-run stability and
   say plainly that neither is ground truth.

---

## 4. Slices

```
1. extract render* + rankBatch/writeArticleSummary, workflows call them   → (clean), no behaviour
   change, offline test pins each prompt string. Lands alone.
2. kit + `pnpm bench ranker`, fixtures frozen, judge, table, transcript   → one live run, read
3. translator + summarizer onto the kit; delete check-models.ts           → models:check parity
4. job-scorer, job-writer, lead-scorer, lead-writer, lead-vision,
   article-writer, memory-reviewer                                        → one task file each
5. beat-namer, job-targeter, lead-targeter; env.ts comments → pnpm bench  → ADR
```

Slice 1 is worth having even if the bench stopped there: four prompts move out of workflow
steps into the agent file that owns the model they are sent to.

---

## Landing

- [ ] `pnpm verify` green
- [ ] `pnpm bench ranker` run live, table and transcript read — not just the exit code
- [ ] `invariant-reviewer` spawned and clean, or its findings approved
- [ ] ADR: a pipeline model is chosen by `pnpm bench`, incumbent always in the field
- [ ] `docs/COMMANDS.md` row for `pnpm bench`, `models:check` row removed
- [ ] **This file deleted** — the slice is not done while it exists
