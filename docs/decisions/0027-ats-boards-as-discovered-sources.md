# ADR-0027: Real postings off applicant-tracking boards, and the boards become sources

- **Status:** Partly superseded by [ADR-0029](0029-six-ats-providers-probed-concurrently.md).
  The design stands; the provider set is six rather than three and the probes run
  concurrently. Its "Revisit if" fired the same day.
- **Date:** 2026-08-06

## Context

[ADR-0026](0026-sonar-as-a-job-source.md) ends with a condition: *"Revisit if leads
prove too thin to clear the fit threshold — the next step is resolving real
postings off the applicant-tracking platforms."* That condition fired, and the
measurement is unambiguous.

On the live run of 2026-08-05 sonar produced six leads — OKX, Blockchain.com,
BitGo, Figure, Remote.com, ASBIS. **All six were rejected by `mustHave` for never
mentioning React or TypeScript**, and on `founding-engineer-worldwide`, which sets
no `mustHave` at all, the same six reached the scorer and topped out at **40/100**.
Zero of six survived either path.

The cause is structural rather than tuneable. A lead's description is its careers
*landing page*, and a landing page is marketing copy — OKX's reads "Build the
Future with Us… Our core values… Global exposure." It cannot name a stack, a
licence or a qualification, because that is not what the page is for. ADR-0026
anticipated the shape of this and answered it with `maxPageChars`, storing 20,000
characters of page text so the filter would have something true to read. That
could not work: the problem is the *kind* of text, not the amount of it.

Two other things surfaced while measuring this, both of which change the arithmetic:

- **Remote OK had stopped returning jobs.** Its free API answers 200 with 100
  entries whose `position` field holds scraped page furniture — `Waitology`,
  `Company Name`, `NO CURRENT OPENINGS`, `15 15`. Two of 100 carried an
  engineering title. It was the largest source in the table, 178 of 526 stored
  rows, and the deterministic filter absorbed all of it silently. Archived under
  the rule ADR-0024 already applied to Arbeitnow.
- **Two sources had never been scored at all.** `listUnscored` ordered the queue
  by `discoveredAt`, which ingest stamped per posting — so the millisecond a
  posting carried was its source's position in a fetch batch, and
  `weworkremotely-fullstack`, alphabetically last in its batch, was permanently
  the newest thing in the table. Himalayas, alphabetically first, had never
  entered a scoring window in any run.

After both fixes the remaining free boards are four, all remote-tech, all thin.
Sonar is the only source that can reach anything else, and it was returning
nothing usable.

## Decision

**Read the employer's actual postings from their applicant-tracking board's public
API, and keep the board as a source row.**

Three providers, chosen by one rule — answers without a key, in one request, with
the full advert body: **Greenhouse, Lever, Ashby**. SmartRecruiters was excluded
because its list endpoint carries no description, requiring a fetch per posting;
Personio because it answered `429` on every request but one, which matters because
it is the European SME tracker and therefore the best route to non-software
employers.

**A board is reached three ways, cheapest first**, and all three earn their place —
measured over the six employers of the live run:

| step | found |
| --- | --- |
| the resolved careers URL *is* a board | 0 of 6 |
| the careers page markup references one (usually an embed script, not a link) | 1 of 6 |
| probe the domain label against the three providers | 4 of the remaining 5 |

Shipping only the first two would have been a feature that never fired. The third
is a guess that **code verifies** — a real 200 carrying real postings is the only
thing that counts, which is the same bargain `careersPaths` already makes and what
[ADR-0020](0020-feed-discovery-from-a-subject.md) requires of anything a model
touched.

**Verified boards are written as `ats` source rows.** This is the pipeline's one
compounding step. Every other cost here is paid again every run — sonar proposes,
code resolves, the lot is discarded. A board is a URL that keeps answering, so
writing it down converts one model call into a source polled for free from then
on, and `knownAtsCompanies` tells the scout to stop proposing employers already
being read.

**And discovered sources decay, which seeded ones do not need to.** A board silent
for `atsIdleDays` (45) is archived and marked `idle`; after `atsForgetDays` (120)
more the row is deleted. The gap between the two stages is load-bearing: while the
row exists the scout skips that employer, so deleting at the first stage would
simply have the next run rediscover the same empty board. A row the reader
archived by hand is never deleted — it records a decision that must outlive the
mechanism.

## Consequences

**Good**

- **Five companies produced 140 real adverts where they had produced five rows.**
  Full text, real per-posting URLs, real locations, real dates — the shape every
  board adapter already emits, flowing through filter, scorer, arbiter and ledger
  unchanged.
- **Domain-general by construction, which no remaining board is.** Figure's
  Greenhouse board was 18 non-engineering roles out of 19 — Chief Credit Officer,
  Account Administration Associate, Business Development Manager. The four surviving
  free boards are remote-tech only and can never answer a search outside software
  (see [ADR-0028](0028-a-search-decides-what-counts-as-a-job.md)).
- **Coverage becomes a function of how long the pipeline has run**, not of what one
  run could afford.
- Free, keyless, no scraping, no terms-of-service problem — these APIs exist to be
  read.

**Costs**

- **Token guessing is a heuristic, and only Greenhouse can be checked.** It
  publishes `company_name`, so a collision — some *other* Figure — is caught.
  Lever and Ashby publish no company name anywhere in their posting API, so a
  board found there rests on the domain label matching and nothing else. Bounded
  only by the reader seeing the employer's own URL on the posting.
- **A board is every function the employer hires for**, so most of what it returns
  is irrelevant to any one search. Intake rises far faster than delivered volume,
  and the deterministic filter absorbs the difference.
- **The table now grows on its own, and needed a second mechanism to stop it.**
  Boards arrive at up to `leadsPerSearch × maxSearchesPerRun` a day; without decay
  that is roughly 450 rows a month, each a request every run. Decay is more moving
  parts in exchange, and its two thresholds are coupled to the run cadence in a way
  nothing enforces.
- **An idled employer is invisible for about five and a half months.** 45 days to
  idle plus 120 quarantined. Correct for "not hiring", wrong for a board that went
  quiet for a quarter and came back.
- **Three providers is not the market.** An employer on Workable, Recruitee,
  Teamtailor, SmartRecruiters or Workday resolves to nothing and falls back to the
  landing page — the weak evidence this ADR exists to replace.
- **Sonar's own weaknesses are untouched.** Proposal instability, ~120s per search
  and the hand-maintained `excludedHosts` denylist all remain exactly as ADR-0026
  recorded them.

**Revisit if:** Personio becomes reachable behind a backoff — it is the single
best route to the non-software employers this pipeline is now meant to serve, and
its absence is the largest remaining gap. Also revisit if the aggregators are ever
reachable: Monster and Indeed both answer **403** to any client, verified
2026-08-06, which is what keeps ADR-0024's exclusion of them true rather than
merely inherited. Adzuna and The Muse do publish usable APIs and are the honest
next source to evaluate.
