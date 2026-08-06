# ADR-0032: A YouTube link summarizes itself — a tool on Newy, not a command

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

The reader pastes YouTube links into the chat. Nothing happened when they did:
Newy has no way to watch video, and answering from the URL or the channel name is
the kind of confident guess her prompt spends several paragraphs forbidding
elsewhere.

The system already knows how to explain something at length. `/summarize`
([ADR-0018](0018-summarize-command.md)) turns an article into several hundred
words in whatever language was asked for, and its agent is calibrated, pinned to a
low-latency provider, and already shared with nothing. What was missing was the
text: a video has no body to read.

Two facts decided the shape, and both were measured rather than assumed:

- **A transcript can be fetched, but not the obvious way.** The watch page still
  advertises its caption tracks, and every one of their URLs now answers `200`
  with an **empty body** — YouTube requires a proof-of-origin token there. The
  route that works is InnerTube's `player` endpoint called with a **mobile client
  profile**. Of the three profiles `youtube-caption-extractor` tries, exactly one
  was alive on 2026-08-06: iOS returned `OK`, Android VR returned
  `LOGIN_REQUIRED`, Web returned `UNPLAYABLE`.
- **A transcript is an order of magnitude longer than an article.** Speech runs
  ~940 characters a minute. Karpathy's "Let's build GPT" is 1h56m and **108,990
  characters**; 3Blue1Brown's chapter 1 is 19m and 18,430. `summary.maxSourceChars`
  is 8,000.

## Decision

**A tool on Newy, fired by the link itself — no command.** This is the first
long-form explanation here that is not a slash command, and the reason the others
are commands does not apply. `/summarize` and `/translate` work on the article a
reader *swiped*, and a swipe is only reachable from the raw Telegram payload a
command handler receives ([ADR-0013](0013-swipe-to-reply-as-article-context.md),
[ADR-0017](0017-translation-commands.md)). A video link is not swiped, it is
pasted — it arrives on the ordinary message path, where Newy is already reading.
Requiring `/summarizevideo <url>` would make the reader type a command to request
the one thing the link already says. Newy decides to call it, which is the whole
feature.

**The summarizer agent is reused, with one section of prompt added.** A transcript
wants different advice from an article — supply the structure the speech has none
of, cut the repetition speech has in abundance, repair phonetically mangled
technical terms, and drop sponsor reads where a web page has cookie banners — but
every other rule was already right, and the model, the provider pinning and the
structured output are exactly what this needs. The caller declares the kind in the
message and a static `If the source is a transcript` section applies or does not.
Static rather than composed per call so the prompt stays a cacheable prefix, the
same reasoning as Newy's two system messages.

**Its own cap, `youtube.maxTranscriptChars`, at 120,000 characters.** Reusing the
article cap was the obvious move and would have been the bad kind of bug: 8,000
characters is the first eight and a half minutes of a video, so a two-hour talk
would have been summarized from **7% of itself** and nothing in the output would
have looked wrong. 120,000 covers ~2h07m, past every measured case, and is
affordable because `AVA_MODEL_SUMMARIZER` is `gemini-3.1-flash-lite` — a full
transcript is ~30k input tokens, about a third of a US cent.

**One call, no map-reduce.** The context is there, and summarizing summaries
loses exactly what a reader wants from a long talk: the specifics. Verified — the
1h56m transcript produced a correct, structured French summary in 8.2s.

**The summarizer is given the title and the description's first line, and asked
to settle what they claim.** Added the same day, from the first real use: a
reader asked why the speaker said he was wrong, and the summary had nothing —
correctly, because the video never says it. The summarizer had been reading the
transcript blind, so a title's promise could go unaddressed and the reader's
first follow-up had no answer anywhere. It now settles the claim explicitly,
including the case that matters most: saying in as many words when the video
never comes back to it.

Two constraints came with it. **A YouTube title is served per viewer** — YouTube
tests variants — so the one fetched here is likely not the one the reader
clicked; the prompt therefore requires the claim to be addressed and forbids the
title to be quoted, since naming a title the reader is not looking at reads as
the wrong video having been summarized. And the **description's first line is
the steadier signal**, written once by the author rather than tuned per viewer,
so it is passed alongside — first paragraph only, links stripped, capped at
`maxBlurbChars`, because the rest is course plugs and social profiles.

**When the cap binds, the reader is told in video time.** The tool returns
`covers: "the first 2h07m of 2h45m"` and Newy must pass it on. "89%" is not
something a reader can act on; a timestamp is. A partial summary presented as a
whole one is this feature's worst output.

**Three failures, not one.** `unavailable` (private, deleted, region-locked, or a
wrong link), `no-captions` (a real video that will never have a transcript), and
`no-speech` (a music video). They are distinguished because they ask for three
different things, and a reader told only "it didn't work" will retry the one that
cannot succeed.

**A dependency, wrapped in our own service.** `youtube-caption-extractor` owns the
part that rots — the client profiles that get past the bot wall — so that repairing
it is `pnpm update` rather than debugging YouTube internals. Everything the output
quality depends on stays in `src/services/youtube.ts`: which URL shapes are a
video, how cues become prose, where the cap falls, and what the reader is told.

## Consequences

- Newy relays the summary rather than composing it, and her prompt says so in
  unusually blunt terms. This is the one place she passes text through verbatim.
  It also reintroduces, on purpose, the risk ADR-0018 avoided by keeping
  `/summarize` off her: `minimax-m3` intermittently closes `</think>` inside its
  own answer, so a long relayed summary can arrive truncated. Accepted because the
  tool shape is the feature; if it bites, the fallback is to push the summary with
  `postMessage` the way the commands do, at the cost of the summary leaving her
  memory.
- **This depends on another company's anti-bot posture and will break without
  warning.** `pnpm youtube:check` exists to make that one command to diagnose. The
  failure is total and silent from the outside — Newy simply starts saying she
  cannot read any video.
- A container on a datacenter IP may be blocked where a home connection is not.
  Untested here. The package accepts a custom `fetch`, so a proxy is the escape
  hatch if that day comes.
- Invariants are untouched. Two outbound GETs and a model call: nothing stored, no
  run started, no table written ([invariant 8](../../AGENTS.md#invariants)), and
  it is inbound and human-triggered, so it sits with the translator and the
  summarizer under invariant 2's second category — a person pasted a link, not a
  cron fire nobody watches.

## Alternatives considered

- **Hand-rolling the InnerTube call.** About forty lines, and it works today — it
  was written and run before this was decided. Rejected because the part that
  matters is not the forty lines but keeping the client profile alive as YouTube
  moves, and two of the three profiles are already dead.
- **Returning the transcript to Newy and letting her summarize it.** One fewer
  model call, and much worse: 27k tokens of unpunctuated ASR into the orchestrator,
  summarized by the model with the documented truncation habit, against a prompt
  that tells her to be short because this is a phone.
- **Chunked map-reduce over long videos.** Unnecessary at this model's context, and
  it degrades the result. Revisit only if a transcript ever exceeds the context
  rather than the cap.
- **`yt-dlp` as a subprocess.** More robust and far more capable. Rejected: a
  Python binary in the image, and this needs one endpoint's worth of what it does.
