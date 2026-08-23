---
id: 0031
applies_to: ["src/services/feed-timeliness.ts", "src/services/feed-finder.ts", "src/config/feed-finder.ts"]
status: accepted
supersedes: []
verify: "pnpm finder:check"
---

# ADR-0031: A race decides which sources are early, not a health check

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

The reader's complaint was that the digests carry news that is not new — being
told about a model release a week after it shipped, while the releases they were
waiting for went unmentioned.

The obvious reading is that the pipeline is slow, and it is measurably a little
slow: over fourteen days of deliveries, the median gap between an article's
publication and its delivery is 23.3h, p90 is 120h and the worst was 224.8h, with
only 3% under six hours. But that is not the complaint. **A source can be
perfectly punctual about its own publishing and still be four days behind the
news.** A blog that writes about a release the following week carries a
`publishedAt` from this morning; the article is fresh and the information is
stale.

Nothing in this repo could see that. `checkFeed()` — the sole authority on
whether a URL may become a source ([ADR-0020](0020-feed-discovery-from-a-subject.md))
— asks whether a feed is reachable, parses, and has recent entries. A late blog
passes every one of those tests. Measured on the reader's own `ai-model-releases`
beat: `pnpm feeds:check` reported **20/20 feeds healthy**, and the beat's three
sources are a *weekly* newsletter, a corporate announcements page whose feed
carries nothing inside a 45-day window, and a consumer product blog. All healthy.
None capable of breaking a story.

The scout cannot fix this either. It proposes *sites it can name*, and the
sources that break model news are blogs nobody would think to name —
`blog.fal.ai`, `openrouter.ai/blog`.

Two undocumented search APIs were probed as candidate sources:

- **rssfinder.app** — a fixed tag taxonomy. Good on a *domain* (2/2 on
  `simonwillison.net`, `autosport.com`, and on `f1technical.net`, which this
  repo's own resolution cannot reach because a CDN refuses the homepage while the
  feed server answers). Degrades to word-level OR matching when a slug is not in
  its taxonomy: `ai-model-generations` returned Tesla **Model** S and Brick
  **Model** Railroader, and `${beat.title} news and analysis` — the string the
  weekly top-up sends — returns the **same seven feeds for every beat**, because
  the filler words dominate the match. Five of those seven pass `checkFeed()`.
- **finder.wprssaggregator.com/api/topic-search** — Brave-backed, so a real
  search rather than a taxonomy, answering with feed URLs plus `velocity` and
  `lastUpdated`. Few results and precise ones: 1–5 per query where rssfinder
  returns a flat 7 of mixed quality.

Neither can answer the question that matters. `velocity` says how *often* a
source posts and `lastUpdated` says how *recently* — and a daily blog that is
always two days late scores well on both.

## Decision

**Timeliness is measured by racing sources against each other, and it is the
third stage of candidate discovery — after search, after `checkFeed()`.**

`raceFeeds()` fetches every candidate, finds the stories several of them covered,
takes the earliest publication of each story as `t0`, and reports each source's
median hours behind it. A source that is consistently first breaks stories; one
consistently behind repeats them.

A story is **a bursty, name-shaped token**, not a topic. Titles reduce to tokens;
a token qualifies only if it carries a digit (`gpt-5.6`, `lfm2.5-2.6b`) or
appears capitalised mid-title (`Gemini`, `Claude`), survives a document-frequency
filter and a domain stopword list, and is used by two distinct **publishers**
inside seven days.

`topic-search` becomes the primary candidate search; rssfinder is kept for the
one axis it is good at — resolving a *domain* to its feeds — and is **filtered to
the host asked about**, because `formula1.com` returns BBC Sport's F1 feed.

`checkFeed()` is untouched and remains the sole authority on whether a URL is a
feed at all. The race ranks; it never admits.

## Consequences

**Good:** the question the reader actually asked is now answerable, and it is
answered by code rather than by a model — a deterministic measurement over feeds
that were fetched, which sits inside [invariant 2](../../AGENTS.md#invariants)
without needing the classifier carve-out. It found real facts immediately:
ThursdAI runs **+24h behind OpenAI on OpenAI's own releases**, and
`stability.ai/news-updates` has **no dated entries in 45 days** while passing
`feeds:check`.

**Costs:** three, and they are real.

- **Low recall.** A race needs overlap, and sources covering different niches
  rarely share a story. Thirteen feeds over 45 days produced 5 stories, so most
  candidates come back "too few" and unranked. The tool answers well about
  sources that compete and says nothing about sources that do not.
- **Every threshold is a heuristic.** Two live runs raced on `july`, `three`,
  `money` and `without` before the filters were tightened, and **the ranking they
  produced looked entirely plausible** — which is what makes a loose filter
  dangerous. The numbers in `feedFinder.race` were each set against an observed
  failure, not derived.
- **A shared token is not always a shared story.** `kimi` matches both the K-series
  models and Kimi Räikkönen. `minStoriesToRank` is the mitigation and it is
  statistical, not a fix.

**Revisit if:** the endpoint changes shape — both APIs are undocumented and
somebody else's, and `topic-search` is POST-only with an undocumented `q`. Or if
the race is ever wanted *inside* a scheduled run rather than in a check script:
it fetches every candidate in full, so its cost is bounded by
`feedFinder.maxCandidates` and that bound would become load-bearing rather than
advisory.
