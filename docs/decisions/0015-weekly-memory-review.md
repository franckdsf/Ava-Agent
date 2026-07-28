# ADR-0015: A weekly model-judged review promotes memories, then expires them

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

[ADR-0014](0014-two-tier-memory-for-ava.md) shipped the two tiers and
deliberately did not ship the job that maintains them. Short-term notes stopped
being *shown* after 30 days but were never deleted, so the table grew forever and
the "short" tier was a rendering rule rather than a lifecycle.

The blocking problem was never deletion — it was that deletion alone is lossy.
Ava writes a note the moment she hears something, with no way of knowing whether
it will still matter in a month, and her instructions tell her to prefer `short`
when unsure precisely because a wrong `long` is permanent. That instruction is
only safe if something later re-decides. A blind 30-day sweep would delete "they
started a new job at Acme" alongside "they ate ramen", silently, and nobody would
find out until Ava needed the fact and didn't have it.

The decision the job has to make is not mechanical. "Is this still true of the
person?" cannot be derived from the row: `happenedAt`, tier and text look
identical for a new job and a Tuesday lunch. Only a reader of the sentence can
tell them apart.

## Decision

A weekly workflow, `review-memories`, that asks a model which short-term notes
have turned out to be biography, promotes those, and deletes the expired
remainder.

**The model is a classifier over a fixed row set, and that is a narrow, stated
exception to [invariant 2](../../AGENTS.md#invariants).** The control flow is
fixed — read, one call, write. The model chooses *which rows*, from a set it was
handed, validated against that set on return. It cannot decide whether to run,
what to run next, how many rows to touch, or what a note says. It returns ids and
a reason string; the reason is never stored. This is the same shape as the
ranker, which is the precedent invariant 2 already permits.

**Two steps, because the split is a safety property.** `decide` calls the model,
`apply` writes. A call that throws — or returns something unparsable — fails the
run before `apply` executes, and the notes are all still there next Monday. The
failure mode that had to be designed out is "model returns junk" being
indistinguishable from "nothing was worth keeping", since the second one deletes
everything expired: `reviewMemories` throws on a missing object rather than
returning `[]`.

**Promote, then delete, in that order.** `deleteExpiredShortTerm` matches
`tier = 'short'` only, so a note promoted moments earlier is already out of reach
of the sweep that follows. The ordering is what stops a run from deleting the
note it just rescued.

**Promotion moves a row; it never rewrites one.** `tier` changes, both dates stay.
The reviewer is not allowed to synthesize ("they ate ramen four times" → "they
like ramen") because that is fact *invention* on a schedule with no human in the
loop, and the worst outcome of the design as built is a row in the wrong tier —
recoverable — rather than a fabricated memory presented to the reader as
something they said.

Monday 05:00 `AGENT_TIMEZONE`: after the 04:00 item prune has released its write
lock, before the 08:00 digest. Weekly rather than daily because the question is
"with a month of hindsight, was this biography?" — asking it daily is six more
calls to re-confirm the same answer.

### The prompt is the load-bearing part, and the first version was backwards

Written to be conservative — *"when a note is borderline, let it go"*, *"an empty
list is a normal result"* — the reviewer returned an empty list on all three
runs against the fixture set, which would have deleted a new job and a named
sister.

The cost asymmetry runs the other way and the prompt now says so. Keeping an
ordinary day costs one line in a list that is capped anyway; deleting a fact
about who someone is loses it silently and for good. **When a note could go
either way, keep it** — with one exception, a duplicate of something already
lasting, which is the only borderline case that is dropped.

A second failure survived that fix: told to drop duplicates, the model returned
the duplicate *with a reason explaining it should be dropped* — using the reason
field as a scratchpad. The prompt now states the output contract explicitly:
everything returned is kept regardless of what its reason says.

## Consequences

**Good:** the two tiers finally mean what they claim. Short-term memory is
genuinely bounded, long-term memory grows only through a decision made with a
month of hindsight, and Ava's "prefer short when unsure" instruction is now
backed by something. The reviewer's judgement is inspectable — a run reports what
it promoted, with reasons, and what it deleted, so a bad week is visible in
Studio rather than inferred from a gap in her memory.

**Costs:** a model now deletes user data on a schedule, unattended. The guards
make a *malformed* response safe, but a confidently wrong one is not caught by
anything — a reviewer that judges "their mother died in April" to be a passing
event deletes it, and nothing surfaces that. There is no tombstone and no undo;
the row is gone. It is one more scheduled model call to pay for and one more
prompt to keep calibrated against a model that may be swapped out under it — the
calibration above was measured against `deepseek-v4-flash` and is not
transferable evidence for another model. Promotion is verbatim, so a note phrased
episodically ("their sister Claire is visiting from Lyon") becomes a long-term
fact in that same tense. And the reviewer reads *all* long-term notes as context
on every run, which grows with the memory it is maintaining.

**Revisit if:** something worth keeping is observed being deleted — in which case
the honest fix is a tombstone table or a "quarantine" tier that holds deletions
for a further month, not a better prompt. Or if the reviewer proves reliable
enough to be trusted with synthesis, which is a different ADR and needs the
fabrication risk answered first. Or if long-term notes outgrow one prompt, at
which point the review has to batch and the duplicate check stops being reliable.
