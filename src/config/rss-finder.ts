/**
 * rssfinder.app — someone else's index of feeds, asked one question at a time.
 *
 * The site is a static Next.js export whose search is one GraphQL call from the
 * browser to `https://rssfinder.app/gql`, unauthenticated. There is no documented
 * API and no key: the operation below is the one the page itself sends, read out
 * of its JS bundle on 2026-08-06 and verified against the live endpoint.
 *
 * **Which makes it a source to probe, never one to trust.** It returns feed URLs
 * directly, which is exactly what [AGENTS.md](../../AGENTS.md#gotchas) says never
 * to accept from a search — a wrong feed URL never errors, it is stored as a
 * source that silently returns nothing forever. So nothing here writes, and
 * `checkFeed()` stays the only authority on whether a URL is a feed. The same
 * rule the `sonar` scout follows, applied to an index rather than a model.
 *
 * It is also somebody's private endpoint that could change or close without
 * notice. Keep the query in one place so the day it breaks there is one file to
 * re-read the bundle against.
 */
export const rssFinder = {
  /** The GraphQL endpoint the site's own search posts to. */
  endpoint: 'https://rssfinder.app/gql',

  /**
   * The operation the page sends, named as it names it.
   *
   * `text` carries both kinds of search — the site has one input, and decides
   * between them itself: anything that parses as a URL is prefixed with
   * `https://` and answered in `urlResult`, anything else is a keyword search
   * answered in `textResult`. `searchText()` reproduces that normalization.
   */
  query: `query searchInFinder($text: String!) {
  searchInFinder(text: $text) {
    textResult { feeds { title description icon url } related }
    urlResult { feeds { title description icon url } related }
  }
}`,

  /**
   * One search. Generous, because it is a single request to a stranger's server
   * and the alternative to waiting is reporting no feeds for a query that has
   * them.
   */
  timeoutMs: 20_000,

  /**
   * Feeds verified at once when `--verify` is passed. Matches
   * `discovery.siteConcurrency` for the same reason: a burst of requests to
   * unrelated strangers, fired because one person typed one line.
   */
  verifyConcurrency: 4,
} as const
