/**
 * The job pipeline's knobs. No magic numbers in the logic.
 *
 * Two of these may not be tuned independently, and one pair is load-bearing in a
 * way that is easy to undo by accident — read
 * [ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)
 * before moving any of the three window values.
 */

export const jobPipeline = {
  /**
   * How old a posting may be and still be ingested.
   *
   * Wide, because listings stay open — hiring takes weeks, and a three-week-old
   * posting is still worth applying to. This is the number that most obviously
   * differs from the news pipeline's 7-day window, where three weeks old means
   * dead.
   *
   * **Must stay well below `retentionDays`.** Deleting a row frees its id, and
   * the id is the dedupe, so a pruned posting a board still serves would be
   * re-ingested with a null `deliveredAt` and re-sent. The ingest window
   * refusing it on age is the first guard; `job_deliveries` is the second and
   * the one that actually holds.
   */
  ingestWindowDays: 30,

  /**
   * How long a posting is kept.
   *
   * Double the ingest window, so the trap above cannot fire on any source that
   * ships a date. Shortlisted and applied postings outlive this through the
   * denormalized copy on their delivery row.
   */
  retentionDays: 60,

  /**
   * How long after delivering a posting the same identity is suppressed.
   *
   * **Must exceed `retentionDays`**, or the pruning hole reopens: a posting
   * pruned at 60 days and re-crawled the next day would otherwise clear a
   * shorter guard and be sent twice.
   *
   * The cost is that a role genuinely re-advertised inside 75 days is not shown
   * again — which is the right behaviour anyway. A repost two months on is one
   * the reader already saw and passed over; the repost worth surfacing is the
   * long-gap one, and it clears this comfortably.
   */
  redeliveryGuardDays: 75,

  /**
   * Postings handed to the scorer in one run.
   *
   * A 30-day window means the *first* run pulls a month of every source at once,
   * and several boards serve their whole history. Without this the first run
   * scores several hundred postings in one call. Mirrors
   * `pipeline.maxItemsPerRankingRun`, and exists for the same reason it does.
   *
   * **Raised from 60 because a live search saturated it exactly.** On 2026-08-05
   * `founding-engineer-worldwide` handed the scorer 60 of 60 and delivered one
   * job: for that search the bottleneck was never sourcing, it was this number,
   * and adding boards would have changed nothing. Ninety rather than more,
   * because the cost is a *truncated answer* rather than a slow one — the scorer
   * returns a verdict per posting and `modelAttempts` exists precisely because
   * that output gets cut off. Watch the run report for postings the model
   * silently dropped before raising it again.
   */
  maxJobsPerScoringRun: 90,

  /** Postings delivered in one run, per search, so a busy cycle can't wall the tab. */
  maxJobsPerDelivery: 8,

  /**
   * Minimum fit for a posting to be delivered, when a search doesn't override it.
   *
   * Null on `job_searches.fitThreshold` means this, so retuning here moves every
   * search that never set its own — which is the point of the null rather than a
   * copied number.
   */
  defaultFitThreshold: 60,

  /**
   * Hours that must pass before a run does anything.
   *
   * The schedule fires **daily** and this gate decides whether a firing does any
   * work. It stays a gate rather than becoming a bare daily cron, because a
   * stored `lastRunAt` survives the thing that already bit this repo once: a
   * missed schedule firing on boot, with two runs then in flight at once. It also
   * keeps the cadence a property of the data, so changing this number is the only
   * edit needed — the cron never has to express an interval, which is the trap
   * a day-of-month step falls into (a step of two fires on the 1st, 3rd … 31st
   * and then the 1st again, so seven month boundaries a year run twice).
   *
   * **Twenty rather than 44, which makes this a daily pipeline.** Every-two-days
   * was set when a run's intake was four thin boards; it is now the cheapest
   * throughput left, because doubling the runs doubles the scoring batches
   * without touching the prompt size that `maxJobsPerScoringRun` has to respect.
   * The cost is honest and worth stating: it doubles the model spend, one scoring
   * call plus up to `maxSearchesPerRun` scout calls per day rather than per two.
   *
   * Twenty rather than 24 for the reason 44 was not 48 — a run that starts a few
   * minutes late must not push the next one a whole day.
   */
  intervalHours: 20,

  /** Hour the daily schedule fires, in `AGENT_TIMEZONE`. */
  runHour: 8,

  /**
   * Longest description stored per posting.
   *
   * Job adverts run to thousands of words of benefits boilerplate. The scorer
   * sees a truncated version anyway (see below), and the writer reads this one.
   */
  maxDescriptionChars: 12_000,

  /**
   * Description characters shown to the *batch scorer*, per posting.
   *
   * Far smaller than the stored version, because the scoring prompt carries the
   * CV once plus every candidate posting — at 60 postings, a full advert each
   * would be the whole prompt. The first part of an advert carries the role;
   * the tail carries the equal-opportunity statement.
   */
  scorerDescriptionChars: 1_200,

  /**
   * How many times a structured model call is attempted before giving up.
   *
   * Mastra's own `maxRetries` retries a failed *request*; this retries a
   * malformed *answer*, which is a different failure and the one measured here —
   * a truncated JSON body that fails schema validation. Truncation is
   * stochastic, so asking the same question again usually works.
   *
   * Two, not more: the scorer's call is the run's whole model spend and takes
   * minutes, so a third attempt costs far more than the batch is worth waiting
   * for. The run degrades rather than retrying forever.
   */
  modelAttempts: 2,

  /** Concurrency over sources at ingest. Politeness, not throughput. */
  sourceConcurrency: 4,

  /** How long to wait on one source before giving up on it for this run. */
  sourceTimeoutMs: 20_000,

  /**
   * Browser User-Agent for job boards.
   *
   * Same finding as the news pipeline's homepage fetch: several boards answer
   * 403 to an honest bot UA. Job boards are more hostile about this than RSS
   * publishers, not less.
   */
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/126.0.0.0 Safari/537.36',
} as const

/**
 * The `hn` source kind — Hacker News's monthly "Who is hiring?" thread.
 *
 * Its own block rather than a few more keys on `jobPipeline`, for the reason
 * `jobScout` is one: this is a *source* with a shape nothing else shares, and
 * folding its knobs into the pipeline's would make them look like they applied
 * to every board.
 */
export const jobHiringThread = {
  /**
   * Comments pulled from one thread.
   *
   * The August 2026 thread carried 375 top-level postings, so this takes the lot
   * with room to spare — and unlike `atsMaxPostingsPerBoard` there is no reason
   * to cap it lower. That cap exists because one employer's board would otherwise
   * become the whole run; here the 375 are 375 *different* employers, which is
   * the opposite problem and the thing that makes this source worth having.
   *
   * The cost is one request. Algolia pages at 1000, and the ingest window then
   * discards last month's thread if it is still being returned.
   */
  maxPostingsPerThread: 500,

  /**
   * Longest a header field may be before the parse is judged to have failed.
   *
   * The convention puts a company name and a role title in the first two fields,
   * and both are short. A "company" of 200 characters means the poster wrote a
   * paragraph with a pipe in it, and taking that as an employer name would put a
   * sentence in the dedupe key and in the reader's message. Rejecting is right:
   * `unparsed` counts it, so a month where the convention shifts shows up as a
   * number rather than as a tab full of nonsense.
   */
  maxFieldChars: 80,
} as const

/**
 * The `sonar` source kind — reaching past the boards, one query per search.
 *
 * The boards this repo can use for free are thin and skewed: Remotive's free
 * endpoint returns 31 postings in total, and LinkedIn and Indeed are out of scope
 * for good reasons
 * ([ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)).
 * `perplexity/sonar` asks the open web which companies are hiring for a search,
 * and **code** resolves the careers page — the model never supplies a URL that is
 * stored, exactly as the beat scout never supplies a feed URL
 * ([ADR-0020](../../docs/decisions/0020-feed-discovery-from-a-subject.md)).
 *
 * **This runs on a schedule, which is why the caps below are not optional.** A
 * scheduled model call is legal here because the control flow is fixed and every
 * URL is verified deterministically — see invariant 2 in
 * [AGENTS.md](../../AGENTS.md#invariants) — but "fixed control flow" is only true
 * if the loop is bounded. `maxSearchesPerRun` is that bound: without it the cost
 * of a run grows every time the reader types `/target`, silently and unattended.
 */
export const jobScout = {
  /**
   * Companies asked of sonar, per search.
   *
   * **Raised from 6 once a lead stopped being worth one row.** Before ATS
   * expansion each lead produced a single posting whose description was a careers
   * landing page, so asking for more bought more of almost nothing. Measured
   * 2026-08-06 on the six employers of a live run, a lead is now worth ~28 real
   * adverts: five companies produced 140 postings where they had produced five.
   *
   * Not raised further, and the limit is the model rather than the cost. A
   * proposal list degrades with length — the beat scout asks for 8 and keeps ~6,
   * and the third run on one subject returned two law firms and a PR agency. Ten
   * is where the list is still all plausible employers.
   *
   * Each lead still costs a homepage fetch, up to four careers-link fetches, up
   * to ten well-known path attempts and up to three ATS probes, so this
   * multiplies with `maxSearchesPerRun`.
   */
  leadsPerSearch: 10,

  /**
   * Active searches that trigger a sonar call in one run.
   *
   * **The cost ceiling for the whole feature.** A run costs at most this many
   * search calls plus `leadsPerSearch × this` page fetches, whatever the reader
   * has accumulated in `job_searches`. Searches are taken oldest-first, which is
   * `activeSearches()`'s own order, so the choice is stable rather than
   * arbitrary — a search does not silently lose its turn to a newer one.
   */
  maxSearchesPerRun: 3,

  /**
   * Paths tried when a homepage links to no careers page.
   *
   * Ordered by how often they hit. Both `/careers` and `/careers/` are here for
   * the reason `/feed` and `/feed/` both are in `discovery.wellKnownPaths`: some
   * hosts redirect between them and some 404 rather than redirect.
   */
  careersPaths: [
    '/careers',
    '/careers/',
    '/jobs',
    '/jobs/',
    '/join-us',
    '/company/careers',
    '/about/careers',
    '/work-with-us',
    '/en/careers',
    '/hiring',
  ],

  /** Anchor text or href that suggests a link to the company's careers page. */
  careersLinkHints: /\b(careers?|jobs?|hiring|join[- ]?us|work[- ]?with[- ]?us|vacancies|open[- ]?roles|opportunities)\b/i,

  /**
   * A link *path* that leads to an individual advert rather than to the list.
   *
   * Matched against the resolved pathname only — never the anchor's markup, which
   * is the mistake `careersLinkHints` had to be paired with `looksLikeCareers` to
   * survive. What makes a posting link a posting link is the segment *after* the
   * job-ish one: `/careers` is the page we are already on, `/careers/senior-dev`
   * is somewhere to apply.
   *
   * `o` and `j` are here because two applicant-tracking providers shorten to
   * them — Recruitee serves `/o/<slug>` and Workable `/j/<id>` — and those are
   * among the pages most likely to be the real thing.
   *
   * Used only to answer *"did this page offer anywhere to go"*, so it is tuned to
   * over-count rather than to be precise. See `listedRoleLinks`.
   */
  postingLinkHints:
    /\/(jobs?|careers?|vacanc(?:y|ies)|positions?|openings?|opportunit(?:y|ies)|roles?|stellen|offres?|o|j)\/[^/?#]{2,}/i,

  /**
   * Applicant-tracking hosts, which are careers pages by definition.
   *
   * A resolved URL normally has to *look* like a careers page — see
   * `looksLikeCareers` — because the link that pointed at it may have matched on
   * a stray `class` attribute. These hosts bypass that check, because the shape
   * test rejects several of them outright: `boards.greenhouse.io/acme` and
   * `apply.workable.com/acme` contain neither "careers" nor "jobs" anywhere in
   * host or path, and they are among the **best** pages resolution can find — a
   * real employer's real vacancy list, with no marketing copy around it.
   *
   * The exact inverse of `excludedHosts` below and easy to confuse with it. An
   * ATS is *infrastructure an employer rents*, so the page belongs to the
   * employer; a marketplace *is* the company, and its listings are other
   * people's jobs. Never move a host between these two lists without deciding
   * which of those it is.
   */
  atsHosts: [
    'greenhouse.io',
    'lever.co',
    'ashbyhq.com',
    'workable.com',
    'personio.com',
    'personio.de',
    'recruitee.com',
    'teamtailor.com',
    'bamboohr.com',
    'smartrecruiters.com',
    'jazz.co',
    'breezy.hr',
    'myworkdayjobs.com',
    'successfactors.com',
    'join.com',
  ] as readonly string[],

  /**
   * Hosts that are never a lead, whatever the model says about them.
   *
   * **This is a guard, not a hint.** The prompt is told to skip marketplaces too,
   * and that instruction is worth having, but a prompt rule obeyed 99% of the
   * time is a bug at any volume — and this one was obeyed **0 of 6 times**:
   * `arc.dev` was proposed and survived the filter in every run of every model
   * measured on 2026-08-05.
   *
   * The defect is specific and worth stating precisely, because it is not "this
   * company is an agency". Job&Talent and Deel are staffing businesses that also
   * genuinely hire frontend engineers, and denying them would throw away real
   * jobs. The problem is a company **whose careers page is a marketplace of other
   * companies' jobs**: resolution succeeds, the page is enormous, and because
   * `mustHave` scans the whole description a page listing every stack in
   * existence passes every stack filter. `arc.dev/job-descriptions` came back as
   * 12k characters tagging Angular, Python, Java, Ruby, C++, AWS, GCP and Azure.
   *
   * Two groups, both hosts rather than names, since a name is a model's phrasing:
   *
   * - **Talent marketplaces and dev-shop staffing platforms**, whose listings are
   *   third-party roles behind an intermediary.
   * - **The job boards themselves**, including the ones this pipeline already
   *   ingests directly — a lead saying "Remote OK is hiring" is a duplicate of
   *   our own source at best.
   *
   * Deliberately **not** here: `greenhouse.io`, `lever.co`, `ashbyhq.com`,
   * `workable.com`, `bamboohr.com`, `recruitee.com`, `personio.de`. Those are
   * applicant-tracking hosts, and `boards.greenhouse.io/acme` is the *real*
   * careers page of a real employer — the single most valuable thing resolution
   * finds. Adding them would reject the best leads this source produces.
   *
   * Matched on the proposed company's homepage, never on the resolved careers
   * URL, for exactly that reason.
   */
  excludedHosts: [
    // Talent marketplaces and staffing platforms.
    'arc.dev',
    'toptal.com',
    'upwork.com',
    'fiverr.com',
    'freelancer.com',
    'lemon.io',
    'turing.com',
    'andela.com',
    'x-team.com',
    'crossover.com',
    'gun.io',
    'gigster.com',
    'braintrust.com',
    'a.team',
    // Job boards, including the ones already ingested as sources.
    'linkedin.com',
    'indeed.com',
    'glassdoor.com',
    'ziprecruiter.com',
    'monster.com',
    'dice.com',
    'wellfound.com',
    'angel.co',
    'remoteok.com',
    'weworkremotely.com',
    'himalayas.app',
    'jobicy.com',
    'remotive.com',
    'arbeitnow.com',
    'builtin.com',
    'otta.com',
    'welcometothejungle.com',
  ] as readonly string[],

  /** One page fetch. Matches `discovery.pageTimeoutMs` — same job, same shape. */
  pageTimeoutMs: 15_000,

  /** Pages fetched at once. A burst of requests to unrelated strangers; keep it small. */
  pageConcurrency: 4,

  /**
   * Careers-page text kept as a lead's description.
   *
   * **This field is what makes a lead survive the filter at all.** `filterJob`
   * reads `mustHave` out of title + company + description, and a lead whose
   * description is one model-written line is rejected with "never mentions
   * TypeScript or React" — which is already the largest rejection reason on live
   * intake. Real page text is what gives that rule something true to read.
   *
   * Larger than `maxDescriptionChars` would need to be for one advert, because a
   * careers page is a *list* of roles and the one that matters may be well down
   * it. The scorer still only ever sees `scorerDescriptionChars` of it.
   */
  maxPageChars: 20_000,

  /**
   * Postings taken from one applicant-tracking board.
   *
   * A lead that resolves to an ATS board is expanded into that employer's real
   * adverts rather than stored as its landing page — see `services/ats.ts` for
   * why the landing page was worthless. The cap is what stops one employer
   * becoming the run: Lever's own demo board returns 388 postings, which is more
   * than every free board in this pipeline produces put together.
   *
   * Fifty rather than ten, because the boards are not tech boards and the role
   * the reader wants may be well down a list covering every function the employer
   * hires for. `sortedByRecency` inside `fetchAtsBoard` means the cap takes the
   * newest, and the ingest window then discards anything genuinely stale.
   */
  atsMaxPostingsPerBoard: 50,

  /**
   * How long an ATS board may return nothing before it is switched off.
   *
   * **Discovered sources need an off-ramp that seeded ones do not.** The seed is
   * nine rows a human chose; `ats` rows arrive on their own at up to
   * `leadsPerSearch × maxSearchesPerRun` a day and never leave. Unchecked that is
   * roughly 450 rows a month, each costing a request every run at
   * `sourceConcurrency` four — an ingest that gets slower forever, which is a
   * strange way for a feature that adds coverage to fail.
   *
   * Forty-five days rather than a count of runs, deliberately: a run-count
   * threshold silently means something different every time the cadence moves,
   * and the cadence moved once already. Time is what "this employer is not
   * hiring" is actually measured in.
   *
   * Generous, because being wrong here is asymmetric. A board switched off too
   * early loses an employer the scout paid to find; one left on too long costs a
   * single cheap request a day. Six weeks of silence is a real answer.
   */
  atsIdleDays: 45,

  /**
   * The share of a source's scored postings that must reach the reader's bar.
   *
   * **The counterweight `atsIdleDays` could not be.** That mechanism only ever
   * recognised *silence* — a board returning nothing for six weeks. It has no
   * opinion about a board returning fifty postings a day that are all wrong, and
   * measured on 2026-08-17 that was the pipeline's largest single waste: jobicy
   * spent **427 scoring slots, 32% of everything the model has ever read**, and
   * produced five postings at 60 and none at 80. Himalayas spent 137 for two.
   * Neither would ever have been switched off, because neither was ever quiet.
   *
   * **A rate, not a count, and that distinction is measured rather than tidy.**
   * The obvious rule — "archive a source that has never produced a good posting"
   * — was tested against the real table and gets both halves wrong. It spares
   * jobicy, which has two postings at 70 out of 427 and so passes. And it
   * archives `ats-lever-3pillarglobal`, `ats-ashby-owner`,
   * `weworkremotely-backend` and `weworkremotely-devops`, all four of which have
   * *delivered jobs to the reader*. As a rate the separation is unambiguous and
   * needs no careful threshold: the good sources sit at 11.5–13.2% and the bad
   * ones at 0.5–0.7%, a sixteenfold gap with nothing in between.
   *
   * Three percent, so it sits in that gap rather than near either edge.
   *
   * **Measured against each search's own bar, never a second hardcoded number.**
   * `search.fitThreshold ?? defaultFitThreshold` is what decides delivery, so it
   * is what decides yield too. A separate constant here would be free to drift
   * above the delivery bar, and the pipeline would then archive sources for
   * producing postings it was at the same moment sending to the reader.
   */
  minYieldRate: 0.03,

  /**
   * Scored postings a source must have before its yield rate means anything.
   *
   * Without a floor the rule is noise at small n: `ats-ashby-posthog` has three
   * scored postings and two of them cleared 80, and a board with one bad posting
   * would read as a 0% source and be archived on its first day. Fifty is roughly
   * a week of a mid-sized board, and comfortably more than a single run's batch.
   *
   * This is the *only* thing protecting a newly discovered board, which is why
   * it is a count of scored postings rather than a number of days: a board that
   * returns four postings a week deserves the same sample as a busy one, not the
   * same calendar.
   */
  minYieldSample: 50,

  /**
   * How long an idled board is remembered before the row is deleted.
   *
   * **The row has to outlive the archiving, or the decay achieves nothing.**
   * `knownAtsCompanies` hands every ATS row — archived included — to the scout as
   * a company to skip, so an idled employer stops being proposed. Delete the row
   * the same day it is archived and the very next run rediscovers the employer,
   * pays for the lead again, and re-adds a board that is still empty.
   *
   * So this is a quarantine, and deletion is what finally makes an employer
   * discoverable again — right, because "not hiring" is a fact with a shelf life.
   * With `atsIdleDays` in front of it that is about five and a half months from
   * last posting to fresh eligibility.
   *
   * **Only boards idled by this mechanism are ever deleted.** A row the reader
   * archived by hand is kept forever: it records a decision, and deleting it
   * would let the scout undo them by rediscovery.
   */
  atsForgetDays: 120,

  /**
   * Shortest extracted page text that counts as a resolved careers page.
   *
   * A page that renders its listings entirely from JavaScript returns a shell of
   * nav and footer, which fetches fine, returns 200, and carries no evidence
   * whatsoever. Without a floor those leads reach the scorer as a company name
   * and nothing else, and get judged on the model's prior about the company
   * rather than on anything read. Below this the lead is dropped with a reason.
   */
  minPageChars: 400,
} as const
