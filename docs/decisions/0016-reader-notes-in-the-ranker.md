# ADR-0016: The ranker reads Ava's notes about the reader

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

The ranker had one signal about the person it ranks for: `renderInterestProfile`,
built from the 👍/👎 table. That table has never had a row — the reaction handler
is still unwired ([AGENTS.md](../../AGENTS.md#where-work-stopped)) — so in
practice every ranking run since the first has scored on the rubric alone, and
the "reader interest profile" heading has carried the string *"No feedback
recorded yet."*

Meanwhile the reader acquired a way to state a preference in words. ADR-0014 gave
Ava a `memories` table and a `remember` tool; the reader can now say *"I want more
about running models locally and less about funding rounds"* in the Chat tab and
have it written down, dated, and kept. That sentence is a far better ranking
signal than a thumb — it is explicit, it names the subject rather than an
instance of it, and it exists from the first conversation instead of after twenty
articles have been rated. It was going nowhere: `memories` was read by Ava's
prompt and by the weekly review, and by nothing in the pipeline.

Two designs were rejected before this one.

**Waiting for the 👍/👎 loop.** It is the signal originally designed for this and
it is a handful of lines away. But it answers a different question — *was this
article good?* — and it can only ever teach the ranker about patterns it has
already sent. A reader who wants a subject the pipeline has never surfaced cannot
express that with a thumb, because there is nothing to press it on.

**Feeding the article writer too.** The writer's output goes to Telegram, so a
note about the reader's stack could have calibrated how much a summary explains.
Rejected as a separate decision: this one is about *which stories get sent*, the
writer is about *how one reads*, and bundling them would have meant a prompt
change with no measurement behind it in the same commit as one with.

## Decision

**The `rank` step reads `memoriesForCuration()` and renders it into the prompt
under "What is known about the reader", beside the vote profile.** Same rows, same
tiers, same dates, same oldest-first ordering the conversational prompt uses, at
their own caps in `memoryConfig` — the ranker gets less than Ava does, for signal
rather than cost.

**The ranker's instructions separate two kinds of note, because the model already
treats them differently and the split turned out to be measurable.** A note where
the reader *said what they want* — more of a subject, less of one, that something
is or is not part of their work — is an instruction, applied hard and applied only
to the items it names. Everything else is background, and only breaks ties
between items the rubric already scores alike. Background alone is never a reason
to move a score.

**Notes are data, and data is English.** A note may record that the reader writes
in French and expects *vous*; that governs Ava's replies and nothing else. The
ranker is told to score and to write every `reason` in English whatever language
a note is in, and Ava is told to write every note in English whatever language the
conversation is in. The French is a facade on the one surface a human reads.

**A read, never a write.** Nothing in the pipeline writes to `memories`, and the
notes cannot reach the ranker except through the reader telling Ava something.

### Verified

Against a copy of the live database, seeded notes, real items, the real ranker
model, three runs per condition — because one run of a cheap model proves nothing
here, which [ADR-0015](0015-weekly-memory-review.md) already learned the hard way.

The first measurement nearly shipped a false positive. Adding the notes moved 11
of 14 scores, which reads as a working feature until you measure the model's own
spread on *identical* input: **10.0 points**, in both conditions. Almost every
delta was inside it, and the two that were not pointed the wrong way. Nothing had
been demonstrated.

Isolating the mechanism settled it — same batch, one note flipped between *"CI
and supply-chain security tooling are not part of his work"* and *"he works on
them and wants as much as possible"*:

| | mean shift |
| --- | --- |
| The 2 items that note names | **+80.0** |
| The 12 it does not | +5.3 |
| Model's own spread on identical input | 10.0 |

So the block is not decoration, and it is not a smear: a stated preference moves
what it names by eight times the noise floor and leaves the rest of the batch
inside it. Passive biography ("a senior TypeScript developer", "brown eyes") does
**not** reliably move anything — which is the intended behaviour, not a
shortfall.

Also held across all six ranking runs: every item scored, every subtopic valid,
every `reason` in English despite a lasting note saying the reader writes in
French, and no `reason` mentioning the reader or their notes. One run hallucinated
an id — in the *without-notes* condition, so it is the model's pre-existing wobble
rather than anything this adds, and the `representativeIds` filter in `rank`
already drops it.

## Consequences

**Good:** the ranker has a usable signal on day one instead of after the 👍/👎
loop is wired and enough thumbs have accumulated. The reader steers their own
digest in the language they already talk to Ava in — *"less about funding
rounds"* is a sentence, not a feature request. Because notes are dated and never
rewritten ([ADR-0014](0014-two-tier-memory-for-ava.md)), a preference that changes
supersedes rather than conflicts, and the ranker reads the timeline the same way
Ava does. No new table, no new model call, no new schedule: one indexed read on a
step that was already making an LLM call.

**Costs:** an offhand remark is now load-bearing. A sentence recorded as a lasting
note reshapes the digest by ~80 points on the subject it names, for months, and
there is **no surface anywhere that says why an article stopped arriving** — the
reader sees a quieter digest and nothing else. `recall-memories` and
`forget-memory` are the only way back, and they require knowing to look. This is
the sharp edge of the whole change and it points at the reader's own words, which
is the best case for a sharp edge but does not make it blunt.

The pipeline also now reads a table the conversational surface writes, which is a
real narrowing of [invariant 8](../../AGENTS.md#invariants): before this, Ava
could not influence the pipeline at all, and the invariant's justification said so
in as many words. She still cannot trigger, re-send, or re-rank anything — but
what she writes to `memories` changes what the next run scores, and that edge did
not exist yesterday. The invariant has been amended rather than quietly outgrown.

Two smaller ones. Every ranking run now carries up to 60 lines of biography in
front of ~100 items, six times a day — negligible against the items, not zero.
And the ranker's prompt now depends on wording in Ava's prompt: if she stops
writing notes in English, or starts recording conclusions she drew from what the
reader read rather than what they said, the ranker degrades with no error
anywhere.

**Revisit if:** the 👍/👎 loop ships and the two signals disagree — the vote is
evidence about an article the reader actually saw, the note is a claim about
themselves, and this ADR does not settle which wins. Or if a note is found to have
silently suppressed a subject the reader still wanted, in which case the answer is
a surface that shows *which notes moved this digest*, not a weaker prompt. Or if
ranking moves to a model whose run-to-run spread is small enough that background
notes stop being lost in it, which would make the instruction/background split
worth re-measuring rather than assumed.
