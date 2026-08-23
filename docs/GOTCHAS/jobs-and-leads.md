---
applies_to:
  [
    "src/mastra/workflows/find-jobs.ts",
    "src/mastra/workflows/find-leads.ts",
    "src/services/job-fetch.ts",
    "src/services/job-filter.ts",
    "src/services/job-identity.ts",
    "src/services/job-scout.ts",
    "src/services/job-tags.ts",
    "src/services/job-hn.ts",
    "src/services/lead-filter.ts",
    "src/services/lead-identity.ts",
    "src/services/lead-signals.ts",
    "src/services/ats.ts",
    "src/config/jobs.ts",
    "src/config/leads.ts",
  ]
---

# Gotchas — jobs and leads

Surprises specific to Joob's two pipelines: the boards, the ATS providers, posting identity, and the
lead scout. Feed and article surprises are in [feeds-and-ingest.md](feeds-and-ingest.md); anything
about a model's output shape is in [models-and-prompts.md](models-and-prompts.md).

Harvested from the working journal on 2026-08-23, each verified against the code it names.

- **`jobs.listed_roles` is a boolean wearing a number's clothes.** Nothing compares it to a
  threshold — only to zero (`src/services/job-filter.ts`) — and `listedRoleLinks` deliberately
  over-counts to stay on the keep side of *"did this page offer anywhere to go"*. It is null on
  every advert; the question only applies to a sonar lead. Introducing a "needs at least N roles"
  rule would be a different decision from
  [ADR-0040](../decisions/0040-a-careers-page-with-nothing-on-it-is-a-lead.md), not a tuning of it.

- **The title is in `advertKey` because a URL alone silently hides a job.** RemoteOK serves its own
  index page, `remoteok.com/remote-jobs/`, as the URL of any posting it has no permalink for, and
  two unrelated adverts were sitting behind it — a URL-only key would have dropped one. Requiring
  the titles to agree costs nothing: a duplicate arriving by two paths off one board carries one
  title, byte for byte. **`advertKey` returns null when the title normalizes to empty and the caller
  must skip it** — both RemoteOK rows are in that state, their titles being Greek and Chinese, and a
  bare-URL fallback would merge exactly the pair this guard exists to keep apart.

- **Personio's `429`s were a red herring and cost a provider for a day.**
  [ADR-0027](../decisions/0027-ats-boards-as-discovered-sources.md) recorded it as rate-limiting; it
  answers `200` six times in a row. The real blocker is that `<jobDescriptions>` comes back
  **present but empty** without `?language=en` — indistinguishable from outside from a board whose
  postings have no bodies. With the parameter, 3,300–5,700 characters a position. **When a provider
  looks like it has no advert text, check for a content parameter before concluding the API is
  useless.**

- **Never add an ATS host to `jobScout.excludedHosts`.** `greenhouse.io`, `lever.co`, `ashbyhq.com`
  and `personio.com` are where real employers put real careers pages — an ATS is infrastructure an
  employer rents, while a marketplace *is* the company. The distinction and both lists are at
  `src/config/jobs.ts`. The failure it prevents is silent: `arc.dev` survived every filter in six of
  six runs before the lists were separated.
