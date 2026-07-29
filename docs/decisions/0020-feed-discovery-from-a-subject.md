# ADR-0020: The model proposes sites, the code finds the feeds

- **Status:** Accepted
- **Date:** 2026-07-29
- **Builds on:** [ADR-0019](0019-beats-as-reader-owned-data.md), which made beats
  rows and restated invariant 8. This is the first thing that uses that licence.

## Context

[ADR-0019](0019-beats-as-reader-owned-data.md) ended with beats the reader owns
and no way to create one. `/addfeed` existed, which meant following a new subject
required the reader to already know its feed URLs — the one thing a person
following a *new* subject does not have.

Three constraints shaped the answer.

**Nothing installed could search the web.** The working agreement forbids adding
a dependency without checking what is there, and the obvious move — a search SDK,
an API key, a scraper — would have added all three.

**A model must never supply a feed URL.** A wrong one does not error. It is
stored as a source that returns nothing for as long as nobody looks, and the
reader has no reason to look because they were told it worked. This is not
hypothetical: probing `sonar-pro` produced `chefpjacooks.com`, a domain that does
not exist, beside `sonar`'s real `chefjacooks.com`.

**Discovery takes minutes.** One search plus eight homepage fetches plus several
feed checks each is far longer than a reader will hold still for, so it cannot
happen inside the turn that asks for it.

## Decision

**`/follow <subject>`, a command rather than a tool on Ava.** Same reasoning the
other beat commands use: the adapter routes `/` away from the agent anyway, and
creating a beat should happen because the reader typed those words. It is the
only beat command that calls a model and the only one that starts a run — both
justified, because naming a beat is a translation job with no destructive
outcome, unlike `/pause`.

**Two models, split by job.** A cheap namer turns the subject — in any language —
into an English title, emoji, subtopics and rubric bullets. A search-native scout
proposes sites.

**`perplexity/sonar`, through the existing OpenRouter gateway.** No new
dependency and no second key. `sonar` over `sonar-pro` is measured, scoring
*verified feeds* rather than proposed sites: **18/24 against 16/24** across three
subjects, faster and cheaper, with sonar-pro inventing a domain.

**The scout returns pages; deterministic code finds feeds.** Read
`<link rel="alternate">`, else try well-known paths, else follow one link to a
feed-listing page. `checkFeed()` is the only authority on whether a URL is a
feed, and it leaves no `feed_state` behind.

**The search query is English, always.** Measured: `"actualité de la formule 1"`
returned 3 sites with 1 usable feed; an English phrasing of the same subject
returned 8 with 7. This costs the reader nothing, because the language of a
*source* does not reach them — the digest is summarized, and
[ADR-0017](0017-translation-commands.md) / [ADR-0018](0018-summarize-command.md)
answer in their language on demand.

**For a general outlet, the section page, not the root.** `bbc.com` yielded
nothing in a real run; `bbc.com/sport/formula1` resolved in three of three. A
front page advertises no feed, and the section feed is the one worth having.

**The beat is written paused, and there is no draft table.** `beats.archivedAt`
already means "exists, does not run". The row *is* the draft: `/beat <slug>`
inspects it, `/addfeed` extends it, and discovery clears `archivedAt` only if it
attached something. A `beat_drafts` table was designed and rejected — it would
have duplicated that state and cost a migration.

**Two messages, not one.** The command acknowledges; the workflow reports minutes
later. One message carrying both would read like a form even if it were possible.

## Consequences

**Good**

- A reader follows a new subject by naming it, in their own language, and gets a
  working beat without knowing a single URL.
- No new dependency, no second API key, no scraper to maintain.
- A model-invented feed URL cannot reach the database. Every stored feed was
  fetched and parsed first.
- The workflow is re-runnable by construction — it excludes the beat's existing
  feeds by hostname and upserts — so topping a beat up needs only an entry point.

**Costs**

- **Yield depends on the subject, and varies.** Formula 1 settles at 6/8. EU
  policy ran 3/8, 4/8, 2/8, and one run proposed two law firms and a PR agency.
  A weak subject produces a thin beat and the reader must finish it by hand.
- **Sites that hide their feed are invisible.** Sky Sports serves RSS at numeric
  ids (`/rss/12040`); nothing deterministic will find that. Big institutional
  sites are the systematic blind spot.
- **`checkFeed()` cannot tell a feed from a sitemap.** A Google News sitemap
  declared as `application/rss+xml` parsed as 306 entries and was accepted.
- **A browser User-Agent is used for the homepage fetch**, because the sites
  worth having 403 the honest one. Narrowly scoped — one page, on a person's
  request — and every *feed* fetch keeps `pipeline.userAgent`.
- **Quality falls off on re-runs.** The scout returns its best guesses first, so
  a top-up walks down a ranked list while the cost of every extra feed — fetched
  each digest, ranked per article — stays flat.
- **An abandoned `/follow` leaves a paused beat behind.** The cost of having no
  draft table.

**Revisit if:** yield on ordinary subjects drops below roughly half, or a
non-search model with a browsing tool becomes cheaper than a search-native one —
the split here does not care which model proposes the sites.
