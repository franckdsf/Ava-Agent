---
applies_to: ["src/services/**", "src/config/**", "src/mastra/workflows/**"]
---

# Feeds and ingest

Gotchas. The routing table is [README.md](README.md).

- **Feeds serve their entire history.** Figma returns 437 entries, OpenAI 1051.
  `pipeline.maxItemAgeDays` exists for this reason; removing it means paying to
  rank years-old news.

- **A prolific feed is a different problem from a historical one, and the age
  window only solves the second.** arXiv `cs.AI` publishes 258–693 papers a day,
  every one of them hours old, so all of them clear the window: 951 of 1,084
  articles in a week, ~92% of ranking input tokens, for a **2% hit rate**.
  `pipeline.maxItemsPerFeedRun` is the general bound and
  `scopeArxivFeed()` narrows arXiv specifically, rewriting a category listing
  into an API query built from the beat's subtopics — applied in **both** add
  paths (`/addfeed` and discovery's `attach`), verified with `checkFeed()`, and
  reverted to the plain category if the query returns nothing.

- **Subtopics are ranking labels, not search terms, and they only sometimes
  survive the change of job.** Measured 2026-08-06 on `computer-science`
  (`ai-research`, `ai-models`): the scoped query returned 60 papers spanning
  **38 days with 1 of 60 from that day's batch**, and the titles were not
  visibly more on-beat than the unscoped 287. A label naming a *thing* works as
  a phrase search (`figma`, `design systems`); one naming a *field* does not.
  The cost saving is real either way — most results fall outside
  `maxItemAgeDays` and never ingest — but do not read the reduction as evidence
  that the right papers were chosen. `arxiv.uselessTerms` exists because
  `benchmarks` and `capabilities` match a large slice of every AI category.

- **`content:encoded` needs declaring.** rss-parser silently drops unknown
  fields, so the full article body is invisible unless it is listed in
  `customFields.item`. Without it the summarizer sees a 400-char excerpt and
  writes a summary that just restates the headline.

- **Conditional GET hides schema changes.** Items ingested before a new column
  existed keep it null until their feed actually changes, because a 304 skips
  re-ingest entirely — and `insertDiscovered` ignores conflicts, so even a
  re-fetch won't backfill an existing row. `content` and `imageUrl` were null
  for every pre-existing item long after their migrations ran. New items fill
  in normally; a backfill is a deliberate one-off, not something ingest does.

- **og:image is as often the site banner as the post's art.** WebKit serves
  `/wp-content/themes/webkit/images/preview-card.jpg` on every post. Two guards
  in `resolveImage()`: reject paths that look like site chrome, and reject any
  URL already on a sibling item from the same feed. The repeat check alone can't
  catch the first occurrence, which is exactly the one that shipped.

- **Only 3 of 16 feeds publish images.** DeepMind (`media:content`), Smashing
  (`enclosure`) and Android Developers (`media:thumbnail`); WebKit has them
  inline in about half of posts. arXiv, Hacker News, Willison, OpenAI, Figma,
  CSS-Tricks and NNG have none. An image is the exception — never lay out a
  message assuming one is there.

- **Clustering is empirically tuned.** Before changing
  `clusterSimilarityThreshold` or the token filter, re-run ingest and inspect the
  actual merges. ([0007](../decisions/0007-lexical-clustering-instead-of-embeddings.md))

- **`htmlToText` used to space out every tag, which destroyed code.**
  `<code>WebAssembly</code>.<code>compileStreaming</code>()` was stored as
  `WebAssembly . compileStreaming ()` — invalid, and invisible for the life of
  the project because a summary never quoted code. The translation commands put
  code in fenced blocks, where it is unmissable. Inline tags are now stripped
  rather than replaced with a space, and `td`/`th` had to join the block-closer
  list so table cells still separate. **Only new items benefit** — a conditional
  GET means an existing row keeps its mangled body forever, which is why the
  translator's prompt *also* repairs code spacing. Don't remove one fix on
  finding the other.
