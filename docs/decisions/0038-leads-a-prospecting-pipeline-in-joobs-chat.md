---
id: 0038
applies_to: ["src/mastra/workflows/find-leads.ts", "src/services/lead-identity.ts", "src/services/lead-filter.ts", "src/config/leads.ts"]
status: accepted
supersedes: []
verify: "pnpm leads:check"
---

# ADR-0038: Leads — a prospecting pipeline in Joob's chat, keyed on a company

- **Status:** Accepted
- **Date:** 2026-08-19
- **Depends on:** [ADR-0024](0024-joob-a-job-pipeline-beside-the-news-one.md) for
  the pipeline shape it mirrors, [ADR-0026](0026-sonar-as-a-job-source.md) for the
  model-names-entities / code-verifies-the-URL discipline, and
  [ADR-0023](0023-a-bot-per-agent-two-tokens-two-chats.md) for why this is a tab
  rather than a third bot.

## Context

Joob answers *"who is hiring someone like me?"*. The reader also sells a service —
marketing visuals, ad creative, product photography — and for that the question
inverts: *"who has a problem I am paid to solve, and why this week?"* There is no
posting. Nobody advertised. The signal is that a company raised, launched,
rebranded, or started hiring the role that buys what the reader sells.

### Why this is not a `/target` with a flag on it

Taking [`job_searches`](../../src/db/schema.ts) field by field with a
"this is a lead search" discriminator:

| Column | On a job search | On a lead search |
| --- | --- | --- |
| `domain` | the **role's** field | the **buyer's industry** — a different axis |
| `seniority` | junior…principal | meaningless |
| `contractTypes` | permanent, contract | meaningless |
| `minCompensation` | annual salary floor | project budget — a different unit |
| `remote` | where the reader sits | whether they can serve remotely |
| `locations`, `mustHave`, `dealbreakers`, `fitThreshold` | — | genuinely the same |

Four columns flip meaning, two go dead, and `filterJob` would have to branch on
the flag to read any of them. `domain` settles it on its own: a reader selling
visuals wants clients in **every** industry, so the column
[ADR-0036](0036-a-source-may-declare-its-field-and-a-search-may-be-re-read.md)
calls the single biggest saving in the job pipeline would have to mean "the
buyer's sector" here and "the role's field" there. That is ADR-0024's own opening
argument — *a job is not a row in `articles`* — one level down.

### The four conditions this pipeline needs

Stress-tested against two personas (a marketing-visuals freelancer, an
e-commerce product photographer), the architecture holds when:

1. **The client is an entity with a URL.** Identity is a domain; without one there
   is nothing to key on.
2. **The need is inferable from something public and fetchable.** The filter and
   the scorer must have evidence to read.
3. **A dated public event signals the need.** This is what makes an unbounded
   universe finite.
4. **The offer fits in one document.** `PORTFOLIO_FEED_URL` is the rubric.

Both personas satisfy 1, 3 and 4. Condition 2 is where the photographer differs
from the developer: the evidence is *images*, and every stage of the existing
pipeline is text — `mustHave` scans title + company + description, `htmlToText`
discards images, `minPageChars` is a text floor. That gap is what the vision model
below exists to close, and it is the thing that decides whether this persona is
servable at all.

Outside those conditions the architecture does **not** fit, and it is worth saying
so rather than discovering it: B2C services (a wedding photographer's client is a
person — no URL, no public signal, conditions 1 and 3 both fail), relationship-sold
enterprise work (the signal is private by definition), and local trades (the
universe is a map, not a feed).

### The universe is unbounded, and that changes where the cap goes

Job intake is bounded by what boards published — a few hundred a run. Lead intake
is bounded by nothing: every Shopify store on earth is a candidate client for a
product photographer, and no criterion narrows millions. So **the source must
arrive pre-narrowed and the cap moves off the filter and onto the source.** In the
job pipeline sources are broad and `filterJob` does the work; here the dated
signal — raised this month, launched this week, just posted a creative role — *is*
the narrowing, and criteria only rank what a signal already selected.

This is not a stylistic difference. It is the reason a per-lead vision call is
affordable at all, and getting it wrong is the failure shape
[invariant 2](../../AGENTS.md#invariants) exists for, with a much larger bill than
the one `jobScout.maxSearchesPerRun` was added to contain.

## Decision

**A leads pipeline with its own tables and its own workflow, delivered into a
third tab in Joob's existing chat. The job pipeline is not modified.**

### It is a tab, not a third bot

[ADR-0023](0023-a-bot-per-agent-two-tokens-two-chats.md) split Newy from Joob
because "read the news" and "find me a job" are different jobs for different
moods. Prospecting does not stand in that relation to Joob: a job, a freelance
mission and a client who should be hiring the reader are three shapes of *find me
paid work*, for the same person, on the same cadence, scored against the same
portfolio. A **🎯 Leads** tab beside 💼 Jobs satisfies invariant 9 as written —
one tab, one kind of traffic — and costs no token, no profile, no second poll
loop, and no second Threaded Mode to forget.

The honest pressure: Joob's Chat tab is one Mastra thread with one prompt, and it
will answer both `/target` and `/client`. That is tolerable because it is one
agent's configuration in two shapes rather than two agents guessing who was
addressed, which is the failure invariant 9 was actually written against.

**Split the bot when** the Leads surface needs a command menu that would confuse
the Jobs one, or when the two want cadences that have to be explained in every
message. Moving later is cheap: `telegram_topics` is keyed `(botId, chatId, slug)`
so a new bot provisions clean tabs and Joob's rows are untouched.

### `/client`, `/clients`, `/unclient`, `/reclient`

Mirroring the four job commands in
[`job-commands.ts`](../../src/config/job-commands.ts), parsed by their own
targeter into a `client_profiles` row that is deliberately **smaller** than a
search: label, the request verbatim, industries (empty means any), locations, the
signal kinds that count, dealbreakers, a minimum deal size, notes, and
`fitThreshold`. No seniority, no contract type, no `domain`.

"Client", not "ICP" — this repo writes in the reader's language, not in sales
jargon.

### Identity: the registrable domain, with two escapes

A lead is a **company**, and the only thing about it that code establishes is the
host it was found on. [ADR-0026](0026-sonar-as-a-job-source.md) already measured
the alternative: keyed on a company name, the same employer came back as `Apify`
and as `Apify Technologies s.r.o.` across three live runs, hashing apart because
`normalizeCompany` has no entry for the Czech `s.r.o.`. Extending a suffix list
per jurisdiction is unbounded and treats a model's word choice as evidence.

So `leads.id = normalizeHost(url)`: lowercased, scheme and `www.` and path and
query and fragment discarded, reduced to the registrable domain.
`acme.com/blog/x`, `https://www.acme.com/`, and `shop.acme.com` are one lead.

**Escape 1 — platform hosts, where the subdomain is the company.** Reducing to
eTLD+1 would collapse `acme.myshopify.com`, `brand.squarespace.com` and
`shop.bigcartel.com` into three leads named `myshopify.com`, `squarespace.com` and
`bigcartel.com` — that is, **every Shopify store on earth as one row**, for
precisely the e-commerce persona this pipeline is being built for. A
`PLATFORM_HOSTS` list keeps the full subdomain as the key. This is the same
short-circuit [`job-scout.ts`](../../src/services/job-scout.ts) already applies to
`boards.greenhouse.io/acme`, and it is a list that will be wrong until each
platform is added — so a lead whose host is a *bare* known platform domain is
dropped rather than stored.

**Escape 2 — one company, two domains.** `acme.com` and `acme.fr`, or a rebrand.
The lexical clusterer
([ADR-0007](0007-lexical-clustering-instead-of-embeddings.md)) runs as a second
pass over the batch, exactly as it does for job titles, on normalized name
**plus** location together. Name alone may never merge — that is the Apify lesson,
and two different companies called Atlas is a real thing.

### Signals are the second table, and re-surfacing is the point

`lead_signals`: one row per dated public event — `funding`, `launch`, `hiring`,
`rebrand` — carrying the lead id, the kind, the canonical source URL, the date,
and the text that was fetched.

`signalId = hash(leadId + kind + canonicalUrl)`, so one funding announcement
syndicated across three feeds is one signal.

**This is where leads part company with jobs most sharply.** `job_deliveries` is
keyed on identity alone and is permanent, and its whole purpose is that a company
never arrives twice. That rule is *wrong* here: a lead passed over in March that
raised a Series A in August is the best lead of the month, and a ledger built to
suppress it would suppress exactly the thing being built. So:

- `lead_deliveries` is keyed **`(leadId, signalId)`** — a new signal about a known
  company may be delivered.
- A per-lead **cooldown** bounds it, because a company that raises, launches and
  hires in one week would otherwise arrive three times. One message per lead per
  `leadCooldownDays`, whatever the signal count; the best-scoring signal wins and
  the losers stay on the row so `/why` can answer.

**Not re-*processing* is a separate mechanism from not re-*delivering*, and
conflating the two is how the bill grows.** A signal about a company already in
`leads` skips resolution and skips vision entirely and simply attaches: the
expensive work is per *company*, the delivery decision is per *signal*.

### Two-stage scoring, and vision only at the end

```
signals → attach/resolve → filter (code) → score batch (text) → vision on survivors → write + deliver
```

- **The text batch call** is `AVA_MODEL_LEAD_SCORER`, one call for N leads, the
  shape `rankBeat` and the job scorer already use, with the portfolio in the
  prompt once.
- **`AVA_MODEL_LEAD_VISION` runs one call per survivor**, on the writer's side of
  the line rather than the scorer's — the same asymmetry ADR-0024 draws between
  one batch scoring call and one writing call per winner. Defaulting to
  `openrouter/minimax/minimax-m3`, which reads images well and costs
  proportionally.
- **Its own variable**, per the rule [`env.ts`](../../src/config/env.ts) has now
  settled four times: sharing a default gives the sharing, sharing a variable
  gives a surprise bill. This is the most extreme version of that split the repo
  will contain.
- **Its verdict may never be a filter input.** ADR-0026's rule holds without
  amendment: the model supplies prose, the web supplies facts. *"Their product
  photography is stock imagery"* is a judgement — it may weigh in the fit score
  and it may write the outreach angle; it may not be something `mustHave` reads,
  because a hard filter reading model-written text lets a lead pass on invented
  evidence.
- **The vision verdict is stored on the lead and not recomputed**, re-running only
  after `visionStaleDays` or on a signal that implies the visuals changed. Vision
  is the most expensive call in the system and a company's site does not change
  weekly.

`minimax-m3` is already `AVA_MODEL_ORCHESTRATOR` and is the model whose `</think>`
truncation [`env.ts`](../../src/config/env.ts) documents as the reason it was kept
off the summarizer. The vision output must therefore go through
[`structured-output.ts`](../../src/services/structured-output.ts); left as free
prose in a reader-facing message it will cut mid-word.

### Ordering the batch is signal recency, not portfolio overlap

`rankByCvOverlap` sorts a job batch by Jaccard overlap between the portfolio's
`skill:` tags and the posting's. Against a DTC brand's product page that overlap
is uniformly zero for any reader, and
[ADR-0028](0028-a-search-decides-what-counts-as-a-job.md) already recorded the
same degradation for non-software searches.

It is **replaced rather than degraded**, because it was the wrong question here.
Portfolio overlap answers *can I do this*, which is true of every lead by
construction — the reader only prospects for work they sell. What orders a lead
batch is **signal recency and strength**: raised last week beats raised in March,
launched yesterday beats launched in spring. That is the entire premise of a "why
now" approach, and it is a better ordering than the one being given up.

The portfolio's actual job — being the rubric in the scoring prompt — is unchanged
and works as well for a photographer as for a developer. What is genuinely lost is
`activeJobSources()`'s domain-based fetch-time skip, since a horizontal service
has no buyer domain: leads pay for every source every run. A cost, not a defect.

### Sources: the free ones first, sonar when they saturate

Three good signal sources are already being fetched for other reasons, and cost
nothing to read:

| Source | Cost | Signal |
| --- | --- | --- |
| the `jobs` table | zero — already ingested | hiring for a role adjacent to the service = budget and unmet need |
| known ATS boards ([ADR-0027](0027-ats-boards-as-discovered-sources.md)) | zero — `knownAtsCompanies()` already grows daily | a per-company growth signal over time |
| the HN hiring thread ([ADR-0037](0037-the-hiring-thread-as-a-source-kind.md)) | zero — already parsed, ~375 employers a month | founders posting directly; seed stage means no brand yet |
| funding / launch feeds | near-zero — `fetchFeeds` exists | the strongest "why now" there is |
| **sonar** | metered, capped | reaches past every board |

Sonar is what makes coverage unbounded and will be needed — ADR-0037 measured the
ATS scout saturating at `5, 4, 9, 4, 1, 5, 1, 4, 0` new boards per run. But it is
built **after** the free sources, because they are what reveal what a good lead
looks like, and they reveal it for nothing.

The lead scout is its own agent with its own prompt, not a flag on the job scout,
and the reason is that one whole paragraph of the job scout's instructions
**inverts**. It spends that paragraph refusing agencies, staffing firms and dev
shops — *"the reader is being shown who they would actually work for"*. For a
service seller, agencies are clients: they subcontract constantly. A prompt whose
central exclusion becomes an inclusion is a different prompt.

Which sources are seeded is **per service type**, the way `seed-job-sources.ts`
seeds boards and a beat brings its own feeds. The pipeline stays generic; the seed
is what knows that a product photographer wants launch feeds and a copywriter
wants funding ones.

### The job pipeline is not modified

No migration touches `jobs`, `job_searches`, `job_sources`, `job_matches`,
`job_deliveries` or `job_runs`. No behaviour of `filterJob`, `rankByCvOverlap`,
`jobIdentity` or the job scout changes. The leads workflow reads the `jobs` table
**read-only**, as a signal source.

Where a helper is genuinely shared — `htmlToText`, `escapeMarkdown`, the chunker,
the clusterer, the Telegram transport — it is used as-is and its header gains a
line naming both callers and stating that a leads-specific quirk may not be taught
to it. [ADR-0037](0037-the-hiring-thread-as-a-source-kind.md) set this precedent
and paid for it: Hacker News's unclosed `<p>` tags were fixed in `job-hn.ts` rather
than in `htmlToText`, because "teaching a shared helper about one board's quirks is
how it acquires a caller's quirks." The same rule now applies in the other
direction, and the comment is what makes it survive a future edit made without
this ADR in hand.

**`fetchPage` is shared, and the shape of the sharing is what prevents drift.**
The leads resolver needs the neutral browser-UA fetcher that
[`job-scout.ts`](../../src/services/job-scout.ts) had, so it moved to
[`page-fetch.ts`](../../src/services/page-fetch.ts) — as a **pure function of its
arguments that reads no configuration**. Each caller passes its own user agent and
timeout, and `job-scout.ts` keeps a one-line wrapper supplying `jobPipeline.userAgent`
and `jobScout.pageTimeoutMs`, so both of its call sites and every byte of its
behaviour are unchanged. That parameterization is the load-bearing part: a shared
fetcher that read `jobScout.pageTimeoutMs` itself would let a lead resolver wanting
a longer timeout move the scout, which is exactly the drift the extraction was
conditioned on avoiding.

`feed-discovery.ts` keeps its own copy deliberately. It belongs to the news
pipeline, returns a bare string, and reads `discovery.browserUserAgent` for a
reason its own note records; folding it in would mean editing a working path in a
third pipeline for no gain.

### Invariant 8

Unchanged and restated for the new tables. The conversation may write
`client_profiles` and `memories` — configuration, read by a *future* run. It may
never write a fit score, a vision verdict, a `lead_deliveries` row, or a
`lead_signals` row, and nothing conversational may start the leads run.

## Consequences

**Good**

- The reader gets a prospecting pipeline that reuses the database, the container,
  the migration set, the Mastra instance, `memories`, the portfolio fetch, the
  clusterer, the transport and the run-claim from
  [ADR-0034](0034-a-pipeline-claims-its-cycle.md) — and one chat they already
  read.
- Three of the five best lead sources are already being fetched for the job
  pipeline, so the first working version costs no new network traffic at all.
- Company identity is keyed on the one thing code established, which is the
  conclusion ADR-0026 reached the expensive way and does not have to be
  re-derived.
- A new signal about a known company can reach the reader, which is the behaviour
  that makes prospecting work and the one `job_deliveries` is built to prevent.
- Vision is confined to survivors, cached per company, and structurally incapable
  of feeding a hard filter.

**Costs**

- **A second expensive model on an unbounded intake.** Every guard here — the
  cooldown, the survivors-only rule, the stored verdict, the per-source caps — is
  load-bearing rather than tuning. Remove any one and the run gets a bill nobody
  is watching.
- **`PLATFORM_HOSTS` is a list, and lists are wrong until extended.** A platform
  not yet on it silently merges all of its stores into one lead. Dropping bare
  platform domains limits the damage to a merge rather than a delivery, but the
  merge is invisible.
- **Two domains for one company are merged only if the clusterer catches them**,
  and a rebrand with a new name and a new domain is a new lead. The reader will
  occasionally be pitched a company they already contacted.
- **The leads pipeline pays for every source every run**, because a horizontal
  service has no buyer domain and ADR-0036's fetch-time skip cannot fire.
- **`minimax-m3` carries a known truncation failure** already documented in this
  repo, and the mitigation is a schema this ADR mandates but cannot enforce.
- **Joob's Chat tab now serves two configuration surfaces.** The first genuinely
  confusing exchange is the signal to split the bot, and nobody will be watching
  for it.
- **Sonar will invent need far more freely than it invents employers.** *"Is this
  company hiring"* is checkable against a careers page; *"does this company need
  better visuals"* is checkable against nothing. The filter-input prohibition is
  the only thing standing between that and a delivered lead built on nothing.
- **Condition 2 is the whole bet.** If a persona's need is not inferable from a
  fetchable page — with or without vision — this pipeline delivers plausible
  nonsense at a good rate, and no amount of sourcing fixes it.

**Revisit if:** a persona arrives whose signals are neither text nor image but
structured — an ad library, a store-platform detector, a review feed — which is
when a signal stops being a fetched page and becomes an adapter, and
`lead_signals.kind` has to carry a payload rather than prose. Also revisit when
the Leads tab's command surface starts confusing the Jobs one, which is the
condition ADR-0023's split is waiting on.
