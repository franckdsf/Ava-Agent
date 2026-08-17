# ADR-0037: Hacker News's hiring thread is a source kind, not an adapter

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

[ADR-0024](0024-joob-a-job-pipeline-beside-the-news-one.md) recorded this
pipeline's structural cost: the free boards it can use are thin and skewed, and
LinkedIn and Indeed are out of scope for good reasons.
[ADR-0026](0026-sonar-as-a-job-source.md) reached past them with a model, and
[ADR-0027](0027-ats-boards-as-discovered-sources.md) turned each lead into a board
polled for free. Both worked — `sonar` is 16 of the 27 postings that have ever
scored 80+.

But the scout is saturating. New ATS boards discovered per run, over eight runs:
`5, 4, 9, 4, 1, 5, 1, 4, 0`. `knownAtsCompanies()` hands the scout every employer
already polled as a company to skip, that list grows about three a day, and the
pool of plausible remaining candidates shrinks with it. That is working as
designed, and it means the pipeline's best source has a horizon.

Meanwhile the search that performs worst has a specific, diagnosable problem.
`founding-engineer-worldwide` scored 966 postings for 31 at ≥60 — a 3.2% rate
against 20.7% and 26.2% for the two stack-defined searches. A stack `mustHave`
cannot rescue it: replayed against the winners it deletes 13 of 31, including the
two best jobs the pipeline has ever found and every posting whose title literally
says *Founding Engineer*. Seed-stage adverts say "you'll build the product with
us" and never name a stack. That search is defined by **company stage**, and no
board in the table indexes company stage.

Hacker News's monthly *"Ask HN: Who is hiring?"* thread does, by construction. It
is the one population that is not an aggregator: founders posting their own roles,
for free, because they read the site. Measured on the August 2026 thread — 375
top-level comments, 210 of which parse into postings, with roughly a dozen saying
"founding engineer" in the title.

## Decision

**A new `kind`, `hn`, beside `rss` / `api` / `ats` / `sonar`.**

It cannot be an `api` row, and the reason is structural rather than fiddly.
`API_ADAPTERS` maps a URL to a pure `(payload) => RawPosting[]`, which assumes the
URL is stable. This thread's id changes every month, so reading it is two requests
— resolve the current story, then page its comments — and a resolution step is
exactly what `kind` discriminates on. `sonar` set that precedent for the same
reason.

**The thread is found by author, never by title.** `search_by_date` with
`author_whoishiring` returns exactly the threads that account posts, which is a
fact about who wrote them rather than about how they were worded — the same
discipline `checkFeed()` follows in refusing to trust a search result about what a
feed is. The title is still checked, but only to pick the hiring thread from the
three that account posts each month: disambiguation among known-good candidates,
not identification.

**The parse is strict and drops what it cannot read.** The thread has a stated
convention — `Company | Role | Location | REMOTE | salary` on the first line. A
lenient parse of a free-text comment produces a posting whose "company" is half a
sentence, which is worse than nothing: it reaches the scorer, costs a slot from
the pipeline's scarcest resource, and pollutes the dedupe with a key that will
never match again. Comments carrying fewer than two header fields are skipped and
counted, so a month where the convention shifts is visible rather than silent.

`domain: 'software'` under
[ADR-0036](0036-a-source-may-declare-its-field-and-a-search-may-be-re-read.md).
This is a genuine claim of exclusivity — a software community's hiring thread will
never serve a chemist — which is the bar that column sets for being set at all.

## Consequences

**One bug found only by running it, and it would have been invisible.** Hacker
News separates paragraphs with a bare opening `<p>` and never closes it, while
`htmlToText` breaks on `</p>` — correct for the HTML real articles ship. Rendering
before splitting therefore collapsed each comment onto one line and put the advert
body *inside* the header: 141 of 206 postings came out with **no description at
all**, and salary fields read `$160–180kWe are a fast growing…`.

A posting with no description fails every `mustHave` there is. The source would
have fetched cleanly, reported 200, produced two hundred postings, and quietly
failed the one filter that matters — the exact silent-degradation shape Remote OK
had. Splitting the raw HTML first fixes it: description coverage went from 65 to
208 of 210. Fixed in `job-hn.ts` rather than in `htmlToText`, which is shared with
the news pipeline; teaching a shared helper about one board's unclosed tags is how
it acquires a caller's quirks.

**One defect is left, stated rather than hidden.** A poster who omits the company
and opens with the role — `Senior Software Engineer | New York, NY` — parses as
company "Senior Software Engineer". A handful of the 210. Left alone because every
rule that would catch it also misfires on real employers whose names contain a job
title, and the damage is bounded: `filterJob` scans title, company and description
together, so the posting is still filtered and scored correctly. What suffers is
the employer name in the message and the dedupe key — a cosmetic loss against the
silent rejection the alternative risks.

Against the live searches the thread yields 135 / 65 / 60 survivors of 210. The
first number is `founding-engineer-worldwide`, which remains the loosest search in
the table and will now fill its scoring batch from here — which is the intent, and
also the reason its looseness is worth revisiting separately.

`atsMaxPostingsPerBoard`'s cap has no analogue here on purpose. That cap exists
because one employer's board would otherwise become the whole run; these 375 are
375 *different* employers, which is the opposite problem and the entire argument
for the source.
