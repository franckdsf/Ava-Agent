---
id: 0026
applies_to: ["src/services/job-scout.ts", "src/mastra/agents/job-scout.ts", "src/config/jobs.ts"]
status: amended
supersedes: []
verify: "pnpm sonar:check"
---

# ADR-0026: Sonar as a job source, keyed on the page it resolves

- **Status:** Accepted — extended by [ADR-0040](0040-a-careers-page-with-nothing-on-it-is-a-lead.md), which adds the gate this one lacks: a resolved careers page must list something.
- **Date:** 2026-08-05

## Context

Joob reads nine free job boards. [ADR-0024](0024-joob-a-job-pipeline-beside-the-news-one.md)
already recorded what that costs: LinkedIn and Indeed are out because they killed
their feeds and block scrapers, Remotive's free endpoint carries 31 postings in
total, and *"the reader cannot tell a quiet week from a blind spot."* The employers
who never list on a free remote board — smaller product companies hiring through
their own site — are invisible, and no amount of tuning the boards reaches them.

That ADR also specified the way past it, and left it unbuilt:

> **`sonar`** — `perplexity/sonar` proposes **companies hiring**, and code resolves
> the careers page. Same discipline as the beat scout: never take a URL from the
> model, because a wrong one never errors.

`kind: 'sonar'` has been in the `job_sources` enum since `0015`. This builds it.

## Decision

**One sonar search per active `/target`, on the scheduled job run, with every URL
established by code rather than by the model.**

The model is asked which companies are hiring for a search and answers with a
company, a role, a homepage and one line of why. Nothing in that answer is stored.
`services/job-scout.ts` then fetches the homepage, follows a careers link out of
it or tries well-known paths, and requires a real 200 carrying real text. Only
that verified URL is written. A lead that resolves nothing is **dropped**, not
stored with the homepage as a fallback — the homepage is not a careers page, and
an unverifiable lead is exactly the one most likely to have been invented.

### Invariant 2 was already wrong, and is now a shape rather than a list

The stated invariant was *"on a schedule, only ranking, composing and the weekly
memory review call a model."* That has been false since the weekly feed review's
`topUp` step landed: it runs on a cron, starts `discoverFeeds`, and that calls the
`sonar`-backed beat scout. Nobody updated the sentence, and nothing failed —
which is the argument against enumerations. An enumeration goes stale silently.

The invariant now names two permissible *shapes*, and the search shape carries a
condition the classifier shape does not: **a bounded loop**. A loop over "every
active search" is only fixed control flow while the reader has few searches;
without a cap the cost of an unattended run grows every time they type `/target`.
`jobScout.maxSearchesPerRun` is that cap and is load-bearing, not a tuning knob.

### The careers page's own text becomes the lead's description

This is what decides whether the feature works at all, and it was nearly missed.

`filterJob` reads `mustHave` out of title + company + description, and *"never
mentions X"* is already the largest rejection reason on live intake (211 of 437).
A lead described only by the model's one-line "why" is rejected by that rule
almost every time — so the source would have delivered nothing while every counter
said it ran. Real page text is what gives the filter something true to read.

**The model is deliberately not asked to write a richer description instead.**
`mustHave` is a hard filter, and a model writing "React" into a field a hard
filter reads means a lead can pass on invented evidence. Same argument as *ask a
model for sites, never for feed URLs* — the model supplies prose, the web supplies
facts.

A `minPageChars` floor rejects pages that render their listings from JavaScript
and return a shell of nav and footer. Those fetch fine and answer 200 and carry no
evidence, and a lead built on one is judged by the scorer on its prior about the
company rather than on anything read. This is the one place in the job pipeline
where discarding on ambiguity is right, because the lead was never evidence.

### A lead is keyed on its careers URL and nothing else

`jobIdentity` hashes company + title + location. Every one of those is a board's
own string for a board posting, and **none of them is a fact for a sonar lead** —
the title and company are a model's phrasing, and the location does not exist.
Keyed the usual way, one lead takes a new identity every run, `job_deliveries`
never recognises it, and the reader is sent the same company every ~44 hours.

The first version of this ADR keyed a lead on company + URL. **Measured over three
live runs, that was still wrong:** the same employer at the same resolved URL came
back as `Apify` and as `Apify Technologies s.r.o.`, which hash differently —
`normalizeCompany` strips `technologies` but has no entry for the Czech `s.r.o.`,
and `normalizeForIdentity` turns its dots into spaces, giving `apify` and
`apify s r o`. Extending the suffix list is the obvious fix and the wrong one: it
is unbounded, every jurisdiction has its own form, and it treats a model's word
choice as evidence.

So the key is the verified URL alone. It is the one part of a lead that code
established, and it is exactly what the reader is sent — so *"have they seen
this?"* and *"is this the same URL?"* are the same question. Verified: `www.`, a
trailing slash and a query string all collapse to one identity, `/about` does not
collide with `/careers`, and the month still rides on top through `leadId` so
`redeliveryGuardDays` is unaffected.

### The model is `sonar-reasoning-pro`, which is not what the beat scout uses

Measured 2026-08-05, five Perplexity models × 3 runs on one search, scoring
**careers pages that survive the filter** rather than companies proposed — the
same discipline ADR-0020 used when it scored verified feeds rather than proposed
sites, and for the same reason: proposed is a number the prompt sets.

| model | survived / 18 | distinct companies | mean |
| --- | --- | --- | --- |
| `sonar-reasoning-pro` | **16** | **12** | 90s |
| `sonar` | 11 | 6 | 49s |
| `sonar-pro` | 11 | 8 | 52s |
| `sonar-pro-search` | 9 | 8 | 13s |
| `sonar-deep-research` | 9 | 5 | 202s |

**The count understates the gap.** `sonar-reasoning-pro` named Vercel, Linear,
Supabase, Grafana Labs, Sentry, Productboard and Doist — real product employers
that hire remote senior frontend engineers in Europe. Plain `sonar` returned
substantially the same six small names every run. `sonar-pro` twice returned a
*description* where a company name was asked for — `Unnamed Austrian SaaS
platform company` and `thePlatform (Application Observability product company)` —
which the prompt forbids explicitly, and both still "survived" because they
resolved to some page. Survival count alone does not capture name quality.

**This is the opposite of ADR-0020's answer, and the tasks differ.** "Name sites
that publish about X" is a recall problem where a bigger model spends its extra
capacity inventing plausible domains — which is exactly how `sonar-pro` produced
`chefpjacooks.com` there. "Name employers hiring for this stack, in this region,
right now" is a harder retrieval problem, and the reasoning variant is measurably
better at it. Neither choice may be copied to the other without re-measuring.

The `</think>` truncation this repo documents for reasoning models did not appear
in 15 runs, and it degrades safely regardless: `proposeCompanies` returns an empty
list, so a malformed response costs that run's leads and nothing else.

**Weaker evidence than it looks.** One search, three runs. ADR-0020 used three
subjects. The 16-vs-11 gap is wide enough to act on, but a second search would
strengthen it, and the ±10 caution applies.

### It does search — and what it searches corrects ADR-0024's rationale

Probed directly against the OpenRouter API on 2026-08-05, because "a model that
claims to search" and "a model that searches" are not the same thing and the
difference is invisible in the output:

- **Citations come back**: 10 for `sonar`, 15 for `sonar-reasoning-pro`, all real
  URLs.
- **A json-schema `response_format` does not suppress the search.** This was the
  live worry — Mastra sends one for every structured call, and if it had disabled
  the search tool the job scout would have been answering from training data all
  along. Citation counts were identical with and without it.
- **Both models stated today's date correctly** and named a real current Vercel
  posting, which training data cannot supply.

**But look at what it cites**, because this is the part that matters:

```
linkedin.com/jobs/view/senior-frontend-engineer-typescript-react-at-arc-dev-…
reactjobs.io/location/europe
remoterocketship.com/country/europe/jobs/frontend-developer/
indeed.com/q-senior-frontend-engineer-react-typescript-remote-jobs.html
workingnomads.com/remote-react-jobs
remotive.com/remote/jobs/software-development/…
```

**Sonar is reading job boards** — including `remotive.com`, which is already one
of our own nine sources. ADR-0024 justified this source as reaching *past* the
free boards to "employers who hire through their own site", and that is only
partly what happens. It also explains `arc.dev` exactly: there is a LinkedIn
posting titled *"Senior Frontend Engineer (TypeScript, React) at Arc.dev"*, and
the model read the intermediary as the employer.

The honest justification is narrower and still worth having: **sonar reads the
boards this pipeline cannot ingest directly.** LinkedIn and Indeed are out of
scope for a scraper by deliberate decision, and `reactjobs.io`,
`remoterocketship.com` and `workingnomads.com` are simply not wired. Reaching
their content through a search index is legitimate coverage the nine boards do
not provide — and it demonstrably surfaces employers they do not carry: Archlet,
RoomPriceGenie and Factor Eleven all came back on a verification run and appear on
none of our sources.

What it is **not** is a way to discover employers who advertise nowhere but their
own careers page. Nothing in the citations suggests it finds those, and a future
argument for widening this source should not assume it does.

One consequence worth acting on: because sonar reads boards we already ingest,
some leads are duplicates of postings the pipeline has by other means. The
month-keyed dedupe does not merge them — a lead is keyed on a careers URL and a
posting on company + title + location — so the reader can in principle see the
same role twice, once as a board posting and once as a careers-page lead. Not
observed yet, and worth watching.

### It is a row, so it can be switched off

`sonar` is seeded into `job_sources` like any board. Archive the row and the
scheduled model call stops, with no code change and no redeploy. Its `url` field
holds the model id rather than an endpoint, because nothing fetches it — the query
is built per search at run time, and a URL there would be a lie about where the
postings come from.

Its fetch signature differs from every other source's: it needs a `mastra` handle
and the active searches, which a function taking only a row cannot have. `findJobs`
routes `kind === 'sonar'` to `fetchSonarSource` and records the result on the row
identically. Hiding that behind a lowest-common-denominator interface would make
the one source with real dependencies look like the eight without any.

## Consequences

**Good**

- Reaches employers who hire through their own site and appear on no free board —
  the coverage gap ADR-0024 recorded as this pipeline's main cost.
- Nothing a model asserts is stored. A company that does not exist yields no lead,
  every run, rather than a row pointing at a 404.
- Leads flow through the existing filter, scorer, arbiter and ledger unchanged. No
  migration, no new table, no second delivery path.
- Switchable off by archiving one row.

**Costs**

- **A careers page is weaker evidence than an advert.** *"This company's careers
  page mentions React"* is not *"this posting requires React"*. Real and honest,
  but weaker, and the scorer is reading a company page rather than a job.
- **One lead per careers page per month.** Two openings at one company reach the
  reader as a single link. Intended, but it means a second role at a company
  already sent is invisible until the month key turns over.
- **Marketplaces needed a deterministic denylist, because the prompt rule was
  obeyed zero times out of six.** `arc.dev` was proposed *and survived the filter*
  in every run of both measured models, resolving 12k characters that tagged
  Angular, Python, Java, Ruby, C++, AWS, GCP and Azure — and `maxPageChars` makes
  that worse, since `mustHave` scans the whole page and a marketplace listing
  every stack passes every stack filter. `jobScout.excludedHosts` is the guard;
  the prompt rule is kept as a hint only. **The denylist is maintained by hand and
  will go stale** — a new marketplace is invisible until someone adds it.
  `greenhouse.io`, `lever.co`, `ashbyhq.com` and `personio.com` are deliberately
  *not* on it: `archlet.jobs.personio.com` is a real employer's real careers page
  and the best thing resolution finds.
- **Sonar is the first source producing undated postings.** `undated` was zero
  across all nine boards, which made `job_deliveries` belt to a brace that was
  already holding. It now genuinely carries the weight, exactly as designed.
- **Resolution is slow and lossy.** ~120s per search for six leads, and 3–5 of 6
  resolved across three runs. The run is unattended so duration is not the risk;
  the loss is, and a miss is invisible unless someone reads the counter.
- **The proposal set is unstable between runs.** Only three of six companies
  recurred across three runs on one search. This behaves like the ±10 ranking
  noise floor: a single run tells you whatever you want to hear.
- **A scheduled model call now has a cost that scales with a cap rather than with
  nothing.** `maxSearchesPerRun` must be revisited whenever the reader's search
  count grows, and it silently starves the newest searches when it binds.

**Revisit if:** leads prove too thin to clear the fit threshold — the next step is
resolving real postings off the applicant-tracking platforms (Greenhouse, Lever,
Ashby, Workable expose public JSON per company), which would give genuine titles,
locations and per-posting URLs at the cost of a slug-guessing resolver and four
more adapters. That was considered here and deferred as materially bigger.
