/**
 * The beats a brand-new database starts with.
 *
 * **This is a seed, not configuration.** It was `CATEGORIES`, and editing that
 * array was how you added a beat. Beats live in the `beats` table now
 * ([ADR-0019](../../docs/decisions/0019-beats-as-reader-owned-data.md)) because
 * the reader adds them by talking to Newy — so `seedBeats()` applies this list
 * once, to an empty table, and never again. Changing a rubric here does **not**
 * reach a beat that already exists; say it to Newy instead, or edit the row.
 *
 * It exists at all so a fresh clone, a fresh container, and a wiped development
 * database all come up with something to read rather than an empty bot that
 * cannot explain itself.
 *
 * Thresholds are omitted where they match `pipeline`'s defaults. That is the
 * point of the nullable columns: a beat that never expressed an opinion follows
 * the default when the default is retuned, instead of being pinned to whatever
 * it was copied at.
 */

export interface SeedFeed {
  url: string
  /** Shown as the attribution in digests. */
  source: string
  /** Single-purpose feeds can pin a subtopic instead of paying for classification. */
  subtopic?: string
}

export interface SeedBeat {
  slug: string
  title: string
  emoji: string
  /** Digest sections, and the label set the ranker must choose from. */
  subtopics: readonly string[]
  /** Injected into the ranker's prompt. This is what makes a curator expert. */
  rubric: string
  /** Omit to follow `pipeline.defaultDigestThreshold`. */
  digestThreshold?: number
  /** Omit to follow `pipeline.defaultMaxItemsPerDigest`. */
  maxItemsPerDigest?: number
  feeds: readonly SeedFeed[]
}

export const SEED_BEATS: readonly SeedBeat[] = [
  {
    slug: 'computer-science',
    title: 'Computer Science',
    emoji: '🧠',
    subtopics: ['ai-research', 'ai-models', 'frameworks'],
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
]
