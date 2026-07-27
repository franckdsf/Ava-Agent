import { pipeline } from '../config/pipeline.js'

/**
 * Article body extraction, kept dependency-free on purpose.
 *
 * A real readability implementation (Mozilla's, or cheerio + heuristics) would
 * extract cleaner text, but the summarizer only ever sees the first
 * `articleMaxChars` of a page it mostly gets from the feed anyway. Boilerplate
 * costs a few tokens; a new dependency costs forever. Revisit if summaries
 * start quoting cookie banners.
 */

/** Elements whose *contents* are never prose. Dropped before tags are stripped. */
const NON_PROSE = /<(script|style|noscript|svg|head|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/**
 * HTML to plain text. Block boundaries become newlines before tags are stripped,
 * so paragraph structure survives into the summarizer's prompt instead of
 * collapsing into one run-on line.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(NON_PROSE, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|tr)>/gi, '\n\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Truncates on a word boundary so the summarizer never sees a severed token. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastBreak = cut.lastIndexOf(' ')
  return `${lastBreak > max * 0.8 ? cut.slice(0, lastBreak) : cut}…`
}

/** Feed body to stored article text. Null when the feed carried nothing usable. */
export function toArticleText(raw: string | undefined | null): string | null {
  if (!raw) return null
  const text = htmlToText(raw)
  return text ? capText(text, pipeline.articleMaxChars) : null
}

/** Fetches a page as HTML, or null if it isn't reachable or isn't HTML. */
async function fetchHtml(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': pipeline.userAgent, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(pipeline.articleTimeoutMs),
    })
    if (!response.ok) return null
    if (!(response.headers.get('content-type') ?? '').includes('html')) return null
    return await response.text()
  } catch {
    return null
  }
}

/**
 * Fallback for feeds that ship only a headline. Returns null rather than
 * throwing: a summary from the excerpt alone beats a failed digest, and plenty
 * of sites answer a bot with 403.
 */
export async function fetchArticleText(url: string): Promise<string | null> {
  const html = await fetchHtml(url)
  return html ? toArticleText(html) : null
}

const OG_IMAGE =
  /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/i
const CONTENT_ATTR = /content=["']([^"']+)["']/i

/**
 * Site chrome masquerading as an article image. A post's own og:image lives
 * with the content; a site-wide fallback lives in the theme or is named for its
 * role. WebKit ships `/wp-content/themes/webkit/images/preview-card.jpg` on
 * every post — the repeat is only detectable after the second article, so the
 * path is worth reading on the first.
 *
 * Tuned to reject rather than accept: a missed image costs a decoration, a
 * wrong one puts the same banner on every message.
 */
const SITE_CHROME =
  /\/(?:themes?|template|static|assets|layouts?)\/|\/(?:og|og-?image|social|share|card|preview-?card|default|placeholder|fallback|logo|banner|icon|avatar)[-_.]?[^/]*\.(?:png|jpe?g|webp|gif|avif)$/i

/** True when the URL looks like a site-wide banner rather than this post's art. */
export function looksLikeSiteChrome(imageUrl: string): boolean {
  try {
    return SITE_CHROME.test(new URL(imageUrl).pathname)
  } catch {
    return false
  }
}

/**
 * The article's own social image, used only when the feed shipped none.
 *
 * Worth having because a post's og:image is usually the post's own artwork —
 * but the same tag is just as often a site-wide banner repeated on every page,
 * which is worse than no image at all. This function only extracts; deciding
 * whether the URL is post-specific is the caller's job, because that needs to
 * compare against what other items from the same feed already carry.
 */
export async function fetchOgImage(pageUrl: string): Promise<string | null> {
  const html = await fetchHtml(pageUrl)
  if (!html) return null
  const tag = OG_IMAGE.exec(html)?.[0]
  const candidate = tag ? CONTENT_ATTR.exec(tag)?.[1] : undefined
  if (!candidate) return null
  try {
    // Resolved against the page: plenty of sites use a root-relative og:image.
    const url = new URL(decodeEntities(candidate), pageUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}
