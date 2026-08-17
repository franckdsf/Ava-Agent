# ADR-0035: A source is judged on what it yields, not on whether it answers

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

Fourteen days of live running produced a table with one clear finding: **the
pipeline had no way to notice a source that was useless but healthy.**

Every mechanism for switching a source off keyed on *silence*.
[ADR-0027](0027-ats-boards-as-discovered-sources.md) gave discovered ATS boards
`atsIdleDays`, which archives a board whose `emptySince` is 45 days old. A seeded
board had nothing at all. Both are answers to "has this stopped responding?", and
neither has an opinion about a board that responds perfectly and returns nothing
worth reading.

That is the failure that actually happened, twice.

Remote OK was caught by hand on 2026-08-06: 100 entries of scraped page furniture
per fetch, 200 OK every time, `emptySince` permanently null. It was the largest
source in the table at 34% of stored rows, and the deterministic filter absorbed
all of it in silence — the reader saw nothing wrong because nothing wrong ever
reached them. It went unnoticed for two runs and would have gone unnoticed
indefinitely.

The second was never caught at all until this measurement. Over 4,685 scoring
verdicts:

| source | slots spent | cleared the bar | rate |
| --- | --- | --- | --- |
| weworkremotely-fullstack | 106 | 21 | **19.8%** |
| sonar | 334 | 64 | **19.2%** |
| weworkremotely-frontend | 26 | 8 | **30.8%** |
| himalayas | 137 | 2 | 1.5% |
| **jobicy** | **427** | **5** | **1.2%** |

Jobicy alone consumed **32% of every scoring slot the model has ever spent** and
produced five postings at 60 and none at 80. `maxJobsPerScoringRun` is the
scarcest resource in this pipeline — one search saturates it every run and carries
a 423-posting backlog — and a third of it was going to a board measurably
incapable of producing a match.

## Decision

**A source is archived when too small a share of the postings it costs the model
reach the reader's own bar.** `jobScout.minYieldRate` (3%) over at least
`jobScout.minYieldSample` (50) scored postings, measured since the reader last
changed what they want.

Four things about the shape, each of which was tested against the real table
rather than chosen for tidiness.

**A rate, not a count.** The obvious rule — "archive a source that has never
produced a good posting" — was measured and gets *both* halves wrong. It spares
jobicy, which has two postings at 70 out of 427 and therefore passes. And it
archives `ats-lever-3pillarglobal`, `ats-ashby-owner`, `weworkremotely-backend`
and `weworkremotely-devops`, all four of which have **delivered jobs to the
reader**. As a rate the separation needs no careful tuning: good sources sit at
11.5–13.2%, bad ones at 0.5–0.7%, and there is a sixteenfold gap with nothing in
it.

**The denominator is slots spent, not postings fetched.** A source returning a
thousand adverts the deterministic filter rejects has cost one HTTP request and
some regex. What is scarce is the scoring batch, so that is what is counted;
`FILTERED_BEFORE_SCORING` verdicts are excluded, or the measure would become
"postings we declined to pay for", which is the opposite of the question.

**The bar is `search.fitThreshold ?? defaultFitThreshold`, never a second
constant.** A separate number here would be free to drift above the delivery
threshold, and the pipeline would then archive sources for producing postings it
was at the same moment sending to the reader. This was a live risk: 70 was
proposed, `defaultFitThreshold` is 60, and four delivering sources have never
produced a 70.

**A minimum sample, counted in postings rather than days.** `ats-ashby-posthog`
has three scored postings and two of them cleared 80. Without a floor, a board
with one bad posting reads as a 0% source and is archived on its first day. A
count rather than a calendar because a board returning four postings a week
deserves the same evidence as a busy one.

### The reset

**The record restarts when the reader changes what they want.** `job_searches`
gains `criteriaChangedAt`, stamped by `saveSearch` on every write, and the yield
window starts at the latest such stamp across active searches.

Without this the rule is actively harmful. A board is judged on its yield, yield
is measured against the reader's bar, so moving that bar invalidates the evidence.
Retarget from software to chemistry and every software board's history becomes a
measurement of a question nobody is asking — and the rule would then archive good
boards for failing a test they were never given.

Deliberately blunt: *any* criteria change restarts *every* source. Sources are
shared by all searches, so "which boards did this change invalidate?" has no
honest answer short of all of them, and erring toward a longer amnesty is the
safe direction — the cost of waiting is a few cheap requests, the cost of being
wrong is a good board switched off.

`createdAt` could not serve. It survives a re-target on purpose: the reader has
been looking for this since March whatever words they used last.

### Status, and why it is not `idle`

An automatically archived board is marked `unproductive`, not `idle`.
`decayAtsBoards` **deletes** an `idle` row after `atsForgetDays` so the employer
becomes discoverable again — right for "not hiring", which is a fact with a shelf
life. Being bad at serving this reader is not, and re-discovering jobicy in four
months to re-learn the same lesson is exactly the loop that deletion rule exists
to prevent. A different status keeps it out of that `DELETE`.

## Consequences

Applies to **every** kind, not just `ats`. A seeded board is not privileged: the
seed is nine rows a human chose once, and two of them are measurably the problem.

**The archive is announced.** `decayAtsBoards` idles a board nobody chose to add,
so it is silent; this can switch off a seeded source the reader is expecting to
hear from, and a chosen board going quiet with no explanation is indistinguishable
from the pipeline breaking — which is precisely what Remote OK produced. The
notice carries the numbers rather than a verdict, because a reader who disagrees
needs the sample size to disagree usefully.

`pnpm jobs:check` prints the table the decision is made from, before it fires. A
rule that switches sources off silently needs readable evidence in advance — the
same argument `pnpm review:check` makes on the news side.

The cost is that a genuinely good source having a bad fortnight can be archived.
Accepted because it is recoverable in one row and the alternative is measured: a
third of the model budget spent on nothing, indefinitely, with no mechanism that
could ever notice.
