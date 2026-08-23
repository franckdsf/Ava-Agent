# Plans

One file per slice, written **before** the code, deleted **when the code lands**.

A plan is scaffolding. It exists to make the expensive decisions cheap — while they are still a
paragraph rather than a diff — and then it comes down. Nothing in this folder describes how the
system works; that is what the code, the [decisions](../decisions/README.md) and the commit bodies
are for.

---

## Why the folder exists

Two problems, and the second is the one that matters most here.

**Decisions get made at the worst possible moment.** Without a plan, the choices that shape a
feature — which files exist, what a workflow step returns, what the columns are called, which tab
the message lands in — get made implicitly, mid-implementation, interleaved with the code that
depends on them. That is the most expensive place to change them: the work already exists, a
migration may already have been generated against it, and whoever wrote it is anchored to it.
The same decisions, made first, cost thirty lines of markdown and ninety seconds of reading.

**The seam here is not between two people, it is between two layers that fail differently.** A
workflow step is retried, scheduled and unattended; the service it calls is synchronous and can
throw. A slash command is a line of text a reader typed; the agent that answers it decides what to
do with it. Those interfaces are agreed in section 3 or they are discovered during wiring, and a
seam discovered during wiring is a rewrite on one side of it.

---

## Lifecycle

```
1. Write it        before code, in a short session — the model is cheap and unbiased here
2. Agree it        it is read back and pushed against; this is the point
3. Build from it   in slice order, thin end-to-end first
4. Take it down    deleted in the commit that finishes the slice
```

**Step 4 is not optional, and it is the whole reason this folder is safe to have.**

A plan that survives its slice becomes a document that describes the code and is not maintained by
the code — which is the exact failure this repo has already shipped. `.env` held
`AVA_MODEL_MEMORY_REVIEWER=deepseek-v4-pro` while the default in `src/config/env.ts` and the comment
justifying it still said `flash`; the running system and the documented system disagreed for months
and nothing could report it, because the disagreement *was* the configuration
([ADR-0041](../decisions/0041-one-deployment-one-reader.md)). A stale plan is worse than a stale
doc, because it reads as a specification and an agent will build against it.

Same rule this repo already applies to dead code: **delete it, git remembers.** If you need a landed
plan again:

```
git log --diff-filter=D --name-only -- docs/plans/
```

### What survives, and where it goes

Nothing is lost by deleting the file, because anything durable in a plan belongs somewhere else:

| What it was | Where it lives after |
| --- | --- |
| A description of what the code does | The code. It is the source of truth |
| A decision that constrains future code | A new record in [decisions/](../decisions/README.md) |
| A surprise with a measurement behind it | The matching file in [GOTCHAS/](../GOTCHAS/) |
| A tunable, and the measurement that chose it | `src/config/`, beside the number — never `.env` (ADR-0041) |
| What a check script now proves | [COMMANDS.md](../COMMANDS.md), and the ADR's `verify:` field |
| Why this slice existed at all | The commit body |

If a plan contains something that fits none of those rows, it was a note, not a decision.

---

## When to write one

**A change that crosses two layers.** A schema change plus the workflow that reads it, a new
workflow plus the tab it publishes to, a new slash command plus the agent and service behind it, a
new external source plus the check script that proves it. Those are the changes where an unagreed
interface costs a rewrite.

**Not** for: a prompt tweak, a copy change, a threshold moved in `src/config/`, a dependency bump, a
fix inside one file. A plan for a one-file change is ceremony, and ceremony is what teaches people
to skip the process entirely.

---

## The four sections

Copy [\_template.md](./_template.md). Each section answers a different question, and they are
ordered so that a wrong answer is caught before it is expensive.

| # | Section | The question | The cost of skipping it |
| --- | --- | --- | --- |
| 1 | Problem | What can the reader not get today, and how would we know it worked? | You build the right thing badly, or the wrong thing well |
| 2 | Architecture | Which tables, which workflows, which tabs, what flow? | Discovered during implementation, when the migration is already generated |
| 3 | Program design | Which files, what call stack, what signatures, which check script? | **The seam between a step and its service is discovered during wiring** |
| 4 | Slices | In what order, thin end-to-end first? | Five layers deep before anything is runnable |

Section 3 is the one most likely to feel skippable and is the one that pays. Keep it to signatures
and file paths — not implementation. If you are writing logic, you are writing the feature in
markdown, and the model is better at that in TypeScript.

---

## Enforcement 👁

Writing a plan is judgement, not a mechanism: nothing can tell whether a change "crosses two layers"
without being the judgement itself. What has teeth is the other end — the SessionStart hook in
[.claude/hooks/session-start.mjs](../../.claude/hooks/session-start.mjs) names every file left in
this folder at the top of every session, so a plan that outlived its slice announces itself rather
than rotting quietly.

The single rule with teeth: **a slice is not done while its plan file still exists.** Anything else
here is a guideline, and this file says so rather than pretending otherwise.
