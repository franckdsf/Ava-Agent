---
applies_to: ["src/services/youtube.ts", "src/config/youtube.ts", "src/mastra/tools/youtube.ts"]
---

# YouTube

Gotchas. The routing table is [README.md](README.md).

- **A YouTube caption URL from the watch page answers 200 with an empty body.**
  The page still advertises its `captionTracks` and every one of those URLs is
  dead without a proof-of-origin token — a `200`, a `content-length` of zero, and
  no error anywhere. The route that works is InnerTube's `player` endpoint called
  with a **mobile client profile**, which is what `youtube-caption-extractor`
  does. Measured 2026-08-06, of the three profiles it tries **only iOS is alive**:
  Android VR answers `LOGIN_REQUIRED` and Web answers `UNPLAYABLE`. So its
  "fallback chain" is one working profile, and the day that one goes, every video
  fails at once. `pnpm youtube:check` is how that is noticed and
  `pnpm update youtube-caption-extractor` is the fix — not this repo's code.
  ([0032](../decisions/0032-a-youtube-link-summarizes-itself.md))

- **A YouTube title is not *the* title — YouTube A/B tests them per viewer, so
  the one fetched here is very likely not the one the reader clicked.** This came
  out of a real session: the reader asked why the speaker said he was wrong, the
  summary said nothing about it, and the title we fetch is `Shadcn UI? in 2026?`
  — no reversal anywhere in it, and grepping the spoken text for "was wrong",
  "mistaken" and "take it back" returns **zero** hits. The reversal was in the
  variant *they* were served, and the "I was wrong" framing most likely lives in
  the **thumbnail**, which is an image and reachable by nothing here. So the
  title is passed to the summarizer as context and the prompt requires the claim
  to be *addressed* while forbidding the title to be *quoted* — writing
  `the video, titled "…", never explains` tells a reader looking at a different
  title that the wrong video was summarized. The description's first line is
  passed alongside it and is the steadier of the two: written once by the author
  rather than tuned per viewer. Here it is *"Should you still Shadcn UI or are
  you better off using another 'traditional' UI library?"*, which is what the
  video is actually about, and it now frames the opening paragraph of every run.
  Only the first paragraph — the other 600 characters of that description are
  course plugs, affiliate links and five social profiles.

- **A transcript is ten times the length of an article, and the article cap
  silently truncates it into a plausible lie.** Speech runs ~940 characters a
  minute, so `summary.maxSourceChars` (8,000) is the first *eight and a half
  minutes* of a video. Measured: Karpathy's "Let's build GPT" is 1h56m and
  **108,990 characters** — the article cap would have summarized 7% of it and
  produced something that reads exactly like a correct summary. `youtube.maxTranscriptChars`
  is a separate number (120,000) for this reason, and the two must never be
  merged "for consistency". When it does bind, the tool reports the cut **in
  video time** (`the first 2h07m of 2h45m`) and Newy is required to pass that on;
  a percentage is not something a reader can act on.

- **Only the summary's *relay* goes through Newy, and that is the one place she
  copies text instead of writing it.** `summarize-video` returns finished blocks
  from the summarizer, and her prompt tells her in blunt terms to reproduce them
  verbatim. This deliberately re-enters the risk ADR-0018 avoided by keeping
  `/summarize` off her — m3 closing `</think>` mid-answer truncates long replies —
  so if a video summary ever arrives starting mid-word, that is the known cause
  and the fallback is `postMessage` like the commands use, not an adapter change.
