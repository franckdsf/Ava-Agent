---
id: 0040
applies_to: ["src/services/job-scout.ts", "src/services/page-fetch.ts", "src/config/jobs.ts"]
status: accepted
supersedes: ["0026"]
verify: "pnpm sonar:check"
---

# ADR-0040: A careers page with nothing on it is a lead, not a job

- **Status:** Accepted
- **Date:** 2026-08-20
- **Extends:** [ADR-0026](0026-sonar-as-a-job-source.md), which built the resolver
  and settled that a model may name a company but not a URL. This adds the gate
  ADR-0026 did not have, and sends what fails it to
  [ADR-0038](0038-leads-a-prospecting-pipeline-in-joobs-chat.md)'s pipeline.

## Context

The reader reported it, and it is the plainest kind of bug report: *a job arrives
from Joob, the link opens the company's site, and there is no such opening on the
careers page.*

Both halves turned out to be true, from two independent defects.

**One: the link was often the homepage.** `page-fetch.ts` fetches with
`redirect: 'follow'` — correct, a careers page behind a 301 is still a careers
page — but it returned only `{ html, ok }`. The final URL was discarded, so the
caller stored *the URL it had asked for* while holding *the bytes it was
redirected to*. Ten of the eleven `careersPaths` are guesses, so this fired
constantly. Measured 2026-08-20, live: `https://www.doctolib.fr/careers` answers
**200 with a final URL of `https://www.doctolib.fr/`** and 1.6M characters of
homepage — which sailed past `minPageChars`, was stored as a verified careers
page, and gave the homepage's own marketing copy to the filter as the evidence
that verified it.

**Two: nothing ever asked whether the page had jobs on it.** ADR-0026's resolver
establishes that a page exists, is reachable, resolves from the company's own
homepage and carries real text. None of that is a claim that anybody can apply
for anything. A "we're always looking for great people" page clears every one of
those gates. It then reaches the reader as a job — under a *title the model
wrote*, because a lead's title is `lead.role`, a phrasing of a role that was never
verified to be advertised anywhere.

The second is the interesting one, because the first is just a bug. A model said
"Acme is hiring frontend engineers"; the pipeline verified **Acme**, and delivered
it as though it had verified **the frontend engineer role**.

## Decision

**A resolved careers page is counted before it is trusted.** `listedRoleLinks`
counts the links on it that lead to an individual advert rather than to the list,
and the count is stored on the row as `jobs.listed_roles` — null for every board
posting, because a board's row already *is* one advert and the question does not
apply to it.

- **`listed_roles > 0` → delivered as a job**, exactly as before. Deliberately
  including the case where the model's claimed role is *not* among them: a page
  with real openings is worth opening whether or not it holds the one that was
  promised. The reader said so directly, and it is the same keep-on-ambiguity
  bias every other rule in `job-filter.ts` already has.
- **`listed_roles === 0` → stored, never sent.** `filterJob` rejects it first,
  before any model is paid to score it.

**And the row that is never sent is exactly how the company reaches the Leads
tab.** `hiringSignalsFromJobs` reads the `jobs` table and turns any row whose URL
carries the *company's own* host into a `hiring` signal — which is what a resolved
careers page always is. So a company that is hiring but publishes nothing
resolvable stops being a broken job and becomes what it actually is: a prospect,
with a verified careers page as the evidence, in the pipeline built for prospects.

**No new plumbing was needed for that, and that is the point.** The obvious
implementation — have the jobs workflow write into `lead_signals` — would couple
two pipelines that currently share one direction of read and nothing else. Storing
the row and declining to send it uses the harvest that already exists.

**A hand-off to a careers *site* counts as somewhere to go.** Brillio's
`/careers/` draws its listings client-side and links to no advert, but it links to
`careers.brillio.com/job-listing/` — which is where a reader goes and finds one.
So an off-host link that `looksLikeCareers` counts as one. Off-host only: a
same-host `#jobs` anchor is the page pointing at itself, which is exactly what
Monks and Software Mind do. `excludedHosts` is subtracted, because Brillio also
links to `linkedin.com/company/brillio/jobs/` and a marketplace's listings are
other people's jobs on someone else's terms.

Separately: `page-fetch` now returns `finalUrl`, and the scout re-tests it with
`looksLikeCareers`. A redirect to `/en/careers` still passes; a redirect to the
front page does not.

## Measured

Three `pnpm sonar:check` runs, 2026-08-20, plus direct probes of the pages they
resolved:

| Page | Links | Outcome |
| --- | --- | --- |
| `vercel.com/careers` | 83 | job |
| `qonto.com/en/careers` | 27 | job |
| `backmarket.com/…/careers/home` | 13 | job |
| `careers.papernest.com` | 11 | job |
| `stackbuilders.com/careers/` | 7 | job — its Workable board and six `/j/` adverts |
| `brillio.com/careers/` | 1 | job — the off-host hand-off, LinkedIn ignored |
| `monks.com/careers` | 0 | **lead** — links `#c36-job-finder`, itself |
| `softwaremind.com/careers/` | 0 | **lead** — links `/careers/#jobs`, itself |
| `swile.co/careers` | 0 | **lead** — 209k chars, listings drawn client-side |
| `careers.doctolib.fr` | 0 | **lead** — 1.77M chars, listings drawn client-side |

The third run rejected nothing at all: six of six resolved pages listed roles. So
the rule is not a blanket cull of the source — it separates two populations, and
the one it moves is the one that was arriving broken.

## Consequences

- **A careers page whose listings are rendered in JavaScript reads as zero.**
  Measured on live sites the same day: Swile's careers page returns 209k
  characters and links to no advert at all, because its listings are drawn client
  side. Swile becomes a lead instead of a job. This is a real loss of job
  coverage, accepted for two reasons: the reader cannot see those listings from
  the fetched markup either, so the delivered job would have been the same broken
  link; and the company is not thrown away, it changes tab. The upstream ATS
  detection already catches the common shape of this — Alan's careers page counts
  zero links but carries `jobs.ashbyhq.com/alan`, and `leadToPostings` reads that
  board and produces real adverts long before this rule is consulted.
- **The count over-counts on purpose.** `/careers/emerging-talent` is a content
  page and is counted; Stripe scores 3 on links that are not adverts. The number
  is only ever read as *"did this page offer anywhere to go"*, and a page offering
  a department to browse is on the keep side of that question. **It is a boolean
  wearing a number's clothes** — nothing anywhere compares it to a threshold, and
  the moment something does, this note stops being true.
- **A stricter resolver resolves less.** Requiring the *final* URL to look like a
  careers page will drop sites that redirect their careers path somewhere
  unrecognisable. Those companies fall out of the job pipeline entirely rather
  than becoming leads — a resolution that fails produces no row at all. That is
  the pre-existing behaviour for an unresolvable lead and it is not made worse
  here, but it is the one path where the change costs a company outright.
- **The `sonar` source's yield is not affected.** `yieldOfSources` counts from
  `job_matches` and excludes `FILTERED_BEFORE_SCORING`, so a posting rejected by
  this rule leaves both sides of the ratio. A rule that quietly pushed a seeded
  source under `minYieldRate` and archived it would have been a bad way to find
  this out.
