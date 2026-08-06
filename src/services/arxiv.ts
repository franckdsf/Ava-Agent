import { arxiv } from '../config/arxiv.js'

/**
 * Narrowing an arXiv category feed to what a beat actually follows.
 *
 * A category listing (`rss.arxiv.org/rss/cs.AI`) is every paper announced that
 * day. arXiv's API takes a search query instead, so the beat's own subtopics
 * become abstract terms and the feed arrives pre-filtered. See
 * [`src/config/arxiv.ts`](../config/arxiv.ts) for the measurement that motivated
 * this.
 *
 * **Deterministic and reversible.** No model runs here; the terms come from a
 * column the reader already controls, and the original URL is recoverable from
 * the query. Nothing decides that a *paper* is relevant — arXiv does the
 * matching and the ranker still scores everything that comes back.
 *
 * The caller is expected to verify the result with `checkFeed()` and fall back
 * to the unscoped URL if it yields nothing. A query that matches no papers is
 * the one real failure mode, and it looks exactly like a healthy quiet feed.
 */

/** A category listing feed, on any of the hosts arXiv serves them from. */
const LISTING = /^https?:\/\/(?:rss|export|www)?\.?arxiv\.org\/rss\/([A-Za-z-]+(?:\.[A-Za-z-]+)?)\/?$/i

/** An API query URL — already scoped, whether by us or by hand. */
const QUERY = /^https?:\/\/export\.arxiv\.org\/api\/query/i

export interface ScopedFeed {
  url: string
  category: string
  /** The subtopics that survived filtering, in the order they went into the query. */
  terms: string[]
}

/** Whether this URL is an arXiv feed of any shape. */
export function isArxivFeed(url: string): boolean {
  return LISTING.test(url.trim()) || QUERY.test(url.trim())
}

/** The category a listing feed covers, or null if this is not a listing. */
export function arxivCategory(url: string): string | null {
  return url.trim().match(LISTING)?.[1] ?? null
}

/**
 * Subtopics → abstract search terms.
 *
 * Subtopics are ranking labels — `ai-research`, `platform-ui`, `design-systems`
 * — so they arrive kebab-cased and are read as phrases. Generic ones are dropped
 * (see `arxiv.uselessTerms`): a beat carrying `frameworks` would otherwise get a
 * query that matches most of computer science while looking specific.
 */
export function termsFromSubtopics(subtopics: readonly string[]): string[] {
  const seen = new Set<string>()
  const terms: string[] = []

  for (const subtopic of subtopics) {
    const phrase = subtopic.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
    if (!phrase || phrase.length < 3) continue
    if (arxiv.uselessTerms.has(phrase)) continue
    // A multi-word label is only useless if every word is — `design systems` is
    // specific, `software engineering` is not.
    if (phrase.split(' ').every(word => arxiv.uselessTerms.has(word))) continue
    if (seen.has(phrase)) continue
    seen.add(phrase)
    terms.push(phrase)
    if (terms.length >= arxiv.maxTerms) break
  }
  return terms
}

/**
 * Proper nouns out of the rubric's HIGH half.
 *
 * Subtopics alone are weak search terms — measured 2026-08-06, `ai-research` and
 * `ai-models` returned a population barely overlapping that day's cs.AI batch.
 * A rubric is longer and sometimes names the *things* the beat is about rather
 * than the shape of news it wants.
 *
 * **Only the HIGH half**, because the LOW half names everything to avoid and
 * searching for it would invert the filter.
 *
 * Only capitalised-mid-line words and acronyms are taken. A rubric is written in
 * criteria — "actually shipped", "with a version number", "no reproducible
 * method" — and those words are about journalism, not about a subject; matching
 * them against arXiv abstracts would return noise with great confidence. A
 * capitalised name in the middle of a line is the one thing in that prose that
 * reliably denotes a thing: `Figma`, `Apple`, `FIA`, `CSS`, `Material`.
 *
 * A rubric that names nothing yields nothing, and that is the correct answer for
 * it — `computer-science`'s HIGH half contains no proper noun at all, because
 * the beat is defined entirely by *what kind* of news it wants.
 */
export function termsFromRubric(rubric: string): string[] {
  const high = rubric.match(/Score HIGH[^\n]*\n([\s\S]*?)(?=Score LOW|$)/i)?.[1]
  if (!high) return []

  const found: string[] = []
  const seen = new Set<string>()

  for (const line of high.split('\n')) {
    // Strip the bullet, then skip the first word: a line opens with a capital
    // whatever it is, so `Official confirmation…` would otherwise yield
    // `official`.
    const words = line.replace(/^\s*[-*•]\s*/, '').trim().split(/\s+/)
    for (const [index, word] of words.entries()) {
      const cleaned = word.replace(/^[^A-Za-z]+|[^A-Za-z0-9/]+$/g, '')
      if (cleaned.length < 2) continue

      // Sentence-initial, not just line-initial. A bullet can hold two
      // sentences — *"…not just a benchmark delta. Primary sources outrank
      // commentary"* — and skipping only the first word of the line took
      // `Primary` as a proper noun. It then matched a fifth of cs.AI (primary
      // care, primary key, …) and the extra yield read as the feature working.
      const previous = words[index - 1]
      const afterStop = previous !== undefined && /[.!?]["')\]]?$/.test(previous)
      if (index === 0 || afterStop) continue

      const acronym = /^[A-Z]{2,6}$/.test(cleaned)
      const properNoun = /^[A-Z][a-z]+$/.test(cleaned)
      if (!acronym && !properNoun) continue

      const term = cleaned.toLowerCase()
      if (arxiv.uselessTerms.has(term) || seen.has(term)) continue
      seen.add(term)
      found.push(term)
      if (found.length >= arxiv.maxTerms) return found
    }
  }
  return found
}

/**
 * Every term a beat can offer, most specific first.
 *
 * Rubric proper nouns lead because they name things; subtopics fill the rest.
 * Merged rather than chosen between — a beat that yields two of each gets a
 * better query than either source alone, and a beat whose rubric names nothing
 * is exactly where the subtopics are still needed.
 */
export function termsForBeat(beat: { subtopics: readonly string[]; rubric: string }): string[] {
  const terms = [...termsFromRubric(beat.rubric)]
  for (const term of termsFromSubtopics(beat.subtopics)) {
    if (!terms.includes(term)) terms.push(term)
    if (terms.length >= arxiv.maxTerms) break
  }
  return terms.slice(0, arxiv.maxTerms)
}

/**
 * Rewrites a category listing into a query scoped to the beat's subtopics.
 *
 * Returns null — meaning "leave the URL alone" — when this is not an arXiv
 * listing, when it is already a query, or when the beat has too few usable
 * subtopics to narrow anything. Silently returning an unscoped feed is the right
 * outcome in all three cases; a beat reading all of cs.AI is expensive, and a
 * beat reading an empty query reads nothing at all.
 */
export function scopeArxivFeed(
  url: string,
  beat: { subtopics: readonly string[]; rubric: string },
): ScopedFeed | null {
  const category = arxivCategory(url)
  if (category === null) return null

  const terms = termsForBeat(beat)
  if (terms.length < arxiv.minTerms) return null

  // `abs:` rather than `all:` — `all:` includes the full text and matches a
  // paper that mentions the phrase once in its related work, which is most of
  // them. The abstract is the paper's own claim about what it is.
  const clause = terms.map(term => `abs:"${term}"`).join(' OR ')
  const search = `cat:${category} AND (${clause})`

  const query = new URLSearchParams({
    search_query: search,
    sortBy: 'submittedDate',
    sortOrder: 'descending',
    max_results: String(arxiv.maxResults),
  })

  return { url: `${arxiv.apiBase}?${query.toString()}`, category, terms }
}
