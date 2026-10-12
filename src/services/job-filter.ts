import { domainLabel, isKnownDomain } from '../config/job-taxonomy.js'
import { jobPipeline } from '../config/jobs.js'
import type { Job, JobSearch } from '../db/schema.js'
import { deriveCvTags, deriveTags, tagsOfKind } from './job-tags.js'

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

const WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * A term as a pattern that matches it where a reader would say it is mentioned.
 *
 * Substring matching made a must-have of "Go" pass on "good", "Google" and
 * "ago" — every posting — and "Rust" pass on "trust". So a term must start a
 * word; and a short one must also end one, allowing a plural ("APIs"). A long
 * term may run on ("React" in "ReactJS"), which is the bias toward keeping. An
 * edge that is not itself a letter or digit gets no boundary, so ".NET" still
 * matches "ASP.NET" and "C++" ends where it ends.
 */
function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = WORD_CHAR.test(term.at(0) ?? '') ? '(?<![\\p{L}\\p{N}])' : ''
  const end = term.length <= jobPipeline.shortTermChars && WORD_CHAR.test(term.at(-1) ?? '') ? 's?(?![\\p{L}\\p{N}])' : ''
  return new RegExp(`${start}${escaped}${end}`, 'iu')
}

/** The first term the posting's searchable text mentions, if any. */
function firstMention(job: Job, terms: string[]): string | undefined {
  const haystack = `${job.title}\n${job.company}\n${job.description ?? ''}`
  return terms.find(term => termPattern(term.trim()).test(haystack))
}

/** Whether any term appears in the posting's searchable text. */
function mentions(job: Job, terms: string[]): boolean {
  return firstMention(job, terms) !== undefined
}

/**
 * Applies one search's deterministic criteria to one posting.
 *
 * Order matters only for which reason is reported first, and the cheapest and
 * most decisive checks come first so the common rejections are also the fastest.
 */
export function filterJob(job: Job, search: JobSearch, tags: string[] = jobTags(job)): FilterVerdict {
  // Not an advert at all. A sonar lead is a careers page, and `listedRoles === 0`
  // means that page offered nowhere to apply — the reader follows the link and
  // finds nothing, which is the failure this rule was written for.
  //
  // **The row is kept in the table on purpose**, so this is the only rejection
  // here that is not a discard: `hiringSignalsFromJobs` reads `jobs` and turns a
  // company-domain URL into a `hiring` signal, so the company still reaches the
  // Leads tab with its careers page as the evidence. A company that is hiring but
  // publishes nothing is a *prospect*, not a job — the two pipelines already
  // disagree about that, and this is where the disagreement gets decided.
  //
  // A count above zero passes, and it passes even when the model's claimed role
  // is not among them: a page with real openings is worth opening whether or not
  // it holds the exact one that was promised.
  if (job.listedRoles === 0) {
    return { keep: false, reason: 'a careers page with no openings on it — kept as a lead instead' }
  }

  // A different field of work entirely — and only ever a rejection when **both**
  // sides name a field. Three ways this declines to fire, and each one is a
  // deliberate bias toward keeping:
  //
  // - the search has no domain (an older row, or a request the targeter could
  //   not place) — then it filters on none, exactly as an empty `seniority` does;
  // - the posting matched no domain — `flag:untagged` goes to the model, because
  //   "we could not read this" is not "this is not for you";
  // - they overlap at all — an ambiguous title like "Chemical Engineer" holds two
  //   domains and is kept by a search in either.
  //
  // This is the single biggest saving on a general board, and unlike the
  // `flag:non-technical` rule it replaces it now runs in every direction: the
  // accountant is skipped for a chemistry search too, where before only software
  // searches got anything at all. See the header of `job-taxonomy.ts` for why the
  // old shape had to be inverted rather than extended.
  const wanted = isKnownDomain(search.domain) ? (search.domain as string) : null
  const found = tagsOfKind(tags, 'domain')
  const [primary] = found
  if (wanted && primary && !found.includes(wanted)) {
    return {
      keep: false,
      reason: `looks like a ${domainLabel(primary)} role, and you asked for ${domainLabel(wanted)}`,
    }
  }

  // Anything the reader ruled out, in the posting's own words. Checked before
  // the positive rules because a dealbreaker outranks every other signal.
  const hit = firstMention(job, search.dealbreakers)
  if (hit !== undefined) {
    return { keep: false, reason: `mentions "${hit.toLowerCase()}", which you ruled out` }
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
 * A posting's tags, derived here rather than read from `jobs.derived_tags`.
 *
 * **This moved out of ingest deliberately.** Tags used to be computed once when
 * a posting was stored, which meant a vocabulary added later never reached the
 * rows already in the table — the same trap `seed-beats.ts` documents ("editing
 * it does not reach a beat that already exists"), and a fatal one for a pipeline
 * whose whole premise is gaining domains over time. A chemistry vocabulary added
 * on a Tuesday would have described no posting collected before it.
 *
 * Derived data is therefore derived when it is *read*. The cost is regex over at
 * most `bodyScanChars` per posting per run — microseconds each, against a
 * scoring batch that costs a model call — and `jobs.derived_tags` keeps being
 * written at ingest as the audit trail of what the vocabulary said that day.
 */
export function jobTags(job: Job): string[] {
  return deriveTags({ title: job.title, description: job.description })
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
 * Skills named anywhere in the reader's CV, across every domain's vocabulary.
 *
 * Scans the **whole** document — `deriveCvTags` lifts the `bodyScanChars` cap,
 * which is right for a job advert, where the requirements are stated up front
 * and the tail is boilerplate, and wrong for a CV, where the skills section can
 * sit anywhere in 80,000 characters.
 *
 * The tags are domain-qualified (`software.react`, `chemistry.chromatography`),
 * so a chemist's CV and a software advert share nothing and score 0 — which is
 * the correct answer, not a bug. Under the flat `tech:` namespace this function
 * returned an empty set for any non-software reader and `rankByCvOverlap`
 * silently became a no-op; it now returns real tags for every curated field.
 */
export function cvSkillTags(cv: string): Set<string> {
  return new Set(tagsOfKind(deriveCvTags(cv), 'skill'))
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
function cvAffinity(jobTagList: string[], cvTags: Set<string>): number {
  const tags = tagsOfKind(jobTagList, 'skill')
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
 *
 * `tags` is the map `filterJobs` already built, passed in rather than re-derived
 * — every job here has just been through the filter, so deriving again would pay
 * the same regex twice for one batch.
 */
export function rankByCvOverlap(
  jobs: Job[],
  cvTags: Set<string>,
  tags: JobTagMap = new Map(),
): Job[] {
  if (cvTags.size === 0) return jobs
  const tagsFor = (job: Job) => tags.get(job.id) ?? jobTags(job)

  return [...jobs].sort((a, b) => {
    const difference = cvAffinity(tagsFor(b), cvTags) - cvAffinity(tagsFor(a), cvTags)
    return difference !== 0 ? difference : b.discoveredAt - a.discoveredAt
  })
}

/** Derived tags by job id, so one batch pays for them once. */
export type JobTagMap = Map<string, string[]>

export interface FilterOutcome {
  kept: Job[]
  /** Rejections, for reporting. Counted by reason rather than kept per posting. */
  rejected: Map<string, number>
  /** What each posting was tagged with, for the ranking step that follows. */
  tags: JobTagMap
}

/** Runs one search's filter over a batch, tallying why things were dropped. */
export function filterJobs(jobs: Job[], search: JobSearch): FilterOutcome {
  const kept: Job[] = []
  const rejected = new Map<string, number>()
  const tags: JobTagMap = new Map()

  for (const job of jobs) {
    const jobTagList = jobTags(job)
    tags.set(job.id, jobTagList)

    const verdict = filterJob(job, search, jobTagList)
    if (verdict.keep) {
      kept.push(job)
      continue
    }
    // Tallied by the *shape* of the reason, so a hundred postings rejected for
    // being on-site read as one line rather than a hundred.
    const key = verdict.reason ?? 'rejected'
    rejected.set(key, (rejected.get(key) ?? 0) + 1)
  }

  return { kept, rejected, tags }
}
