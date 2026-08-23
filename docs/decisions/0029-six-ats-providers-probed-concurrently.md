---
id: 0029
applies_to: ["src/services/ats.ts"]
status: accepted
supersedes: ["0027"]
verify: "pnpm jobs:check"
---

# ADR-0029: Six applicant-tracking providers, probed concurrently

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

[ADR-0027](0027-ats-boards-as-discovered-sources.md) shipped three providers and
listed two things as costs of stopping there:

> **Three providers is not the market.** An employer on Workable, Recruitee,
> Teamtailor, SmartRecruiters or Workday resolves to nothing and falls back to the
> landing page — the weak evidence this ADR exists to replace.

> **Revisit if:** Personio becomes reachable behind a backoff — it is the single
> best route to the non-software employers this pipeline is now meant to serve,
> and its absence is the largest remaining gap.

Both conditions were tested against the live APIs on 2026-08-06, prompted by a
list of roughly fifty trackers. **The list was not the constraint and never could
be** — the selection rule in `services/ats.ts` is *keyless, one request, full
advert body*, and it is what decides. Nine candidates were probed:

| Provider | Result |
| --- | --- |
| **Workable** | Passes. `apply.workable.com/api/v1/widget/accounts/{token}?details=true` |
| **Recruitee** | Passes. `{token}.recruitee.com/api/offers/` |
| **Personio** | Passes. `{token}.jobs.personio.de/xml?language=en` |
| Breezy HR | Keyless, but no description in the list — needs a fetch per posting |
| Rippling | Same, and emits a duplicate row per location |
| SmartRecruiters | Re-confirmed unchanged from ADR-0027 |
| Workday | No description *and* no derivable token — see below |
| Teamtailor | `406` without an `X-Api-Key`; no per-tenant JSON at all |

**Personio was never really a rate-limit problem.** The `429`s ADR-0027 recorded
did not reproduce — six consecutive requests answered `200`. The actual blocker is
that `<jobDescriptions>` comes back **present but empty** unless the request
carries `?language=en`, which from the outside is indistinguishable from a board
whose postings have no bodies. With the parameter: 3,300–5,700 characters a
position. A one-parameter fix hid behind a symptom that looked like throttling.

**Workday is the instructive rejection.** It is the largest tracker here by
headcount and it fails twice: its list carries a title, a path and `"Posted
Today"` — not a description, and not even a real date — *and* its URL needs a
datacenter, a tenant and a site name
(`nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite`), none of
which is derivable from a domain label. That second half is disqualifying on its
own: `probeAtsBoards` has no question it can ask, so such a provider could only
ever arrive through `findAtsBoardInHtml`, the path ADR-0027 measured at **1 of 6**.
**Being a large ATS and being reachable by this pipeline are independent
properties**, and roughly half the trackers that exist fail on the second one.

Finally, ADR-0027 implied a cost that turns out not to be real. Sequential probing
costs one `pageTimeoutMs` per provider per miss, which at six providers is up to
90s per employer and about 45 minutes across a full run — enough to make provider
count look like the binding constraint. It is not a constraint on the provider
count; it is a consequence of probing one at a time.

## Decision

**Six providers — Greenhouse, Lever, Ashby, Workable, Recruitee, Personio — and
the probes run concurrently rather than in sequence.**

- **The selection rule is unchanged and is the whole gate.** Keyless, one request,
  full advert body. Three candidates met it and five did not; the rejections are
  recorded in the `services/ats.ts` module doc so the next list of vendors is
  answered by re-reading the rule rather than re-testing the market.
- **Personio is the one non-JSON provider**, and the exception is bounded: flat
  `<position>` blocks whose single nested element is a list of `<name>`/`<value>`
  section pairs — the same shape as Lever's `lists[]`, read the same way, in a
  reader with no new dependency.
- **Four of six now publish the employer's own name** (`PUBLISHES_COMPANY`), so
  the collision check ADR-0027 could only give Greenhouse covers Workable,
  Recruitee and Personio too. Lever and Ashby still rest on the token match alone.
- **`PROBE_ORDER` decides which board wins when a token resolves on more than
  one**, so concurrency changes the timing and not the outcome.

## Consequences

**Good**

- **Verified end to end on 2026-08-06 through the real code path**: 66 postings
  across the four name-publishing providers — Workable/blueground 28,
  Recruitee/vandebron 12, Personio/wandelbots 7, Greenhouse/figure 19 — and
  **zero came back with a body under 200 characters**. That is the bar the whole
  module exists to enforce, met on every row.
- **Probe wall time is now one timeout, not six**: 322–717ms per employer measured
  across four live probes, against a 90s sequential worst case. Provider count is
  no longer coupled to run duration, which is what makes a seventh provider a
  question about data quality rather than about time.
- **Personio reaches the employers ADR-0027 said it would.** It is the European
  SME tracker, and the sample is a Dresden robotics company hiring a Customer
  Success Manager — exactly the non-software, non-US posting the four remote-tech
  boards cannot produce and that [ADR-0028](0028-a-search-decides-what-counts-as-a-job.md)
  made the filter willing to keep.
- Recruitee's `careers_url` is usually on the **employer's own domain**
  (`werkenbij.vandebron.nl/o/…`), which is stronger identity evidence than the
  provider-hosted URLs the other five produce.

**Costs**

- **The hit rate of the three new providers is unmeasured, and unlike ADR-0027's
  6-of-7 it is not a fair sample.** Those companies were chosen *because* they
  were already known to sit on those boards, so what is verified is that the
  endpoint and the token derivation work — not how often a random lead lands on
  one. `PROBE_ORDER` puts the new three last for exactly this reason, and the
  ordering should be revised once a real run has produced data.
- **Concurrency spends the early exit.** A Greenhouse hit used to stop after one
  request and now always costs six — about 180 requests a day worst case at
  `leadsPerSearch × maxSearchesPerRun`, across six hosts. Small, but it is a real
  transfer of cost from time to requests, and it grows linearly with any provider
  added later.
- **Two token shapes now exist.** Greenhouse, Lever, Ashby and Workable key on a
  path segment; Recruitee, Personio and per-tenant Workable key on the subdomain.
  `RESERVED_SEGMENTS` has to cover both, and a provider-owned subdomain like
  `help.recruitee.com` is a false token in a way that could not arise before.
- **`?language=en` pins Personio to English adverts**, which is the wrong default
  for a tracker whose reach is German and Dutch SMEs. Without it there are no
  bodies at all, so this is strictly better than the alternative — but a German
  posting now arrives in English or not at all.
- **The rejected five are rejected on today's payloads.** SmartRecruiters, Breezy
  and Rippling each need only to add a description to their list endpoint to
  qualify, and nothing here re-checks them.

**Revisit if:** a real run produces enough resolutions to measure per-provider hit
rate — `PROBE_ORDER` is currently ordered by assumption for three of six. Also
revisit if the probe ever exceeds roughly ten providers, where always spending
every probe stops being free and a two-stage probe (the likely three, then the
rest only on a miss) starts to pay. The aggregators ADR-0027 named — Adzuna and
The Muse — remain the honest next source and are untouched by this.
