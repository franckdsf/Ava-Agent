/**
 * Fetching an arbitrary web page as a browser would, for callers that resolve a
 * URL rather than read a feed.
 *
 * Extracted from `job-scout.ts` when the leads pipeline
 * ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md))
 * needed the same primitive. **Shared between the job scout and the lead
 * resolver, and the extraction was made on the condition that the job scout's
 * behaviour does not change** — so this module is deliberately a pure function of
 * its arguments and reads no configuration of its own. Each caller passes its own
 * user agent and timeout, which is what keeps one caller's tuning from moving the
 * other's.
 *
 * **A caller-specific quirk does not belong here.** If the lead resolver needs a
 * different header, a different redirect policy or a retry, it wraps this rather
 * than teaching it — the rule
 * [ADR-0037](../../docs/decisions/0037-the-hiring-thread-as-a-source-kind.md)
 * arrived at from the other direction, when Hacker News's unclosed `<p>` tags
 * were fixed in `job-hn.ts` instead of in the shared `htmlToText`.
 *
 * `feed-discovery.ts` keeps its own copy on purpose. It is the news pipeline's,
 * it returns a bare string, and it reads `discovery.browserUserAgent` for a
 * reason its own note records. Folding it in here would mean editing a working
 * path in a second pipeline to no benefit, which is the drift this comment exists
 * to prevent.
 *
 * Nothing here writes, and no conditional-request state is recorded — the same
 * reason `checkFeed()` does its own fetch.
 */

export interface PageFetchOptions {
  /**
   * Sent verbatim. Callers pass a *browser* UA: job boards and marketing sites
   * sit behind CDNs that are far more hostile to an honest bot agent than RSS
   * publishers are.
   */
  userAgent: string
  /**
   * Hard deadline. There is no ambient timeout on `fetch`, so without one a hung
   * request stalls a workflow step indefinitely.
   */
  timeoutMs: number
}

/** A page that was read, or the fact that it could not be. */
export interface PageFetchResult {
  html: string
  ok: boolean
}

/**
 * Fetches a page as a browser would, **never throwing**.
 *
 * An unreachable page is a result rather than an exception, because a caller
 * still has somewhere to go: the job scout tries well-known paths against a
 * homepage that 403s, and a lead whose signal page fails is judged on the
 * evidence that did resolve.
 *
 * A non-200 returns `ok: false` with an empty body rather than the error page's
 * markup — a 404's own HTML is text, and a caller that measured it against a
 * length floor would read a soft-404 as a real page.
 */
export async function fetchPage(url: string, options: PageFetchOptions): Promise<PageFetchResult> {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': options.userAgent,
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    return response.ok ? { html: await response.text(), ok: true } : { html: '', ok: false }
  } catch {
    return { html: '', ok: false }
  }
}
