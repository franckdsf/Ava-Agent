import type { Job, JobSearch } from '../db/schema.js'
import { deriveTags, describesSoftwareWork, tagsOfKind } from './job-tags.js'

/**
 * Decides which postings are worth scoring, without calling a model.
 *
 * This is the stage that keeps the bill proportional to what is plausible. The
 * scorer moves ±10 points on identical input, so a threshold cut at that noise
 * level drops good postings at random — filter on what can be *checked*, and
 * spend the model only on what survives
 * ([ADR-0024](../../docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)).
 *
 * **Every rule here is a rejection, and every rejection is explainable.** A
 * posting is kept unless something concrete rules it out, and the reason is
 * returned rather than discarded — so "why didn't I see that?" is answerable for
 * postings that never reached the model at all, not just for ones that scored
 * badly.
 *
 * **The bias is deliberately toward keeping.** A wrongly rejected posting is
 * invisible and costs the reader a job; a wrongly kept one costs a fraction of a
 * model call and is caught by the score. Every ambiguity below therefore
 * resolves to "keep".
 */

export interface FilterVerdict {
  keep: boolean
  /** Why it was rejected. Empty when kept. */
  reason?: string
}

const lower = (values: string[]): string[] => values.map(value => value.toLowerCase())

/** Whether any term appears in the posting's searchable text. */
function mentions(job: Job, terms: string[]): boolean {
  if (terms.length === 0) return false
  const haystack = `${job.title}\n${job.company}\n${job.description ?? ''}`.toLowerCase()
  return lower(terms).some(term => haystack.includes(term))
}

/**
 * Applies one search's deterministic criteria to one posting.
 *
 * Order matters only for which reason is reported first, and the cheapest and
 * most decisive checks come first so the common rejections are also the fastest.
 */
export function filterJob(job: Job, search: JobSearch): FilterVerdict {
  const tags = job.derivedTags

  // Not software work at all — **and only a rejection when the reader is asking
  // for software work.** The flag itself is honest: `deriveTags` sets it when a
  // title claims no engineering discipline and does name a nurse, a teacher or a
  // dental role. Rejecting on it unconditionally was the bug, because
  // `NON_TECHNICAL` then decided which professions the reader is allowed to want.
  // A `/target dentist in Lyon` had every result dropped with the reason "not a
  // software role" before a single search criterion was read.
  //
  // Still the single biggest saving on a general board for the searches that are
  // about engineering, which is why it stays first rather than being deleted.
  if (tags.includes('flag:non-technical') && searchWantsSoftware(search)) {
    return { keep: false, reason: 'not a software role' }
  }

  // Anything the reader ruled out, in the posting's own words. Checked before
  // the positive rules because a dealbreaker outranks every other signal.
  if (search.dealbreakers.length > 0 && mentions(job, search.dealbreakers)) {
    const hit = lower(search.dealbreakers).find(term =>
      `${job.title} ${job.company} ${job.description ?? ''}`.toLowerCase().includes(term),
    )
    return { keep: false, reason: `mentions "${hit}", which you ruled out` }
  }

  // Remote. Only the two absolute answers filter; `preferred` and `any` do not,
  // which is why reading a preference into "Paris or remote" costs nothing.
  if (search.remote === 'required' && job.remote === 'onsite') {
    return { keep: false, reason: 'on-site, and you asked for remote only' }
  }
  if (search.remote === 'onsite' && job.remote === 'remote') {
    return { keep: false, reason: 'remote, and you asked for on-site only' }
  }

  // Location, and only for a posting that is not remote — a remote role is
  // available wherever the reader is, whatever geography its advert names.
  if (search.locations.length > 0 && job.remote !== 'remote' && job.location) {
    const location = job.location.toLowerCase()
    if (!lower(search.locations).some(wanted => location.includes(wanted))) {
      return { keep: false, reason: `based in ${job.location}` }
    }
  }

  // Seniority, from the title. A posting whose title states no level is **kept**:
  // plenty of good adverts say only "Software Engineer", and rejecting those
  // would quietly remove a large share of everything worth reading.
  const levels = tagsOfKind(tags, 'level')
  if (search.seniority.length > 0 && levels.length > 0) {
    const wanted = lower(search.seniority)
    if (!levels.some(level => wanted.some(want => want.includes(level) || level.includes(want)))) {
      return { keep: false, reason: `it is a ${levels.join('/')} role` }
    }
  }

  // Must-haves, read from the posting's text rather than from its own tags —
  // which are noise on every board measured. Checked last because it is the
  // rule most likely to be too strict, and the reason names what was missing.
  if (search.mustHave.length > 0 && !mentions(job, search.mustHave)) {
    return { keep: false, reason: `never mentions ${search.mustHave.join(' or ')}` }
  }

  return { keep: true }
}

/**
 * Whether this search is asking for software work, in the reader's own words.
 *
 * Read from what they typed — the label, the request, the must-haves and the
 * notes — rather than from a stored flag, because nothing asks them to declare a
 * field and nothing should. `/target front end developer` names a discipline,
 * `/target React and TypeScript, remote` names a stack, and `/target dentist in
 * Lyon` names neither, which is the whole distinction needed.
 *
 * `dealbreakers` are deliberately excluded. "No JavaScript" would otherwise make
 * a search look like a software search on the strength of what it rules *out*.
 */
function searchWantsSoftware(search: JobSearch): boolean {
  return describesSoftwareWork(
    [search.label, search.request, ...search.mustHave, search.notes ?? ''].join('\n'),
  )
}

/**
 * How many of a search's hard constraints are actually set.
 *
 * A target with none of them rejects almost nothing: measured on a real
 * `/target founding engineer, worldwide` — `remote: required` and every other
 * field empty — the filter dropped **5 postings out of 240**, so the scorer's
 * capped batch was filled with whatever the boards published most recently
 * rather than with anything plausible.
 *
 * `remote` is deliberately excluded from the count. It is set on nearly every
 * target and only `required`/`onsite` reject anything, so counting it would make
 * a useless target look constrained.
 */
export function constraintCount(search: JobSearch): number {
  return [
    search.mustHave.length > 0,
    search.dealbreakers.length > 0,
    search.seniority.length > 0,
    search.locations.length > 0,
    search.contractTypes.length > 0,
    search.minCompensation !== null,
  ].filter(Boolean).length
}

/**
 * Technologies named anywhere in the reader's CV.
 *
 * Scans the **whole** document rather than going through `deriveTags`, whose
 * `bodyScanChars` cap is right for a job advert — where the stack is stated up
 * front and the tail is boilerplate — and wrong for a CV, where the stack
 * section can sit anywhere in 80,000 characters.
 */
export function cvTechTags(cv: string): Set<string> {
  return new Set(tagsOfKind(deriveTags({ title: '', description: cv }, cv.length), 'tech'))
}

/**
 * How much of the reader's stack and the posting's stack are the same thing.
 *
 * Jaccard — shared over the union — rather than a raw count of shared tags, and
 * the difference is not cosmetic. A count rewards *volume*: an agency advert
 * listing twenty technologies shares more with any CV than a focused one listing
 * nine, whatever the role is. Measured, that put Lemon.io's **Senior Graphic
 * Designer** sixth in the batch, ahead of real engineering postings, purely
 * because the advert names everything the agency staffs for.
 *
 * A plain proportion — shared over the posting's own tags — overcorrects the
 * other way: an advert naming one technology the reader happens to know scores a
 * perfect 1.0 on almost no evidence. Putting the CV in the denominator too fixes
 * both ends at once and needs no tuned constant:
 *
 * | posting | shared | its tags | count | proportion | Jaccard |
 * | --- | --- | --- | --- | --- | --- |
 * | Hygraph, Senior Fullstack | 7 | 9 | 7 | 0.78 | **0.58** |
 * | Lemon.io, Graphic Designer | 6 | 20 | 6 | 0.30 | **0.25** |
 * | one that only says "React" | 1 | 1 | 1 | 1.00 | **0.10** |
 */
function cvAffinity(job: Job, cvTags: Set<string>): number {
  const tags = tagsOfKind(job.derivedTags, 'tech')
  if (tags.length === 0) return 0
  const shared = tags.filter(tag => cvTags.has(tag)).length
  return shared / (cvTags.size + tags.length - shared)
}

/**
 * Orders candidates by that affinity, best first.
 *
 * **Prioritisation, never rejection**, and the asymmetry is the whole argument
 * for doing it this way. A search that survives the filter but not the cap is
 * scored on a later run — it costs days. A posting wrongly *filtered* is gone
 * and the reader never learns it existed. So the CV is allowed to decide what
 * gets looked at first and is never allowed to decide what gets thrown away —
 * which is also why the CV is kept out of the targeter, where it would have
 * produced hard filters from things the reader never said.
 *
 * Recency breaks ties, so a batch with no overlap at all keeps the previous
 * newest-first behaviour exactly.
 */
export function rankByCvOverlap(jobs: Job[], cvTags: Set<string>): Job[] {
  if (cvTags.size === 0) return jobs

  return [...jobs].sort((a, b) => {
    const difference = cvAffinity(b, cvTags) - cvAffinity(a, cvTags)
    return difference !== 0 ? difference : b.discoveredAt - a.discoveredAt
  })
}

export interface FilterOutcome {
  kept: Job[]
  /** Rejections, for reporting. Counted by reason rather than kept per posting. */
  rejected: Map<string, number>
}

/** Runs one search's filter over a batch, tallying why things were dropped. */
export function filterJobs(jobs: Job[], search: JobSearch): FilterOutcome {
  const kept: Job[] = []
  const rejected = new Map<string, number>()

  for (const job of jobs) {
    const verdict = filterJob(job, search)
    if (verdict.keep) {
      kept.push(job)
      continue
    }
    // Tallied by the *shape* of the reason, so a hundred postings rejected for
    // being on-site read as one line rather than a hundred.
    const key = verdict.reason ?? 'rejected'
    rejected.set(key, (rejected.get(key) ?? 0) + 1)
  }

  return { kept, rejected }
}
