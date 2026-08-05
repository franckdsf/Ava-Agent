import {
  DISCIPLINES,
  jobTaxonomy,
  NON_TECHNICAL,
  SENIORITY,
  TECHNOLOGIES,
} from '../config/job-taxonomy.js'

/**
 * Derives a posting's tags from its own words.
 *
 * This is the stage that keeps the model bill proportional to what is plausible.
 * Every posting gets tagged deterministically at ingest; the filter then decides
 * from those tags and a search's criteria whether a posting is worth scoring at
 * all. Nothing here calls a model, and it runs in microseconds per posting.
 *
 * The tags are namespaced by kind — `discipline:frontend`, `tech:typescript`,
 * `level:senior`, `flag:non-technical` — so one column can hold all of them and
 * a filter can ask for exactly one kind without a second table.
 */

/** Escapes a vocabulary term for use in a word-boundary regex. */
function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `\b` does not fire next to punctuation like `.net` or `c++`, so the boundary
  // is only applied on the sides that begin and end with a word character.
  const left = /^\w/.test(term) ? '\\b' : ''
  const right = /\w$/.test(term) ? '\\b' : ''
  return new RegExp(`${left}${escaped}${right}`, 'i')
}

/** Built once — a few hundred regexes compiled per posting would dominate the cost. */
const COMPILED = {
  disciplines: Object.entries(DISCIPLINES).map(([tag, terms]) => ({
    tag,
    patterns: terms.map(termPattern),
  })),
  technologies: Object.entries(TECHNOLOGIES).map(([tag, terms]) => ({
    tag,
    patterns: terms.map(termPattern),
  })),
  seniority: Object.entries(SENIORITY).map(([tag, terms]) => ({
    tag,
    patterns: terms.map(termPattern),
  })),
  nonTechnical: NON_TECHNICAL.map(termPattern),
}

const matches = (patterns: RegExp[], text: string): boolean =>
  patterns.some(pattern => pattern.test(text))

export interface TaggedPosting {
  title: string
  description: string | null
}

/**
 * Every tag a posting earns, namespaced.
 *
 * **Disciplines and seniority read the title; technologies read the body too.**
 * That split is the whole accuracy of this function. A backend advert saying
 * "you'll work alongside our React team" is not a frontend job, and matching
 * disciplines body-wide tags it as one — which turns the filter from something
 * that saves model calls into something that spends them on the wrong postings.
 * A stack, by contrast, is genuinely listed in the requirements, and a posting
 * that never names a technology does not need it.
 */
export function deriveTags(
  posting: TaggedPosting,
  /**
   * How much of the body to scan. The default is right for a job advert, where
   * the stack is stated up front and the tail is boilerplate; a CV needs the
   * whole document, because its stack section can sit anywhere in 80,000
   * characters.
   */
  bodyChars: number = jobTaxonomy.bodyScanChars,
): string[] {
  const title = posting.title
  const body = `${title}\n${(posting.description ?? '').slice(0, bodyChars)}`
  const tags: string[] = []

  for (const { tag, patterns } of COMPILED.disciplines) {
    if (matches(patterns, title)) tags.push(`discipline:${tag}`)
  }
  for (const { tag, patterns } of COMPILED.seniority) {
    if (matches(patterns, title)) tags.push(`level:${tag}`)
  }
  for (const { tag, patterns } of COMPILED.technologies) {
    if (matches(patterns, body)) tags.push(`tech:${tag}`)
  }

  // A single flag rather than a discipline, because it is used to reject rather
  // than to describe — and because "not software" is a statement about the
  // posting as a whole, not one more category alongside frontend and backend.
  //
  // Only set when the title claims no engineering discipline at all: plenty of
  // real roles mention sales or support in passing ("supporting our sales team"),
  // and a title that says "Software Engineer" is a software job whatever else it
  // says.
  const engineering = tags.some(tag => tag.startsWith('discipline:'))
  if (!engineering && matches(COMPILED.nonTechnical, title)) {
    tags.push('flag:non-technical')
  }

  // Nothing recognised at all. Worth its own flag rather than an empty list,
  // because "we could not read this" and "this is not for you" are different
  // answers and the filter must not treat them the same — an untagged posting is
  // let through to the model rather than discarded.
  if (tags.length === 0) tags.push('flag:untagged')

  return tags
}

/**
 * Whether a piece of text describes software work.
 *
 * Scans the discipline and technology vocabularies over arbitrary prose, rather
 * than a posting's title — which is what separates this from `deriveTags`. It
 * exists for one caller: deciding whether a *search* is a software search, so
 * that `flag:non-technical` can reject for it and stay out of the way otherwise.
 *
 * **Why this is needed at all.** `NON_TECHNICAL` lists `dental`, `nurse`,
 * `physician`, `teacher`, `attorney`, `electrician`. Those entries are correct
 * for a reader looking for engineering work and catastrophic for one looking to
 * be a dentist: the filter dropped every such posting with the reason "not a
 * software role" before any search criteria were read. A pipeline that is meant
 * to answer `/target dentist in Lyon` cannot carry an unconditional opinion about
 * which professions count.
 *
 * Technologies are included alongside disciplines because a search often names a
 * stack and no discipline — `/target React and TypeScript, remote` says what it
 * is without ever using the word "engineer".
 */
export function describesSoftwareWork(text: string): boolean {
  if (!text.trim()) return false
  return (
    COMPILED.disciplines.some(({ patterns }) => matches(patterns, text)) ||
    COMPILED.technologies.some(({ patterns }) => matches(patterns, text))
  )
}

/** The values of one namespace — `tagsOfKind(tags, 'tech')` → `['typescript']`. */
export function tagsOfKind(tags: string[], kind: string): string[] {
  const prefix = `${kind}:`
  return tags.filter(tag => tag.startsWith(prefix)).map(tag => tag.slice(prefix.length))
}
