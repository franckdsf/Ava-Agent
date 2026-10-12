---
slice: <short-kebab-name>
branch: <type>/<summary>
status: active
---

> **Intent before implementation.** This file describes what we agreed to build, not what exists.
> If it disagrees with the repo, **the repo is right and this file should already be gone** —
> see [README.md](./README.md).

# <Slice name>

One sentence: what the reader gets after this lands that they cannot get today.

---

## 1. Problem

**What is broken or missing.** Two or three sentences, from the reader's side, not the code's — what
arrives in the chat, or fails to.

**How we would know it worked.** A number where one is possible, an observable behaviour where it is
not. "Nine of ten postings carry a company domain" is a check; "the digest feels better" is not.
Name the script that will produce the number — this repo measures with `pnpm <thing>:check`, and a
claim with no script behind it is an assertion.

**Which invariant this sits closest to.** `AGENTS.md ## Invariants`, by number. A slice that comes
near one is not forbidden; it is the slice that needs its reasoning written down before the diff.

---

## 2. Architecture

**Schema** — new or changed tables and columns in `src/db/schema.ts`, with their indexes and the
query each index answers. Every schema edit means `pnpm db:generate` in the same commit: a migration
that lags the code is the failure this repo names explicitly. Drizzle owns app tables and never
touches `mastra_*` (invariant 4) — say which side each table is on if it is not obvious.

**Workflows, agents, tools, commands** — the surface, one line each. Which of them is scheduled and
which is reader-triggered, because that is the difference between a step that must be idempotent
and one that must answer fast.

```
src/mastra/workflows/find-leads.ts     scheduled   daily   → ingest · filter · write · notice
src/mastra/tools/lead-brief.ts         tool        Joob    → one lead, rendered
src/mastra/commands/leads.ts           /leads      Joob    → the last run's rows
```

**Telegram surface** — which bot, which tab, what the message looks like. One tab carries one kind
of traffic (invariant 9), so a new kind of traffic is a new tab and that is a decision, not a
detail. Give the message shape here: what is bolded, what is a link, what happens when the list is
empty.

**Flow** — the path a run takes, only where it is not the ordinary one. Anything scheduled, anything
calling a model, anything hitting a third party, and anything that fans out belongs here. Name the
model role (`AVA_MODEL_*`) each call uses and roughly what it costs per run.

**State a scheduled call may write** — invariant 2 is a shape, not a list: a scheduled model call
gets control flow it cannot choose. Say which decisions in this slice are the code's and which are
the model's. If none of it is scheduled, say "none" — an empty statement is a decision, a missing
one is an oversight.

---

## 3. Program design

**The section that pays.** Files, call stack and signatures — no implementation. This is the
contract between the workflow step and the service under it, and between the command and the agent
that answers it, so it is agreed here or it is discovered during wiring.

**Files created or changed:**

```
src/db/schema.ts                      leads table + by_domain, by_run
drizzle/00NN_<generated>.sql          pnpm db:generate — never hand-written
src/services/lead-identity.ts         (url: string) => string | null
src/mastra/workflows/find-leads.ts    the steps, thin — the logic lives in services
src/config/leads.ts                   the thresholds, each beside the measurement that chose it
scripts/check-leads.ts                the offline half, one case per decision below
```

**Signatures** — the seam, in full. Everything written against on the other side:

```ts
findLeads(input: { runId: string; limit: number }): Promise<{
  considered: number;
  stored: Lead[];
  skipped: Array<{ url: string; reason: "no-domain" | "platform-host" | "duplicate" }>;
}>
```

A step returns what the next step and the notice both need. A count that is only ever logged is not
part of the seam; a `reason` a message renders is.

**Tunables** — the numbers this slice introduces, their home in `src/config/`, and the measurement
that chose each. None of them go in `.env` ([ADR-0041](../decisions/0041-one-deployment-one-reader.md)):
a `.env` is copied once at deployment and never revisited, so a number kept there outlives its own
reasoning.

**Checks** — the list, before they are written. Every decision argued about above needs a case in
the script, or it is a guard that will silently stop applying.

```
pnpm leads:check     platform hosts reduced · exact-match domain not truncated · empty list renders
pnpm verify          before claiming any of it works
```

**Decisions I am least confident about** — the choices a diff hides. Name two or three: a shape that
could reasonably have gone another way, a place the ADRs did not clearly decide, a thing deferred.
This is the cheapest review in the whole process.

---

## 4. Slices

Thin end to end first, then depth. Each step is something that can be run, read in a chat, or wired
against — a step that produces nothing observable belongs merged into its neighbour.

```
1. the service + its offline check, hardcoded input      → the shape is real and testable at once
2. schema + pnpm db:generate + the repository call       → one row can be stored and read back
3. the workflow step calls the service for real          → nothing above it changes
4. the tab, the message shape, the empty state
5. the schedule, and the notice that says a run happened
```

Step 1 exists so that nothing waits on a migration to be exercisable.

---

## Landing

- [ ] `pnpm verify` green
- [ ] The relevant `pnpm <thing>:check` run, and its output read — not just its exit code
- [ ] `pnpm db:generate` run if `src/db/schema.ts` moved, and the migration committed with it
- [ ] `invariant-reviewer` spawned and clean, or its findings approved
- [ ] Decisions worth keeping promoted to [decisions/](../decisions/README.md), measurements to
      [GOTCHAS/](../GOTCHAS/), tunables to `src/config/`
- [ ] **This file deleted** — the slice is not done while it exists
