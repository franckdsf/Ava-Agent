import { pipeline } from '../config/pipeline.js'

/**
 * Groups near-duplicate headlines so the same story carried by five outlets is
 * ranked and delivered once.
 *
 * Deliberately lexical rather than embedding-based: normalized-title Jaccard
 * catches "OpenAI releases GPT-X" across outlets very reliably, costs nothing,
 * and needs no model call. Swap in embeddings only if this visibly under-merges.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'nor', 'so', 'yet', 'of', 'to', 'in', 'on', 'at',
  'by', 'from', 'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
  'this', 'that', 'these', 'those', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'new',
  'now', 'how', 'why', 'what', 'when', 'you', 'your', 'we', 'our', 'about', 'into', 'over',
])

const MONTHS = new Set([
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june',
  'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov',
  'november', 'dec', 'december',
])

/**
 * Lowercased, punctuation-stripped, stopword-free token set.
 *
 * Short tokens are dropped except numeric ones — "26" and "5" carry the version
 * or date that distinguishes one release from another, so they must survive.
 */
export function titleTokens(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => (token.length > 2 || /\d/.test(token)) && !STOPWORDS.has(token))
  return new Set(tokens)
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/** Tokens naming *which* version or date a title refers to. */
function versionTokens(tokens: Set<string>): Set<string> {
  const found = new Set<string>()
  for (const token of tokens) {
    if (/\d/.test(token) || MONTHS.has(token)) found.add(token)
  }
  return found
}

/**
 * Blocks merges that raw similarity gets wrong.
 *
 * Templated titles ("Everything we covered at Release Notes <month> '<yy>")
 * overlap so heavily that Jaccard clears any usable threshold, even though each
 * one is a different release. When both titles name a version or date and those
 * disagree, they are different stories regardless of similarity.
 *
 * Short titles are also over-eager to merge, so they need near-identity.
 */
function canMerge(a: Set<string>, b: Set<string>, score: number): boolean {
  const versionsA = versionTokens(a)
  const versionsB = versionTokens(b)
  if (versionsA.size > 0 && versionsB.size > 0) {
    if (versionsA.size !== versionsB.size) return false
    for (const token of versionsA) if (!versionsB.has(token)) return false
  }
  if (a.size < 4 || b.size < 4) return score >= 0.8
  return true
}

export interface ClusterableItem {
  id: string
  title: string
}

/**
 * Greedy single-pass clustering. Returns one entry per item mapping it to its
 * cluster id — the id of the first item seen in that cluster.
 */
export function clusterItems(items: ClusterableItem[]): { id: string; clusterId: string }[] {
  const representatives: { clusterId: string; tokens: Set<string> }[] = []
  const assignments: { id: string; clusterId: string }[] = []

  for (const item of items) {
    const tokens = titleTokens(item.title)

    let best: { clusterId: string; score: number } | undefined
    for (const rep of representatives) {
      const score = jaccard(tokens, rep.tokens)
      if (score < pipeline.clusterSimilarityThreshold) continue
      if (!canMerge(tokens, rep.tokens, score)) continue
      if (!best || score > best.score) best = { clusterId: rep.clusterId, score }
    }

    if (best) {
      assignments.push({ id: item.id, clusterId: best.clusterId })
    } else {
      representatives.push({ clusterId: item.id, tokens })
      assignments.push({ id: item.id, clusterId: item.id })
    }
  }

  return assignments
}

/** Keeps one representative per cluster, preserving input order. */
export function dedupeByCluster<T extends { id: string }>(
  items: T[],
  assignments: { id: string; clusterId: string }[],
): T[] {
  const clusterOf = new Map(assignments.map(a => [a.id, a.clusterId]))
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of items) {
    const clusterId = clusterOf.get(item.id) ?? item.id
    if (seen.has(clusterId)) continue
    seen.add(clusterId)
    result.push(item)
  }
  return result
}
