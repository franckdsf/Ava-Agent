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
 * `feed-discovery.ts` kept its own copy until slice 7 (audit F10), on the grounds
 * that folding it in would edit a working path in a second pipeline. The copy was
 * the same fetch — headers, redirects, empty body on a non-200 — so it is now a
 * wrapper like the job scout's: it passes `discovery.browserUserAgent` and its own
 * timeout, and returns the bare string its callers read.
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
  /**
   * Where the response actually came from, after every redirect.
   *
   * **Not the same thing as the URL that was requested, and the difference is a
   * bug this returned nothing about for two months.** `redirect: 'follow'` is
   * right — a careers page behind a 301 is still a careers page — but the caller
   * was left believing it had read the URL it asked for. A site that redirects
   * `/careers` to `/` therefore stored *the homepage* as a verified careers page,
   * with the homepage's own text as the evidence that verified it, and the reader
   * got a job link to a marketing front page.
   *
   * Falls back to the requested URL when there was no response to read one off.
   */
  finalUrl: string
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
    // `response.url` is the final URL after redirects — empty only in exotic
    // cases, so the requested URL stands in rather than an empty string reaching
    // a caller that is about to store it.
    const finalUrl = response.url || url
    return response.ok ?
        { html: await response.text(), ok: true, finalUrl }
      : { html: '', ok: false, finalUrl }
  } catch {
    return { html: '', ok: false, finalUrl: url }
  }
}
