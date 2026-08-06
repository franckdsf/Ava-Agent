import { DOMAINS, jobTaxonomy, SENIORITY } from '../config/job-taxonomy.js'

/**
 * Derives a posting's tags from its own words.
 *
 * This is the stage that keeps the model bill proportional to what is plausible.
 * The filter decides from these tags and a search's criteria whether a posting
 * is worth scoring at all. Nothing here calls a model, and it runs in
 * microseconds per posting.
 *
 * Tags are namespaced by kind so one column can hold all of them and a filter
 * can ask for exactly one kind without a second table:
 *
 * ```
 * domain:software      the field this posting belongs to
 * discipline:software.frontend
 * skill:chemistry.chromatography
 * level:senior
 * flag:untagged        nothing recognised at all
 * ```
 *
 * **Disciplines and skills are namespaced by their domain**, which the old flat
 * `discipline:qa` could not be: software's `quality` means test automation and
 * chemistry's means a QC bench, and a filter reading them as one thing would
 * match a chemist to a testing role. The domain prefix is what lets two fields
 * use the same English word for different work.
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

interface CompiledGroup {
  tag: string
  patterns: RegExp[]
}

interface CompiledDomain {
  id: string
  disciplines: CompiledGroup[]
  skills: CompiledGroup[]
}

const compileGroups = (source: Record<string, string[]>, prefix: string): CompiledGroup[] =>
  Object.entries(source).map(([tag, terms]) => ({
    tag: `${prefix}${tag}`,
    patterns: terms.map(termPattern),
  }))

/** Built once — a few hundred regexes compiled per posting would dominate the cost. */
const COMPILED: { domains: CompiledDomain[]; seniority: CompiledGroup[] } = {
  domains: Object.entries(DOMAINS).map(([id, vocabulary]) => ({
    id,
    disciplines: compileGroups(vocabulary.disciplines, `${id}.`),
    skills: compileGroups(vocabulary.skills ?? {}, `${id}.`),
  })),
  seniority: compileGroups(SENIORITY, ''),
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
 * **Disciplines and seniority read the title; skills read the body too.** That
 * split is the whole accuracy of this function. A backend advert saying "you'll
 * work alongside our React team" is not a frontend job, and matching disciplines
 * body-wide tags it as one — which turns the filter from something that saves
 * model calls into something that spends them on the wrong postings. A stack or
 * an instrument list, by contrast, is genuinely stated in the requirements.
 *
 * **Domain membership comes from disciplines only, never from skills.** A
 * polymer advert that asks for Python somewhere in its body is not a software
 * posting, and a domain read from the body would make it one — then a software
 * search would keep it and the saving this stage exists for would quietly leak
 * away. Skills are tagged for `rankByCvOverlap`, which may only reorder.
 *
 * A posting may hold several domains, and that is the intended outcome for an
 * ambiguous title: "Chemical Engineer" is both `domain:software` (bare
 * `engineer`) and `domain:chemistry`, so a search in either field keeps it.
 */
export function deriveTags(
  posting: TaggedPosting,
  /**
   * How much of the body to scan. The default is right for a job advert, where
   * the requirements are stated up front and the tail is boilerplate; a CV needs
   * the whole document, because its skills section can sit anywhere in 80,000
   * characters.
   */
  bodyChars: number = jobTaxonomy.bodyScanChars,
): string[] {
  const title = posting.title
  const body = `${title}\n${(posting.description ?? '').slice(0, bodyChars)}`
  const tags: string[] = []

  for (const domain of COMPILED.domains) {
    let inDomain = false
    for (const { tag, patterns } of domain.disciplines) {
      if (matches(patterns, title)) {
        tags.push(`discipline:${tag}`)
        inDomain = true
      }
    }
    for (const { tag, patterns } of domain.skills) {
      if (matches(patterns, body)) tags.push(`skill:${tag}`)
    }
    if (inDomain) tags.push(`domain:${domain.id}`)
  }

  for (const { tag, patterns } of COMPILED.seniority) {
    if (matches(patterns, title)) tags.push(`level:${tag}`)
  }

  // Nothing recognised at all. Worth its own flag rather than an empty list,
  // because "we could not read this" and "this is not for you" are different
  // answers and the filter must not treat them the same — an untagged posting is
  // let through to the model rather than discarded.
  if (tags.length === 0) tags.push('flag:untagged')

  return tags
}

/**
 * Derives tags for a CV, scanning the whole document.
 *
 * Separate from `deriveTags` only in that it lifts the body cap, which is right
 * for an advert and wrong for a CV — see the `bodyChars` note above.
 */
export function deriveCvTags(cv: string): string[] {
  return deriveTags({ title: '', description: cv }, cv.length)
}

/** The values of one namespace — `tagsOfKind(tags, 'domain')` → `['software']`. */
export function tagsOfKind(tags: string[], kind: string): string[] {
  const prefix = `${kind}:`
  return tags.filter(tag => tag.startsWith(prefix)).map(tag => tag.slice(prefix.length))
}
