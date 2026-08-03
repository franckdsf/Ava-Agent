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
 * **What is deliberately absent: LinkedIn and Indeed.** Both killed their feeds
 * and actively block scrapers. A direct integration would break within weeks and
 * would fail *silently*, which is worse than the coverage gap
 * ([ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)).
 * The `sonar` and `apify` kinds exist for reaching past this set; neither is
 * wired yet, and `apify` is metered, so it needs a cap before it is.
 *
 * Everything here is free and needs no key. That is not a coincidence — it is
 * the constraint that picked them. Three of the five ask for attribution and a
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
    id: 'remoteok',
    kind: 'api',
    adapter: 'remoteok',
    url: 'https://remoteok.com/api',
    label: 'Remote OK',
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
]
