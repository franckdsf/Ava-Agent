# ADR-0030: Domains as vocabularies, and a search names its own field

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

[ADR-0028](0028-a-search-decides-what-counts-as-a-job.md) stopped
`flag:non-technical` rejecting unconditionally, which fixed `/target dentist in
Lyon`. It said so at the time: the fix was correct and incomplete. What it left
behind was recorded in AGENTS.md as the live cost —

> the rest of the taxonomy is still software-shaped, so a dentist search runs
> with nearly every deterministic rule disabled and degrades to `flag:untagged`

— and that turned out to understate the problem in one direction and overstate
the safety in another.

**The saving only ever ran one way.** `NON_TECHNICAL` was a list of what software
is *not*. A software search got the accountants removed; a chemistry search got
nothing removed at all, because nothing in the file recognised an accountant as
an accountant. Every field other than software paid full model price for a
board's entire intake.

**And the ADR-0028 fix was reachable through a back door.**
`describesSoftwareWork` decides whether a search is a software search by matching
the `DISCIPLINES` and `TECHNOLOGIES` vocabularies over the reader's own words.
`DISCIPLINES.ml` contains `research scientist`. `NON_TECHNICAL` contains
`technician`. So:

```
/target research scientist, polymer chemistry
  → "research scientist" matches software's ml vocabulary
  → searchWantsSoftware() === true
  → "Lab Technician — Polymer Analysis" carries flag:non-technical
  → rejected, reason: "not a software role"
```

The exact failure ADR-0028 was written to remove, reintroduced by two overloaded
English words. This is what a keyword-inferred category does: it is invisible, so
nobody can see it or correct it, and it cannot break a tie between two fields
that share vocabulary.

## Decision

**A domain declares what it is, never what it is not.**

`job-taxonomy.ts` becomes a record of `DomainVocabulary` — `software`,
`chemistry`, and seven shallow recognise-and-reject fields (`healthcare`,
`finance`, `sales`, `legal`, `education`, `trades`, `logistics`) plus `people`.
Each lists its own titles. A posting is tagged `domain:<id>` for every vocabulary
its **title** matches, and rejection becomes a set intersection rather than one
field's opinion about all the others.

Three consequences, all of them the point:

- The saving runs in every direction. The accountant is skipped for a chemistry
  search too, which it never was before.
- Ambiguity resolves toward keeping. "Chemical Engineer" matches software's bare
  `engineer` *and* chemistry, holds both domains, and is kept by a search in
  either.
- Adding a field is adding an object literal. Promoting a shallow vocabulary to a
  real one is adding `skills` to it. Nothing else in the codebase changes.

**A search's domain is written by the targeter and stored on the row.**

`job_searches.domain`, nullable, one of `DOMAINS`' keys, validated in
`parseTarget` and dropped to null when the model invents one. ADR-0028 rejected a
stored category on the grounds that it "asks the reader to declare a category
they never mentioned" — and that objection was to the **asking**. The targeter
already parses eleven fields out of one sentence; this is the twelfth. Null is a
common and legal answer meaning "do not filter on this", exactly as an empty
`seniority` does.

The mitigation is the one the targeter's own header already names: `/target`
echoes every field straight back, so a wrong domain is visible in the reply and
saying the target again more plainly overwrites the row. `renderCriteria` shows
it **first**, because it is the coarsest filter there is.

**Domain membership comes from disciplines only, never from skills.** A polymer
advert asking for Python in its body is not a software posting. Skills are tagged
for `rankByCvOverlap`, which may only reorder and never reject.

**Tagging moves from ingest to filter time.** `jobs.derived_tags` was written
once when a posting was stored, so a vocabulary added later described nothing
already in the table — the `seed-beats.ts` trap ("editing it does not reach a
beat that already exists"), and fatal for a pipeline whose premise is gaining
domains over time. Tags are now derived when they are read, memoized per batch;
the column stays as the audit trail of what the vocabulary said that day.

## Consequences

Measured with `pnpm jobs:check` against all four live boards, 300 distinct
postings, on the sample senior-frontend search:

```
domains   software 194, sales 18, finance 4, healthcare 2,
          legal 1, people 1, chemistry 1      untagged 47 (13%)

rejected by domain   24 postings — 16 sales, 4 finance, 2 healthcare,
                     1 legal, 1 people operations, 1 chemistry
```

Each rejection now names both sides: *"looks like a sales role, and you asked for
software"*. Under `flag:non-technical` the reason was the unfalsifiable "not a
software role".

**The measurement immediately paid for itself twice.** `medical` had been dropped
from the vocabulary during the rewrite for fear of catching "Medical Device
Engineer", and *Medical Contact Center Assistant I* promptly survived a software
search; the fear was unfounded under an intersection rule, since that title holds
both domains. And `call center` was in the vocabulary while `contact center` was
not, which boards use interchangeably. Neither was visible by reading the file.
**Run `pnpm jobs:check` after any vocabulary edit** — a term that fails to match
is silent, and silence here looks exactly like a quiet week.

Costs accepted:

- **Bare `engineer` stays in software**, so "Process Engineer" and "Chemical
  Engineer" carry `domain:software` as well as `domain:chemistry`. Harmless under
  intersection, and removing it would drop real adverts titled only "Engineer".
- **The recognise-and-reject vocabularies are shallow on purpose** and will
  mis-tag. The bias is toward keeping everywhere, so a miss costs a model call
  rather than a lost posting.
- **`people` is a tenth domain beyond the nine agreed**, called out in the file
  rather than folded quietly into `sales`. Recruiters and payroll are a large
  share of a general board and belong to neither sales nor finance.
- **A search written before this column exists has `domain: null`** and filters
  on no field until it is re-typed. Deliberate: back-filling it would mean
  guessing a category for a sentence nobody is present to confirm.
