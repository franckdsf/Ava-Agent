/**
 * Categories are data, not classes. One curator agent and one workflow are
 * parameterized by these definitions, so adding a beat means adding an entry
 * here — never writing a new agent.
 *
 * What lives here is declarative and git-reviewable. What the curator *learns*
 * (interest profile, feedback history) lives in Convex, keyed by category slug.
 */

export interface FeedDefinition {
  url: string
  /** Shown as the attribution in digests. */
  source: string
  /** Single-purpose feeds can pin a subtopic instead of paying for classification. */
  subtopic?: string
}

export interface CategoryDefinition {
  slug: string
  title: string
  emoji: string
  /** Digest sections, and the label set the ranker must choose from. */
  subtopics: readonly string[]
  feeds: readonly FeedDefinition[]
  /** Injected into the ranker's instructions. This is what makes a curator expert. */
  rubric: string
  /** 0–100. At or above this, an item joins the next scheduled digest. */
  digestThreshold: number
  /** 0–100. At or above this, an item interrupts immediately. */
  breakingThreshold: number
  /** Hard cap so a busy news day can't produce a wall of text. */
  maxItemsPerDigest: number
}

export const CATEGORIES: readonly CategoryDefinition[] = [
  {
    slug: 'computer-science',
    title: 'Computer Science',
    emoji: '🧠',
    subtopics: ['ai-research', 'ai-models', 'frameworks'],
    digestThreshold: 62,
    breakingThreshold: 88,
    maxItemsPerDigest: 6,
    rubric: `
You are curating for a senior software engineer who builds AI applications daily.

Score HIGH (70-100):
- A model, framework, or tool actually shipped — with a version number, release
  post, or public availability. Primary sources outrank commentary about them.
- A research result that changes what is buildable today, not just a benchmark delta.
- Breaking changes, deprecations, or migration requirements in mainstream frameworks.
- A technique with enough detail to reimplement.

Score LOW (0-40):
- Funding rounds, valuations, executive hires, org-chart churn.
- Opinion, prediction, and "the future of X" essays with no new information.
- Benchmark claims with no reproducible method.
- Rewrites of an announcement already covered by the primary source.
- Beginner tutorials on established technology.

Bias toward the primary source when several outlets carry the same story.
`.trim(),
    // All URLs verified reachable 2026-07-27. Re-check with `pnpm feeds:check`.
    feeds: [
      { url: 'https://hnrss.org/frontpage?points=150', source: 'Hacker News' },
      { url: 'https://simonwillison.net/atom/everything/', source: 'Simon Willison' },
      // Note: rss.arxiv.org, not the retired export.arxiv.org. ~220 items/day.
      { url: 'https://rss.arxiv.org/rss/cs.AI', source: 'arXiv cs.AI', subtopic: 'ai-research' },
      { url: 'https://huggingface.co/blog/feed.xml', source: 'Hugging Face', subtopic: 'ai-models' },
      { url: 'https://openai.com/news/rss.xml', source: 'OpenAI', subtopic: 'ai-models' },
      {
        url: 'https://blog.google/technology/google-deepmind/rss/',
        source: 'Google DeepMind',
        subtopic: 'ai-models',
      },
      { url: 'https://nextjs.org/feed.xml', source: 'Next.js', subtopic: 'frameworks' },
      { url: 'https://react.dev/rss.xml', source: 'React', subtopic: 'frameworks' },
      {
        url: 'https://github.blog/changelog/feed/',
        source: 'GitHub Changelog',
        subtopic: 'frameworks',
      },
    ],
  },
  {
    slug: 'design',
    title: 'Design',
    emoji: '🎨',
    subtopics: ['figma', 'platform-ui', 'design-systems', 'libraries'],
    digestThreshold: 62,
    breakingThreshold: 88,
    maxItemsPerDigest: 5,
    rubric: `
You are curating for a senior engineer who ships product UI and cares about craft.

Score HIGH (70-100):
- Figma shipping a feature that changes a real workflow (not marketing recaps).
- Apple or Google changing platform visual language, HIG/Material guidance, or
  system components — especially anything with a migration cost.
- A major design system or UI library release, with concrete API/token changes.
- New CSS or web platform capabilities landing in stable browsers.
- Rigorous, evidence-backed interaction or accessibility research.

Score LOW (0-40):
- Listicles, inspiration roundups, "N design trends for <year>".
- Portfolio showcases and awards.
- Hiring posts, conference recaps with no substance.
- Opinion pieces restating known principles.
- Tool marketing without a shipped capability behind it.

Prefer release notes and changelogs over articles describing them.
`.trim(),
    // All URLs verified reachable 2026-07-27. Re-check with `pnpm feeds:check`.
    // Apple's developer news feed (developer.apple.com/news/rss/news.rss) is
    // returning HTTP 500 server-side; re-add it here if it comes back.
    feeds: [
      {
        url: 'https://www.figma.com/release-notes/feed/atom.xml',
        source: 'Figma Release Notes',
        subtopic: 'figma',
      },
      { url: 'https://www.smashingmagazine.com/feed/', source: 'Smashing Magazine' },
      { url: 'https://www.nngroup.com/feed/rss/', source: 'Nielsen Norman Group' },
      { url: 'https://css-tricks.com/feed/', source: 'CSS-Tricks', subtopic: 'libraries' },
      {
        url: 'https://android-developers.googleblog.com/feeds/posts/default',
        source: 'Android Developers',
        subtopic: 'platform-ui',
      },
      { url: 'https://webkit.org/feed/', source: 'WebKit', subtopic: 'platform-ui' },
      {
        url: 'https://developer.chrome.com/static/blog/feed.xml',
        source: 'Chrome Developers',
        subtopic: 'platform-ui',
      },
    ],
  },
] as const

export function getCategory(slug: string): CategoryDefinition {
  const category = CATEGORIES.find(c => c.slug === slug)
  if (!category) {
    const known = CATEGORIES.map(c => c.slug).join(', ')
    throw new Error(`Unknown category "${slug}". Known categories: ${known}`)
  }
  return category
}

export const CATEGORY_SLUGS = CATEGORIES.map(c => c.slug)
