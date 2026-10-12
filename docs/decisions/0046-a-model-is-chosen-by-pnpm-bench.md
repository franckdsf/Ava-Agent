---
id: 0046
applies_to: ["src/config/env.ts", "src/mastra/agents/**", "src/config/bench.ts", "scripts/bench/**"]
status: accepted
supersedes: []
verify: "pnpm verify"
---

# ADR-0046: A model is chosen by `pnpm bench`, against the incumbent, on the real call path

- **Status:** Accepted
- **Date:** 2026-10-12
- **Bears on:** [ADR-0041](0041-one-deployment-one-reader.md) (model ids live in `env.ts`, measured),
  [ADR-0042](0042-a-scheduled-model-call-has-a-shape-not-a-list.md) (a scheduled call's shape),
  [ADR-0017](0017-translation-commands.md) and [ADR-0018](0018-summarize-command.md) (their
  `verify:` moved from `models:check` to the bench)

## Context

`src/config/env.ts` holds seventeen `AVA_MODEL_*` knobs. Two of them — translator and summarizer —
had a re-runnable check, `models:check`, and it could disqualify a model but not rank two that
worked. Every other measurement beside a knob was a one-off script that no longer existed. When a
model shipped, nothing could say whether it beat the incumbent on *this* reader's ranker or scorer.

The first runs showed what that had cost. Five agents ran `deepseek-v4-flash-0731` with no reasoning
setting, so the provider's default applied: the ranker took 60–180s a batch on ~7k reasoning tokens
for no better ranking. The beat namer and the job targeter were worse than slow — on the bench they
failed 12 of 24 beats and 10 of 24 parses outright, with ten-minute timeouts. `/beat` and `/target`
were broken in production and nothing had said so.

## Decision

**A model knob is changed only after `pnpm bench <task>`** (`scripts/bench.ts`, `docs/COMMANDS.md`).
A task names the agent, the real function a workflow or command calls, its fixtures, and what code
can prove wrong with an answer. The kit runs a field of models × reasoning efforts × routings:

- **Through the real call path.** Each entrant is a clone of the real agent — its instructions and
  provider options — registered under the real id in a throwaway Mastra, so the real function,
  `withRetry` included, resolves it. Retries are part of what a model costs.
- **Against the incumbent.** The knob's current value is always in the field, at the effort and
  routing production sends. A table answers "better than what runs now?" or it answers nothing.
- **Blind, then judged on evidence.** Entrants are shuffled under letters; a judge model ranks them
  per fixture on the task's criteria. A winner is named only when every fixture agrees.
- **Code-provable defects are flags, everything else is a column.** A flag reaches the judge as
  fact, so it must be provable: four times a loose check sank a model for something that was not a
  defect ("About You" read as addressing the reader; an off-list mismatch axis nothing parses).
- **Costs are what OpenRouter charged**, read from `usage: { include: true }`, not a price list.

**Every agent sends an explicit reasoning setting and routing.** Unset means the provider's
default, which is how the ranker came to think for a minute. Background agents route by price;
the calls a reader waits on — translator, summarizer, the two targeters — by latency, measured
on the translator: price routing there was slower and not cheaper.

**The measurement is written beside the knob**, in `env.ts`, with what lost and why — and a knob
set without a bench says so ("by analogy, not measured").

## Consequences

**Good:** a knob is re-decided in one command, on the inputs it actually sees, with the cost
OpenRouter actually billed. The first nine runs moved six agents to settings 4–5× faster and
cheaper, kept three where they were with the reason written down, and found `/beat` and `/target`
broken.

**Costs:**

- **No ground truth for the scorers.** The ranker's `agree` column needs reader votes in `feedback`
  and the local database had none; the job scorer has only the previous scorer's fits. Those tables
  rank on the judge and on run-to-run `spread`, and say so.
- **The judge reads the prompt, not the code.** It twice preferred the job targeter that matched
  the prompt's description of `filterJobs` over the one matching `filterJobs` itself; the verdict
  was reversed after reading the code. A surprising verdict is checked against the code first.
- **The judge is noisy.** One setting under two routings landed 3.0 and 4.5 on the summarizer.
  Differences inside ~1.5 ranks are a tie, decided on latency and cost.
- **Not benched.** The lead scorer, writer, vision and targeter were set by analogy with their
  job-side twins — the lead tables were empty. Newy and Joob (conversational, tool-using) and the
  three scouts (measured by `discovery:check`, `sonar:check`, `leadscout:check`) are out of scope.

**Revisit if:** the reader has voted enough for `agree` to rank the ranker; the lead tables have
data, at which point the lead knobs get tasks and their "by analogy" comments go.

## Verify

`pnpm bench <task>` — `ranker`, `article-writer`, `job-scorer`, `job-writer`, `translator`,
`summarizer`, `memory-reviewer`, `job-targeter`, `beat-namer`. `pnpm verify` runs the kit's
offline tests (`scripts/bench/__tests__/kit.test.ts`).
