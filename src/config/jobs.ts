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
   */
  maxJobsPerScoringRun: 60,

  /** Postings delivered in one run, per search, so a busy cycle can't wall the tab. */
  maxJobsPerDelivery: 8,

  /**
   * Minimum fit for a posting to be delivered, when a search doesn't override it.
   *
   * Null on `job_searches.fitThreshold` means this, so retuning here moves every
   * search that never set its own — which is the point of the null rather than a
   * copied number.
   */
  defaultFitThreshold: 70,

  /**
   * Hours that must pass before a run does anything.
   *
   * The schedule fires **daily** and this gate is what makes it every two days.
   * A day-of-month step of two — the obvious cron for this — is *not* "every two
   * days": it fires on the 1st, 3rd … 31st and then the 1st again, so seven
   * month boundaries a year produce two consecutive runs. (The literal cannot be
   * written in a block comment here; its star-slash closes the comment.) A
   * stored `lastRunAt` also survives the thing that already bit this repo once:
   * a missed schedule firing on boot, with two runs then in flight at once.
   *
   * 44 rather than 48 so a run that starts a few minutes late doesn't push the
   * next one a whole day.
   */
  intervalHours: 44,

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
   * Small on purpose. The beat scout asks for 8 sites and keeps ~6, and a
   * proposal list degrades with length — the third run on one subject returned
   * two law firms and a PR agency. Each lead here also costs a page fetch, so
   * this multiplies with `maxSearchesPerRun`.
   */
  leadsPerSearch: 6,

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
