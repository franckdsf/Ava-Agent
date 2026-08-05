# ADR-0028: A search decides what counts as a job, not the taxonomy

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

[ADR-0024](0024-joob-a-job-pipeline-beside-the-news-one.md) built the job pipeline
around one reader who is a developer, and that assumption leaked into a place it
should never have reached: the deterministic filter.

`job-taxonomy.ts` carries a `NON_TECHNICAL` vocabulary — `accountant`, `nurse`,
`medical`, `physician`, `therapist`, **`dental`**, `teacher`, `attorney`,
`electrician`, `driver`. `deriveTags` sets `flag:non-technical` when a posting's
title matches one and claims no engineering discipline. That much is honest
labelling. The problem was the next line, in `filterJob`:

```ts
if (tags.includes('flag:non-technical')) {
  return { keep: false, reason: 'not a software role' }
}
```

**Unconditional, and evaluated before a single search criterion is read.** So
`/target dentist in Lyon` would have every dentist rejected with the reason "not a
software role" — the word `dental` is literally in the reject list. The flag was
killing 43 stored rows at the time of measurement, and no amount of new sourcing
could have changed the outcome: the pipeline held an opinion about which
professions the reader is allowed to want.

This mattered now rather than later for two reasons. The reader stated the
requirement plainly — the pipeline should work across fields and improve with
time. And [ADR-0027](0027-ats-boards-as-discovered-sources.md) had just made it
achievable: an applicant-tracking board is every function an employer hires for,
and the one measured was 18 non-engineering roles out of 19. The sourcing had
stopped being the constraint; the filter had become it.

Two ways not to fix it, and why:

- **Delete `NON_TECHNICAL`.** It is the single biggest saving on a general board
  for the searches that *are* about engineering, and the rejections it produces are
  correct for them. Deleting it spends model calls on private-banking advisers.
- **Add a field to `job_searches`.** A stored "field" or "industry" the targeter
  fills in. That asks the reader to declare a category they never mentioned, adds
  a migration, and gives the model one more thing to get wrong about a search it
  has already parsed once.

## Decision

**The non-technical flag rejects only when the search is itself about software,
judged from the reader's own words.**

`describesSoftwareWork` runs the existing discipline and technology vocabularies
over the search's label, request, must-haves and notes. `/target front end
developer` names a discipline; `/target React and TypeScript, remote` names a
stack; `/target dentist in Lyon` names neither, which is the whole distinction
required. Nothing is stored, nothing is declared, no migration.

`dealbreakers` are deliberately excluded from that read — "no JavaScript" must not
make a search look like a software search on the strength of what it rules *out*.

Stated as a principle: **the taxonomy describes postings, and only a search may
reject them.** A vocabulary is allowed to label a posting a nursing role; it is not
allowed to decide the reader does not want one.

## Consequences

**Good**

- `/target dentist in Lyon` and `/target infirmier de nuit` are now possible at
  all. Verified: dental and nursing postings are kept for those searches and still
  rejected for engineering ones.
- Engineering searches are completely unchanged — the same rejections, in the same
  order, at the same cost. The saving `NON_TECHNICAL` exists for is intact.
- No schema change, no new model call, no new reader-facing concept.

**Costs**

- **The rest of the taxonomy is still software-shaped, and now visibly so.**
  `DISCIPLINES`, `TECHNOLOGIES` and `SENIORITY` know nothing about clinical
  grades, teaching qualifications or trade certifications. A dentist search
  therefore runs with almost every deterministic rule disabled: no discipline
  match, no tech match, no level match. It degrades to `flag:untagged`, which is
  *deliberately* let through to the model — so the behaviour is safe, but a
  non-software search leans on the scorer far more heavily than a software one and
  costs proportionally more per delivered job.
- **`mustHave` is the reader's own words and stays literal.** A dentist search
  setting `mustHave: ["implantologie"]` works exactly as well as `["React"]` does;
  one setting `mustHave: ["dentiste"]` against adverts written in English does not.
  The rule is unchanged and its sharp edge is unchanged with it.
- **A search that names no field gets no protection.** `/target something
  interesting, remote` now keeps the private-banking advisers, because nothing in
  it says software. Correct by this ADR's own logic and worse than before for that
  particular search; `constraintCount` already exists to warn about targets this
  loose.
- **Scoring is still CV-relative.** `rankByCvOverlap` orders candidates by overlap
  with the reader's portfolio, which for a developer's CV against dentistry
  postings is uniformly zero — so the ordering silently degrades to recency. Not
  wrong, but the prioritisation the reader gets on a software search does not
  exist on a non-software one.

**Revisit if:** a non-software search is used in earnest. The first thing to
measure is how much the scorer is being asked to carry alone, and the likely next
step is vocabularies that are themselves data — a `job_taxonomy` table the reader
or the targeter can extend per field — rather than one more hard-coded list that
happens to know about dentistry.
