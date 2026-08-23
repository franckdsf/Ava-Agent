---
id: 0042
applies_to: ["src/mastra/workflows/**", "src/mastra/agents/**", "src/mastra/index.ts"]
status: accepted
supersedes: []
verify: "pnpm workflow:run"
---

# ADR-0042: A scheduled model call has a shape, not a list

- **Status:** Accepted
- **Date:** 2026-08-23
- **Records:** invariant 2, which has been enforced since ADR-0001 and had never been written down
  as a decision. This ADR is a transcription, not a new rule — it is filed because the reasoning
  lived only in `AGENTS.md`, where nothing routed to it and nothing linked it to the code it governs.
- **Bears on:** [ADR-0001](0001-mastra-in-a-container-with-no-inbound-ports.md) (no inbound ports is
  what makes an unattended run unattended), [ADR-0004](0004-native-mastra-schedules-over-a-job-queue.md)
  (the scheduling mechanism, which this is not about).

## Context

A model call on a schedule runs with nobody watching it. That is the whole difficulty: a bad answer
in a conversation is corrected in the next message, and a bad answer at 06:00 is stored.

The rule that governs this was originally stated as **"only ranking, composing and the weekly memory
review"** — an enumeration. It was false for weeks before anyone noticed, because the weekly feed
review's top-up started calling the `sonar` scout on a cron and no list updates itself. The failure
mode is specific and worth naming: **a list goes stale silently.** Nothing breaks when a new call
site is added and the list is not, and the document keeps asserting a rule the code stopped
following.

The same failure has now happened twice in this repo — see
[ADR-0043](0043-what-a-conversation-may-write-is-decided-by-what-reads-it-back.md), which is the
same lesson learned on the write side, and which took three attempts.

## Decision

**A scheduled model call must have control flow it cannot choose, and no authority over what gets
stored.** The rule is a *shape*, not a list of permitted call sites. Two shapes qualify, and nothing
else does:

- **A classifier over a fixed row set.** Fixed control flow, a set handed to it, and the answer
  validated against that set on the way back — every one of them discards an id it was not given.
  The news ranker, the digest writer, the weekly memory reviewer, the job scorer, the job writer,
  the lead scorer, the lead vision call and the lead writer
  ([ADR-0038](0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
- **A search whose every answer is verified before it is stored.** A bounded loop over rows, a model
  that proposes, and *code* that establishes whether the proposal is real — `checkFeed()` for a
  feed, a careers-page fetch for a lead. The model never contributes a fact, only a candidate.

A call that fits neither shape does not go on a schedule. **Do not add it to a list of exceptions;
there is no list.**

## Why a shape rather than a list

A shape is checkable against a call site you have never seen. Reading `curate-all.ts`, you can ask
"is the row set fixed, and is the answer validated against it?" and get an answer from the code in
front of you. A list can only tell you whether someone remembered to update it.

The enumeration also invited the wrong question. "Is this on the list?" is answerable without
understanding why the list exists, so the first new call site that felt similar to a listed one got
added without the check that mattered.

## Cost

**The shape has to be re-argued at each new call site, which is slower than checking a list.** That
is the trade accepted: an argument that takes five minutes and is correct, over a lookup that takes
five seconds and silently stops being correct.

**"Verified before it is stored" is not mechanically checkable.** Nothing fails if a search's
verification step is weakened to a regex — `checkFeed()` cannot tell a feed from a sitemap
(`docs/GOTCHAS/search-and-discovery.md`), so the shape can be satisfied in form while the
verification underneath it is worthless. The shape constrains the structure, not the rigour.

**Two shapes may not be enough.** They cover every call site as of this writing, and a third
legitimate shape would mean amending this ADR — which is the intended outcome, and is exactly what
the list version made too easy to skip.

## Verify

`pnpm workflow:run <target>` exercises a real scheduled path end to end. There is no mechanical
check for this rule, and that is stated rather than papered over: the enforcement is reading the
call site.
