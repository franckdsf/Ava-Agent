/**
 * The leads pipeline's knobs
 * ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
 *
 * **Read the ADR before tuning anything here that bounds a model call.** The job
 * pipeline's caps exist to keep a bill proportional; several of these exist to
 * keep it *finite*. Job intake is bounded by what boards published — a few
 * hundred a run. Lead intake is bounded by nothing at all: every company on the
 * web is a candidate client, and the narrowing is done by the dated signal rather
 * than by any criterion the reader typed. `maxVisionCallsPerRun` in particular is
 * the only hard stop between a quiet Tuesday and an unwatched invoice.
 */

export const leadPipeline = {
  /**
   * How old a signal may be and still be ingested.
   *
   * Much tighter than `jobPipeline.ingestWindowDays`, and for the opposite
   * reason. A three-week-old job posting is still worth applying to because the
   * role is still open. A three-week-old funding announcement has already been
   * pitched by everyone else, and the entire value of a lead is the *why now* —
   * so lateness here costs the thing being sold.
   */
  signalWindowDays: 21,

  /**
   * How long a lead row is kept after its last signal.
   *
   * Generously above the signal window, because a lead is a company rather than
   * an event: the row carries the resolved page, the vision verdict and the
   * delivery history, and re-deriving those is the expensive part. Pruning is
   * about a company that has gone quiet for a season, not about freshness.
   */
  retentionDays: 180,

  /**
   * The floor between two messages about the same company, whatever happens.
   *
   * `lead_deliveries` is keyed `(leadId, signalId)` so a genuinely new signal
   * *may* be delivered — that is the whole difference from `job_deliveries` and
   * the reason prospecting works at all. This is the bound on it: a company that
   * raises, launches and posts a creative role in one week would otherwise arrive
   * three times in three days, which reads as a broken bot rather than as good
   * coverage.
   *
   * The best-scoring signal wins the slot and the losers stay on their rows, so
   * nothing is lost — `/why` can still answer with what else was seen.
   */
  cooldownDays: 30,

  /**
   * How long a vision verdict is trusted before it is worth paying for again.
   *
   * A company's site does not change weekly, and this is the most expensive call
   * in the system. Re-running is otherwise triggered by a signal that implies the
   * visuals moved — a rebrand, a launch — rather than by the clock.
   */
  visionStaleDays: 120,

  /**
   * How many leads reach the text scorer in one run.
   *
   * The analogue of `maxJobsPerScoringRun`, and the same argument: the batch is
   * one call, so this bounds the prompt rather than the call count.
   */
  maxLeadsPerScoringRun: 60,

  /**
   * **How many vision calls one run may ever make.** The hard stop.
   *
   * Vision runs on survivors only — after the deterministic filter and after the
   * text score — which already makes it rare. This is the guard for the case
   * where that reasoning is wrong: a filter bug, a source that floods, a
   * threshold set too low. Without it a single bad run is unbounded spend, which
   * is precisely the shape [invariant 2](../../AGENTS.md#invariants) exists to
   * prevent, with a much larger number attached than the job pipeline can reach.
   *
   * Leads beyond the cap are not lost. They keep their text score and are picked
   * up by the next run, exactly as unscored postings are.
   */
  maxVisionCallsPerRun: 12,

  /**
   * How many images from one page are put in front of the vision model.
   *
   * A product page can carry fifty. The first handful in document order are the
   * hero and the product shots — which is what a judgement about visual quality
   * is actually about — and the tail is icons, payment badges and tracking
   * pixels.
   */
  maxImagesPerLead: 6,

  /** Smallest image worth sending. Below this it is an icon or a spacer. */
  minImageBytes: 8_000,

  /** How many leads may be delivered in one run, so a first run is not a wall. */
  maxLeadsPerDelivery: 5,

  /**
   * The bar a lead clears to be delivered, when the client profile names none.
   *
   * Deliberately above `jobPipeline.defaultFitThreshold`. A job that is a
   * near-miss costs the reader ten seconds of reading; a lead that is a near-miss
   * costs them an outreach message to a company that did not need one, and the
   * cost of *that* is reputational rather than temporal.
   */
  defaultFitThreshold: 70,

  /**
   * Hours that must have elapsed before a run does anything.
   *
   * The cadence is a property of the data, not of the cron — the same argument
   * `jobRuns.startedAt` settled ([ADR-0024]). Longer than the job pipeline's
   * because signals arrive in days rather than hours, and because a cooldown of
   * 30 days makes a twice-daily sweep pointless.
   */
  intervalHours: 44,

  /**
   * Hours the schedule fires, in `AGENT_TIMEZONE`.
   *
   * **Two fires, one run** — the reasoning `jobPipeline.runHours` records, which
   * `7762cf4` applied to jobs and not here (audit F1). The gate above decides, so
   * at 44h only one fire per cycle claims it; the other is a retry. With 09:00
   * alone, a run the scheduler replayed at boot at 15:00 was refused at 09:00 two
   * mornings running and the next run came 66h later, not 54h. Model spend is
   * unchanged. `src/db/__tests__/cadence.test.ts` holds both numbers.
   */
  runHours: [9, 21],

  /** Characters of resolved page text kept on a signal. */
  maxPageChars: 20_000,

  /**
   * Characters of page text put in front of the *text* scorer, per lead.
   *
   * Much tighter than what is stored, because this one is multiplied by the batch
   * size and the portfolio is in the same prompt.
   */
  scorerPageChars: 1_500,

  /** Retries on a malformed model response, per call. */
  modelAttempts: 2,

  /**
   * How long `/client` may work in silence before it says it is working.
   *
   * **A deferred acknowledgement, not an eager one**, and the delay is the whole
   * design. Telegram's typing indicator lasts about five seconds; a parse
   * measured at 9s on one run and 232.8s on the next then leaves the reader
   * watching nothing at all, with `modelAttempts` able to double it. What people
   * do at that point is type the command again in different words — and because
   * `/client` upserts on the slug the *model* produces, a second wording can
   * produce a second row competing for the same companies. The silence does not
   * just look broken; it manufactures the exact duplicate `/reclient` exists to
   * repair.
   *
   * Firing on a timer rather than immediately keeps the common case to **one**
   * message. A parse that finishes in three seconds should not cost the reader
   * two notifications to say one thing.
   *
   * Four seconds, so it lands just as the typing indicator gives up.
   */
  ackAfterMs: 4_000,

  /** Concurrent page fetches while resolving signals. */
  pageConcurrency: 4,

  /** Hard deadline on one page fetch. No ambient timeout exists on `fetch`. */
  pageTimeoutMs: 15_000,

  /**
   * Below this many characters, a resolved page is not evidence.
   *
   * The same floor `jobScout.minPageChars` sets and for the same measured reason:
   * a site that renders from JavaScript answers 200 with a shell of nav and
   * footer, and a lead judged on one is judged on the model's prior about the
   * company rather than on anything read.
   */
  minPageChars: 400,

  /**
   * Sent on every fetch. A browser UA, because a company's marketing site sits
   * behind the same kind of CDN a job board does.
   *
   * Its own value rather than a read of `jobPipeline.userAgent`: the two callers
   * pass their own into the shared `fetchPage`, which is what stops one
   * pipeline's tuning from moving the other's.
   */
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
} as const

/**
 * The `sonar` lead source: which companies just did something that means they
 * need what the reader sells
 * ([ADR-0039](../../docs/decisions/0039-a-lead-scout-with-its-own-budget.md)).
 *
 * **Its own block, and that is the entire point of it existing.** Before this,
 * lead coverage was a function of `jobScout.maxSearchesPerRun` — a cap tuned for
 * the *job* pipeline's cost, silently governing how many companies prospecting
 * could ever see, because the only leads that resolved came from postings the job
 * scout happened to fetch. Measured 2026-08-19: 39 companies in 21 days, 37 of
 * them downstream of that cap. Nobody chose that number for this.
 */
export const leadScout = {
  /**
   * How many client profiles get a sonar search per run. **The bound invariant 2
   * requires of a search shape**, and load-bearing rather than a tuning knob: a
   * loop over "every active profile" is only fixed control flow while the reader
   * has few, and the cost of an unattended run would otherwise grow every time
   * they type `/client`.
   *
   * The job-side twin is `jobScout.maxSearchesPerRun`, and the two now move
   * independently — which is what this whole block is for.
   */
  maxProfilesPerRun: 2,

  /** Companies asked for per profile. The model is told a short honest list beats a padded one. */
  prospectsPerProfile: 8,

  /**
   * A proposed company's own site must carry at least this much text.
   *
   * The floor ADR-0026 measured: a site rendering from JavaScript answers 200
   * with a shell of nav and footer, and a company judged on one is judged on the
   * model's prior rather than on anything read.
   */
  minPageChars: 500,

  /**
   * **The company's name must appear on the page code fetched.**
   *
   * This is the verification that a model cannot fake, and the reason a sonar
   * lead can be trusted at all. A model that invents `acmeskincare.com` will
   * sometimes hit a parked domain, an SEO squat or an unrelated business — every
   * one of which answers 200 with plenty of text and passes the floor above. The
   * name test is what makes "this page is that company" a fact about a server
   * rather than a claim in a prompt.
   */
  requireNameOnPage: true,

  /**
   * Longest a scout's one-line summary may be.
   *
   * Measured on the first live run: one line was asked for and a four-clause
   * paragraph arrived, citation markers included. This is a message heading and
   * it appears once per candidate in the batch scoring prompt, so an unbounded
   * field is both unreadable on a phone and a per-run cost.
   */
  maxSummaryChars: 220,

  /** Concurrent verifications. Each is one or two plain GETs. */
  concurrency: 4,
} as const

/**
 * Hosts where the **subdomain is the company**, so the key keeps it.
 *
 * Without this list `normalizeHost` reduces to the registrable domain and
 * `acme.myshopify.com`, `brand.squarespace.com` and `shop.bigcartel.com` all
 * collapse to their platform — that is, **every store on that platform becomes
 * one lead**, which for an e-commerce persona is the entire corpus merged into a
 * handful of rows. Silent, too: nothing errors, the counters look healthy, and
 * one company arrives carrying another's signals.
 *
 * The same short-circuit `jobScout.atsHosts` applies for
 * `boards.greenhouse.io/acme`, for the same structural reason — a platform host
 * identifies the platform, never the tenant.
 *
 * **This list is wrong until each platform is added**, which is why a bare
 * platform domain with no tenant subdomain is dropped rather than stored: an
 * unrecognised platform costs coverage, a mis-keyed one costs correctness.
 */
export const PLATFORM_HOSTS: readonly string[] = [
  'myshopify.com',
  'squarespace.com',
  'sqsp.net',
  'wixsite.com',
  'editorx.io',
  'bigcartel.com',
  'webflow.io',
  'webnode.com',
  'weebly.com',
  'shoplineapp.com',
  'ecwid.com',
  'storenvy.com',
  'square.site',
  'company.site',
  'notion.site',
  'framer.app',
  'framer.website',
  'carrd.co',
  'github.io',
  'gitlab.io',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'herokuapp.com',
  'substack.com',
  'etsy.com',
  'gumroad.com',
  'bandcamp.com',
  'blogspot.com',
  'wordpress.com',
  'medium.com',
  'tumblr.com',
]

/**
 * Hosts that are never an employer, **beyond** the ones the job pipeline already
 * knows about.
 *
 * `jobScout.excludedHosts` and `jobScout.atsHosts` cover boards, marketplaces and
 * applicant-tracking systems, and the lead extractor reads both. This list is
 * what they do not cover: **communities and aggregators whose postings are
 * *about* employers rather than *by* them.**
 *
 * It exists because of a measured failure rather than a hypothesis. Against the
 * live table, all 211 Hacker News hiring-thread postings in three weeks
 * normalized to `ycombinator.com` and collapsed into a single lead — carrying
 * whichever company name happened to arrive first, and every other employer's
 * signal piling in behind it. Nothing errored; the counters looked healthy.
 *
 * That is the same silent-merge failure `PLATFORM_HOSTS` prevents, arriving from
 * a third direction, and it is the strongest argument for why the sonar lead
 * scout resolves a company's *own* site rather than trusting where a posting was
 * found.
 *
 * Kept here rather than added to `jobScout.excludedHosts`: that list is read by
 * the job scout to decide which companies it may propose, and adding to it would
 * change what the job pipeline does.
 */
export const NOT_AN_EMPLOYER_HOSTS: readonly string[] = [
  'ycombinator.com',
  'reddit.com',
  'stackoverflow.com',
  'hnhiring.com',
  'workatastartup.com',
  'producthunt.com',
  'crunchbase.com',
  'glassdoor.com',
  'levels.fyi',
  'teamblind.com',
]

/**
 * Multi-part public suffixes, so `acme.co.uk` does not reduce to `co.uk`.
 *
 * A deliberate short list rather than the full public-suffix list, which is
 * ~9,000 entries updated continuously and would be a dependency plus a refresh
 * story for a problem this size. These cover the markets the reader actually
 * sells into; anything missing over-reduces by one label, and the failure is
 * visible — two unrelated companies merging under `co.za` is the kind of thing a
 * reader reports immediately, unlike the platform-host failure above which looks
 * like normal output.
 */
export const MULTI_PART_SUFFIXES: readonly string[] = [
  'co.uk',
  'org.uk',
  'me.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'or.jp',
  'ne.jp',
  'co.kr',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.mx',
  'com.ar',
  'com.tr',
  'com.cn',
  'com.hk',
  'com.sg',
  'com.my',
  'co.in',
  'co.il',
  'co.za',
  'com.es',
  'com.pl',
  'com.ua',
]

/**
 * The kinds of dated public event that can make a company a lead.
 *
 * A closed set on purpose. Each kind is a different question a scorer asks and a
 * different sentence a writer writes, and *"the reader may invent a signal kind"*
 * would make both un-writable. Extending it is a code change plus a prompt
 * change, which is the correct amount of friction.
 *
 * `hiring` is the one that costs nothing: it reads the `jobs` table the other
 * pipeline already fills.
 */
export const LEAD_SIGNAL_KINDS = ['hiring', 'funding', 'launch', 'rebrand'] as const

export type LeadSignalKind = (typeof LEAD_SIGNAL_KINDS)[number]

/** Human labels, for the footer of a delivered lead and for `/clients`. */
export const LEAD_SIGNAL_LABELS: Record<LeadSignalKind, string> = {
  hiring: 'hiring',
  funding: 'just raised',
  launch: 'just launched',
  rebrand: 'rebranding',
}
