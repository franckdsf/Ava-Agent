# ADR-0039: A lead scout with its own budget, and a verification the job scout does not need

- **Status:** Accepted
- **Date:** 2026-08-19
- **Depends on:** [ADR-0038](0038-leads-a-prospecting-pipeline-in-joobs-chat.md),
  which built the pipeline and deferred this source; and
  [ADR-0026](0026-sonar-as-a-job-source.md), whose model-proposes / code-verifies
  discipline this extends.

## Context

ADR-0038 shipped the leads pipeline with one source — the `jobs` table, read
only — on the argument that it costs nothing and reveals what a good lead looks
like before any money is spent. It also predicted the source would be thin.

**Measured against the live table on 2026-08-19, it was thin for a reason nobody
had stated.** 2,229 postings over 21 days produced **39 companies**:

| Source | Leads |
| --- | --- |
| `sonar` (the *job* scout) | the large majority of the 39 |
| `ats-greenhouse-stripe`, `ats-greenhouse-airbnb` | 2 |
| every board — `jobicy`, `weworkremotely`, `remoteok`, `himalayas`, `remotive` | **0** |
| every other ATS board | **0** |

A board can never produce a lead: `jobicy.com/jobs/123` carries Jobicy's host
whoever wrote the advert, and a lead is keyed on the *company's* host. What does
produce leads is the job scout, because
[ADR-0026](0026-sonar-as-a-job-source.md)'s resolver starts at the company's own
homepage and follows a careers link out of it — so when that link stays on-host
(`mindera.com/careers`), the stored posting carries the company's domain.

Which means the finding, stated plainly: **prospecting reach was a function of
`jobScout.maxSearchesPerRun`.** A cap chosen for the job pipeline's cost, in a
config file about jobs, silently governing how many companies the reader could
ever be shown. Nobody decided that; it was a side effect that would have been
invisible until someone wondered why leads had plateaued.

The same measurement found a second defect of the same family. All 211 Hacker
News hiring-thread postings normalised to `ycombinator.com` and collapsed into a
**single lead**, carrying whichever company name arrived first, with 210 other
employers' signals piling in behind it. `news.ycombinator.com` was in neither
`jobScout.excludedHosts` nor `PLATFORM_HOSTS`. Nothing errored.

## Decision

**A `sonar` lead scout with its own model variable, its own prompt, and its own
cap — plus a verification gate the job scout does not need.**

### `leadScout.maxProfilesPerRun`, and why the variable came with code

The cap is the point of this ADR. It is also why the scout was built at the same
time rather than the knob being added on its own: **a variable nothing reads is
the failure [ADR-0036](0036-a-source-may-declare-its-field-and-a-search-may-be-re-read.md)
already recorded**, where a `domain` column added by `ALTER TABLE` sat switched
off behind a data gap for two weeks and 4,685 verdicts while its file's header
called it the single biggest saving in the pipeline.

It is the bound [invariant 2](../../AGENTS.md#invariants) requires of a search
shape — a loop over "every active profile" is only fixed control flow while the
reader has few — and it is load-bearing rather than a tuning knob, exactly as
`jobScout.maxSearchesPerRun` is for the other pipeline. The two may now move
independently, which is the whole point.

### The prompt inverts, so it is a different agent

The job scout spends a full paragraph refusing agencies, staffing firms and dev
shops: *"the reader is being shown who they would actually work for."* For someone
selling a service, **agencies are among the best clients there are** — they
subcontract constantly and they buy repeatedly. A prompt whose central exclusion
becomes an inclusion is not the same prompt with a flag on it.

`sonar-reasoning-pro`, following ADR-0026's measurement rather than re-deriving
it. That comparison scored *verified* pages and found 16/18 against plain
`sonar`'s 11, with plain `sonar` returning substantially the same six small names
every run. Name variety is what a prospecting source lives on, so the failure it
avoids matters more here than it did there.

The portfolio is deliberately **not** in the scout's prompt — only what the
reader sells and who they asked for. The same asymmetry ADR-0024 drew when it kept
the CV out of the job targeter: the portfolio decides how a lead scores once
found, not which companies may be looked for. Putting it here would quietly narrow
prospecting to the industries the reader has already worked in, which is the
opposite of prospecting.

### Three gates, and a stricter rule than anywhere else in the repo

A proposal becomes a row only if all three hold. A failure is **dropped**, never
downgraded to a fallback.

1. **The company's own site answers with real text** — `leadScout.minPageChars`,
   the floor ADR-0026 measured against JavaScript shells.
2. **The company's name appears on that page.** New here, and the gate a model
   cannot fake. A model that invents `acmeskincare.com` lands on a parked domain,
   an SEO squat or an unrelated business often enough to matter, and **every one
   of those answers 200 with plenty of text** — so a length floor alone verifies
   nothing about *identity*. Requiring a company to name itself on its own front
   page is cheap, has almost no false negatives, and turns "this page belongs to
   that company" into a fact established by a server.
3. **The announcement it cited resolves.** A dated public event with no reachable
   page behind it is the invented-need case in its purest form.

Dates are parsed strictly — `YYYY-MM-DD` or nothing. `new Date('2026')` is a valid
January 1st, so a forgiving parse would turn a model's vague answer into a
confidently-dated event; a future-dated event is dropped rather than clamped,
because clamping makes a fabricated date look fresh.

**Why stricter than the job side:** *"is this company hiring"* can be checked
against a careers page. *"Does this company need better photography"* can be
checked against nothing at all. The only defence against an invented need is to be
ruthless about the parts that *are* checkable.

### `NOT_AN_EMPLOYER_HOSTS`

Communities and aggregators — `ycombinator.com`, `reddit.com`,
`workatastartup.com` and their like — whose postings are *about* employers rather
than *by* them. A leads-side list, deliberately **not** an addition to
`jobScout.excludedHosts`: that list is read by the job scout to decide which
companies it may propose, and extending it would change what the job pipeline
does.

## Consequences

**Good**

- Prospecting reach is now set by a number chosen for prospecting. Tuning the job
  scout's cost cannot silently move it, in either direction.
- The scout reuses the one resolver shape that measurably produces leads, rather
  than inventing a second way to find companies.
- The name gate closes the failure that a text floor cannot see — a real page
  belonging to the wrong company — which is the specific way a prospecting scout
  fails that a hiring scout does not.
- 211 Hacker News postings are no longer one lead, and there is a check that keeps
  it that way.

**Costs**

- **Two extra fetches per proposal** — the homepage and the announcement — so a
  scout pass costs more requests than the job scout's, which fetches one homepage
  and then hunts. Bounded by `maxProfilesPerRun × prospectsPerProfile`.
- **The name gate will drop real companies.** A rebrand where the site already
  carries the new name and the model still knows the old one fails it, silently,
  and looks identical to an invented company. Accepted deliberately: the failure
  direction is a lost lead rather than a fabricated one, and only one of those
  costs the reader their credibility with a stranger.
- **Profiles are searched in list order**, so a reader with more profiles than the
  cap gets the same ones searched every run. A rotation is the obvious fix and is
  deliberately not guessed at here — untested either way until someone keeps more
  profiles than the cap.
- **`NOT_AN_EMPLOYER_HOSTS` is a list, and lists are wrong until extended.** An
  aggregator not on it merges every company it mentions into one lead, silently,
  exactly as Hacker News did.
- **The strict date parse throws away usable leads** whose announcement carried
  only a month. Chosen over the alternative, where a vague date becomes a precise
  wrong one and recency ordering quietly ranks it.
- **Nothing here verifies the need.** Every gate above establishes that the
  company and the event are real. That the event *implies* the reader's service is
  still a model's judgement, and it always will be.

**Revisit if:** the scout's drop rate is high enough to suggest the name gate is
misfiring — the reasons are logged per run, so the first thing to do is read them
rather than loosen the gate. Also revisit when a reader keeps more client profiles
than `maxProfilesPerRun`, which is when order-based selection stops being fair and
rotation has to be decided.
