/**
 * YouTube transcripts — the knobs for turning a link the reader pasted into
 * something the summarizer can read.
 *
 * Its own file rather than a section of `summary.ts` for the reason that file is
 * separate from `pipeline.ts`: nothing here touches ingest, ranking or delivery,
 * and the one number that matters — how much transcript a call may carry —
 * cannot be shared with `/summarize` without silently breaking one of them. See
 * [ADR-0032](../../docs/decisions/0032-a-youtube-link-summarizes-itself.md).
 */

export const youtube = {
  /**
   * Video ids out of every URL shape YouTube serves, and nothing else.
   *
   * A video id is exactly 11 characters of `[A-Za-z0-9_-]`, and the trailing
   * negative lookahead is what stops a 12th character being silently dropped —
   * without it a mistyped link yields a *valid-looking* id for a different video,
   * which is the worst failure this parser has: it summarizes something real that
   * the reader never asked about.
   *
   * The host is required. `example.com/watch?v=…` must not match, or any link
   * with a `v=` query parameter becomes a video. Verified against all eight
   * shapes in `pnpm youtube:check`, including `youtu.be` with a `?t=` timestamp,
   * `/shorts/`, `/live/`, `/embed/`, the `m.` host and a bare `youtube.com`
   * with no scheme — Telegram sends plenty of those.
   */
  urlPattern:
    /(?:^|[^\w.-])(?:(?:www\.|m\.)?youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^\s]*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/,

  /**
   * The caption track preferred when a video carries several.
   *
   * English, and not the reader's language, because this picks the *source* and
   * the summary's language is decided separately — the same split the feed
   * scout's `searchQuery` makes ("search in English even when the reader
   * doesn't"). 3Blue1Brown's chapter 1 ships **31** tracks; the English one is
   * the author's own and the other thirty are translations of it.
   *
   * It is a preference, not a filter: `getSubtitles` falls back to a manual
   * track, then an auto-generated one, then whatever exists. A French video with
   * no English captions is summarized from its French transcript, which is
   * correct — the summarizer reads any language and writes in the one asked for.
   */
  preferredCaptionLanguage: 'en',

  /**
   * Ceiling on transcript handed to the summarizer, in characters.
   *
   * **Deliberately not `summary.maxSourceChars`, and this is the whole reason
   * this file exists.** That cap is 8,000 characters, which is right for an
   * article and catastrophic here: speech runs about 940 characters a minute, so
   * 8,000 characters is the first *eight and a half minutes* of a video. Measured
   * 2026-08-06 — Karpathy's "Let's build GPT" is 1h56m and 108,990 characters, so
   * the article cap would have summarized **7% of it** and said nothing about the
   * other 93%. A summary of the first 7% is not a short summary, it is a wrong
   * one, and nothing in the output would have looked wrong.
   *
   * 120,000 covers ~2h07m, which is past every measured case. It is affordable
   * because of what reads it: `AVA_MODEL_SUMMARIZER` is `gemini-3.1-flash-lite`,
   * roughly a million tokens of context, and a full 120k-character transcript is
   * ~30k input tokens — about a third of a US cent per video. Raising this costs
   * money linearly and buys nothing until someone pastes a longer stream; the
   * number to check before raising it is the model's context, not the price.
   *
   * When it does bind, the tool reports `truncated` and the fraction covered and
   * the reader is told — a summary that quietly stops halfway is the failure this
   * whole comment exists to prevent.
   */
  maxTranscriptChars: 120_000,

  /**
   * Below this, a transcript is treated as "no usable speech" rather than summarized.
   *
   * Captions existing is not the same as speech existing: a music video's track
   * is `[♪♪♪]` repeated, and a silent clip can carry a handful of sound cues.
   * Measured, "Me at the zoo" is 19 seconds and 217 characters of real speech —
   * so this sits below that, because the honest answer for a genuinely tiny video
   * is a two-sentence summary rather than a refusal.
   *
   * It is a floor on *substance*, not a quality bar. Anything above it goes to
   * the model, which is allowed to write something short.
   */
  minTranscriptChars: 120,

  /**
   * Timeout for each of the two HTTP calls a transcript costs — the InnerTube
   * `player` lookup, then the caption track itself.
   *
   * Matched to `pipeline.articleTimeoutMs`'s reasoning rather than its value: a
   * reader is waiting on this synchronously, and a video that will not answer
   * should fail while they are still looking at the chat. The package takes a
   * `fetch` implementation, which is the only way to bound it — it exposes no
   * timeout of its own.
   */
  timeoutMs: 15_000,
} as const
