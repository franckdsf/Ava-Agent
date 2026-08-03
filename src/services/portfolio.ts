import { portfolio } from '../config/portfolio.js'

/**
 * Fetches the reader's CV from their portfolio.
 *
 * One function, every guard in it, and it throws rather than returning a partial
 * result — the caller's job is to say so loudly in Chat, not to carry on with
 * something that might be a login page. See `src/config/portfolio.ts` for why
 * nothing is cached and nothing is distilled.
 */

/** Why a fetch was rejected. Distinct from a thrown network error on purpose. */
export type PortfolioFailure =
  | 'unconfigured'
  | 'unreachable'
  | 'status'
  | 'content-type'
  | 'too-short'

export class PortfolioError extends Error {
  constructor(
    readonly reason: PortfolioFailure,
    message: string,
  ) {
    super(message)
    this.name = 'PortfolioError'
  }
}

export interface Portfolio {
  markdown: string
  chars: number
  /** True when the document exceeded `maxChars` and the tail was dropped. */
  truncated: boolean
  contentType: string
  fetchedAt: number
}

/** Whether an endpoint is configured at all, without throwing. */
export function portfolioConfigured(): boolean {
  return Boolean(process.env.PORTFOLIO_FEED_URL)
}

/**
 * Reads the CV, or throws a `PortfolioError` naming which guard rejected it.
 *
 * The bearer token is optional so the same code path works against a public
 * endpoint, but it is what the real one needs — a portfolio carrying more than
 * the public site is exactly the case this exists for.
 */
export async function fetchPortfolio(): Promise<Portfolio> {
  const url = process.env.PORTFOLIO_FEED_URL
  if (!url) {
    throw new PortfolioError(
      'unconfigured',
      'PORTFOLIO_FEED_URL is unset, so there is no CV to score against. See .env.example.',
    )
  }
  const token = process.env.PORTFOLIO_FEED_TOKEN

  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'text/markdown, text/plain',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      // Without this a hung request stalls the step forever; `fetch` has no
      // ambient deadline.
      signal: AbortSignal.timeout(portfolio.timeoutMs),
    })
  } catch (error) {
    // A timeout arrives here as a TimeoutError, indistinguishable from DNS or
    // connection failure to the caller — and the same thing to do about it.
    throw new PortfolioError(
      'unreachable',
      `Could not reach the portfolio: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    throw new PortfolioError(
      'status',
      `The portfolio answered ${response.status} ${response.statusText}. ` +
      (response.status === 401 || response.status === 403
        ? 'That is an auth failure — check PORTFOLIO_FEED_TOKEN.'
        : 'Nothing was read.'),
    )
  }

  // The header is the honest signal and the reason no `<`-sniffing is needed:
  // a deployment-protection wall or an SSO redirect answers `text/html`, and a
  // 200 carrying HTML is exactly what would otherwise be scored as a CV.
  const contentType = response.headers.get('content-type') ?? ''
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!portfolio.acceptedContentTypes.some(accepted => accepted === type)) {
    throw new PortfolioError(
      'content-type',
      `The portfolio answered 200 but with content-type "${contentType || 'none'}", ` +
      `not ${portfolio.acceptedContentTypes.join(' or ')}. That is usually a login ` +
      'wall or a redirect rather than the document.',
    )
  }

  const body = await response.text()
  if (body.trim().length < portfolio.minChars) {
    throw new PortfolioError(
      'too-short',
      `The portfolio returned ${body.trim().length} characters, under the ` +
      `${portfolio.minChars} floor. A valid 200 carrying nothing is what an empty ` +
      'deploy looks like.',
    )
  }

  const truncated = body.length > portfolio.maxChars
  return {
    markdown: truncated ? body.slice(0, portfolio.maxChars) : body,
    chars: body.length,
    truncated,
    contentType: type,
    fetchedAt: Date.now(),
  }
}
