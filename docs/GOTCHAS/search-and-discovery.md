---
applies_to: ["src/services/**", "src/mastra/tools/**", "src/mastra/workflows/**"]
---

# Search and discovery

Gotchas. The routing table is [README.md](README.md).

- **A rubric mostly names no subjects, and the one time it looked like it did,
  that was a bug.** `termsFromRubric` reads proper nouns out of the HIGH half.
  Measured across all four live beats: it helps **one** — `design` yields
  `google, ui, css` and goes from 0 to 16 papers inside the ingest window —
  and yields *nothing* for `computer-science` and `ai-model-releases`, whose
  rubrics describe the **shape** of news wanted ("actually shipped", "primary
  sources outrank commentary") rather than any subject. That is the correct
  answer for them, not a gap to paper over. The first implementation skipped only
  the first word of each *line*, so `Primary` in "…benchmark delta. **Primary**
  sources outrank commentary" was taken as a proper noun; it matched a fifth of
  cs.AI and lifted `computer-science` from 9 usable papers to 40. **That looked
  exactly like the feature working.** Sentence-initial capitals are skipped now
  and the gain correctly vanished.

- **A search index is not a `LIKE`.** `search-news` matched the reader's entire
  phrase as one contiguous substring, so `fine tune` could not find `fine-tune`
  and every multi-word question missed. It now goes through `items_fts`
  ([0011](../decisions/0011-fts5-for-article-search.md)). Two things bite when
  touching it: punctuation is FTS5 *match syntax*, so terms must be quoted or
  `fine-tune` throws `no such column: tune`; and the `AFTER UPDATE` trigger is
  scoped `OF title, excerpt, content` because the pipeline writes `score` and
  `deliveredAt` on every run and would otherwise reindex the table each time.
  Verify the index against `items` with
  `INSERT INTO items_fts(items_fts) VALUES('integrity-check')`.

- **A tool that returns only headlines produces a model that hedges.** The
  original `search-news` returned title/source/link/score and nothing else, so
  even a *successful* search left Newy unable to say anything about an article —
  she hedged, and it read as a search failure. It returns `excerpt` and `reason`
  now, and `read-article` returns the body for one item at a time.

- **Listing and reading are separate tools on purpose.** `search-news` matches
  on the full body but returns excerpts; `read-article` returns one body in full.
  Putting bodies in the search result is the obvious-looking change and is the
  wrong one twice over: at the 8k cap fifteen results is ~30k tokens a search,
  and it buries the article the reader asked about under fourteen others. Both
  tools return `id` so the model can go from one to the other — if that field
  is ever dropped from `articleShape`, reading breaks silently and Newy goes back
  to answering from excerpts.

- **Telegram feeds carry no body worth having, so `read-article` fetches.**
  Hacker News items store the HN boilerplate as their excerpt — `Article URL: …
  Points: 180 # Comments: 48` — and 15 of 288 items had no `content` at all.
  `read-article` falls back to `fetchArticleText` for exactly those, and
  deliberately does **not** write the result back: that would make it the one
  tool on the conversational surface that writes to the pipeline's tables, and
  invariant 8 is worth more than a free cache. Verified against Android
  Developers, which ships no `content:encoded`: 7999 chars fetched live, 568 of
  them nav chrome before the article starts.

- **A search-native model is how this repo searches the web, and it needed no
  dependency.** `openrouter/perplexity/sonar` routes through the same gateway and
  key as everything else. Before reaching for a search SDK or a scraper, check
  whether a model can do it. `sonar` over `sonar-pro` is measured on *verified
  feeds*, not proposed sites — 18/24 vs 16/24 over three subjects, faster and
  cheaper, and sonar-pro invented a domain (`chefpjacooks.com`) where sonar
  returned the real one.

- **Ask a model for sites, never for feed URLs.** A wrong feed URL never errors:
  it is stored as a source that silently returns nothing forever. The homepage
  goes to `discoverSiteFeed()`, which reads `<link rel="alternate">`, then tries
  well-known paths, then follows one link to a feed-listing page — and
  `checkFeed()` decides. Same discipline as templating an article's link rather
  than letting the summarizer write it.

- **Search in English even when the reader doesn't.** `"actualité de la formule
  1"` returned 3 sites with 1 usable feed; the English phrasing of the same
  subject returned 8 with 7. It costs the reader nothing — a source's language
  never reaches them, since the digest is summarized and `/summarize` and
  `/translate` answer in their language. The namer emits a `searchQuery` for this
  and it is deliberately not stored.

- **For a general outlet, hand the resolver the section page, not the root.**
  `bbc.com` yielded nothing on a real run; `bbc.com/sport/formula1` resolved 3 of
  3. A front page advertises no feed, and the section feed is the one worth
  having anyway. Same for `espn.com` and `skysports.com`.

- **The homepage fetch uses a browser User-Agent, and only that fetch.** With
  `pipeline.userAgent`, `autosport.com` and `motorsport.com` answer **403** and
  `racefans.net` answers **429** — three of the best sources for that subject.
  Worth 4/10 → 7/10 on the first probe. The *feeds* those sites serve accept the
  honest UA happily, so every feed fetch and every later poll keeps it; it is the
  CDN in front of the page that objects. Don't "simplify" this to one UA.

- **A feed's `<title>` is often not a name.** PlanetF1 ships 200 characters of
  marketing copy, and that string would be the attribution under every article it
  ever delivers. `sourceLabel()` takes the first segment before a dash and falls
  back to the hostname past `pipeline.sourceMaxChars`. Note the dash class holds
  en-dash *and* em-dash — a class with only one left `Contexte – Politiques
  françaises et européennes` unsplit.

- **`checkFeed()` cannot tell a feed from a sitemap.** `grandprix247.com`
  declares a Google News sitemap as `application/rss+xml`; it parsed as 306
  entries and was accepted. Unfixed.

- **"Feeds this beat has" means the archived ones too, when the question is
  whether to add one.** Discovery excluded what `feedsForBeats` returned, which
  is live-only — right for ingest, wrong for an exclusion list. `addBeatFeed`
  upserts `archivedAt` back to null, so any re-proposed archived feed simply
  returned. Two ways that bites, and the second is the bad one: a feed dropped
  with `/removefeed` comes back on its own, defeating the whole point of
  `archivedReason = 'reader'`; and the weekly review, which runs
  `restore → prune → topUp` in **one** pass, archives a feed and re-adds it in
  that same run — pruning is what puts the beat under the cap that makes the
  top-up fire, and the scout proposes on-topic sites first, which is exactly what
  the feed it just dropped is. `trials` never advances, the 30-day rest never
  happens, and the backoff silently does nothing. `subscribedFeedUrls` is the
  exclusion list; verified against a copy — `/removefeed` took `computer-science`
  from 9 live feeds to 8 while the exclusion list stayed at 9, and re-proposing
  `blog.google` probed 1 site under the old list and 0 under the new one.

- **X/Twitter is a dead end — measured 2026-08-05, do not re-probe.** Every bridge
  is gone: `nitter.poast.org` 403, `nitter.privacydev.net` unreachable,
  `rsshub.app/twitter/*` 404, `openrss.org` 503. **`xcancel.com` is worse than
  dead — it is a trap `checkFeed()` cannot catch:** unwhitelisted it returns a
  *parseable* feed with one entry titled "RSS reader not yet whitelisted!" dated
  1970, so it passes `ok` and would sit in `beat_feeds` returning nothing forever,
  exactly like the `grandprix247.com` sitemap. It whitelists by User-Agent (only
  `FreshRSS/…` of eight tried), so adopting it means impersonating another product
  against a volunteer instance's load control. Two findings survive the dead end:
  a vendor's own account is mostly marketing (`@Kling_ai` posts showreels, not
  releases), and the search endpoint returns strangers' replies and bare links —
  neither is verifiable by code the way `checkFeed()` verifies a feed. The image
  and video labs publish no usable feed at all (BFL 404, Midjourney 403, Luma and
  Stability HTML, ElevenLabs 404), which is the real reason that beat is hard to
  source.
