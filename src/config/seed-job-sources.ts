import type { NewJobSource } from '../db/schema.js'

/**
 * Starter job sources, applied once to an empty table.
 *
 * A *seed*, not configuration — the same relationship `seed-beats.ts` has to
 * `beats`. Editing this does not reach a source that already exists, and the
 * table is the authority the moment it has anything in it.
 *
 * **Chosen for signal, not volume.** The first draft included Arbeitnow, which
 * returned 175 postings on page one and opened with a private-banking adviser,
 * two accountants and a run of German on-site clerical roles — 62% of all volume
 * and close to none of the relevance. It was dropped rather than left for the
 * filters to discard, because a source whose output is almost entirely noise
 * costs a fetch, a parse and a tagging pass on every run to produce nothing. It
 * is the only free source of on-site European roles, so re-add it as a row if
 * that ever matters; nothing in the code was removed with it.
 *
 * **Remote OK went the same way on 2026-08-06, and for a worse reason: it is no
 * longer returning jobs at all.** Its free API answers 200 with 100 entries whose
 * `position` field holds scraped page furniture rather than a role — `Waitology`,
 * `Company Name`, `Optimize`, `Share`, `EMPLOYEES`, `15 15`, `NO CURRENT
 * OPENINGS`, `Currently no vacancies`, `Express your interest`. **Two of the 100
 * carry an engineering title.** It is not our parsing (the adapter reads
 * `position` and `company`, and those fields contain the junk), it is not bot
 * detection (an honest UA and a browser UA get byte-identical payloads, and
 * `?tags=dev` reaches three of 100), and their RSS now answers `410 Gone`. Forty
 * four of the 100 descriptions also arrive mojibaked from the API itself.
 *
 * It mattered because it was the *largest* source in the table — 178 of 526
 * stored rows, 34% of everything — and the deterministic filter absorbed all of
 * it silently, which is exactly why it went unnoticed for two runs: the garbage
 * never reached the reader, so the pipeline looked healthy while a third of every
 * scoring window was spent on page fragments.
 *
 * `fromRemoteOk` stays in `job-fetch.ts`, as `fromArbeitnow` did. If the board
 * ever serves real postings again, this is one row.
 *
 * **What is deliberately absent: LinkedIn and Indeed.** Both killed their feeds
 * and actively block scrapers. A direct integration would break within weeks and
 * would fail *silently*, which is worse than the coverage gap
 * ([ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)).
 * `sonar` is how this set is reached past, and it is wired — see the row at the
 * bottom. `apify` remains a discriminator with no actor behind it; it is metered,
 * so it needs a cap before it is turned on.
 *
 * Every board here is free and needs no key. That is not a coincidence — it is
 * the constraint that picked them. Two of the four ask for attribution and a
 * link back to the posting's own URL, which every delivered message does.
 */

const now = () => Date.now()

export const SEED_JOB_SOURCES: NewJobSource[] = [
  {
    id: 'himalayas',
    kind: 'api',
    adapter: 'himalayas',
    // Caps a page at 20 whatever `limit` says. Seed extra rows at higher
    // `offset` values to widen it — that is what sources being rows is for.
    url: 'https://himalayas.app/jobs/api?limit=20&offset=0',
    label: 'Himalayas',
    addedAt: now(),
  },
  {
    id: 'jobicy',
    kind: 'api',
    adapter: 'jobicy',
    url: 'https://jobicy.com/api/v2/remote-jobs?count=50',
    label: 'Jobicy',
    addedAt: now(),
  },
  {
    id: 'remotive',
    kind: 'api',
    adapter: 'remotive',
    url: 'https://remotive.com/api/remote-jobs',
    label: 'Remotive',
    addedAt: now(),
  },
  {
    id: 'weworkremotely-fullstack',
    kind: 'rss',
    adapter: null,
    url: 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
    label: 'We Work Remotely',
    addedAt: now(),
  },
  {
    id: 'weworkremotely-frontend',
    kind: 'rss',
    adapter: null,
    url: 'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss',
    label: 'We Work Remotely',
    addedAt: now(),
  },
  {
    id: 'weworkremotely-backend',
    kind: 'rss',
    adapter: null,
    url: 'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss',
    label: 'We Work Remotely',
    addedAt: now(),
  },
  {
    id: 'weworkremotely-programming',
    kind: 'rss',
    adapter: null,
    url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss',
    label: 'We Work Remotely',
    addedAt: now(),
  },
  {
    id: 'weworkremotely-devops',
    kind: 'rss',
    adapter: null,
    url: 'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
    label: 'We Work Remotely',
    addedAt: now(),
  },
  {
    /**
     * The one source that is not a board.
     *
     * `perplexity/sonar` is asked which companies are hiring for each active
     * search, and `services/job-scout.ts` resolves and verifies the careers page
     * — the model never supplies a URL that is stored. It exists to reach the
     * employers who hire through their own site and never appear on a free remote
     * board, which is the coverage gap ADR-0024 records as this pipeline's cost.
     *
     * **`url` is documentation, not an endpoint.** Nothing fetches it. Every
     * other row's URL is what gets requested; this one's query is built per
     * search at run time, so the field holds the model id that does the searching
     * instead of a lie about where the postings come from.
     *
     * It is a row so it can be switched off like any other source: archive it and
     * the scheduled model call stops, with no code change and no redeploy.
     */
    id: 'sonar',
    kind: 'sonar',
    adapter: null,
    url: 'openrouter/perplexity/sonar',
    label: 'Sonar',
    addedAt: now(),
  },
]
