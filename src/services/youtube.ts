import { getVideoDetails, type Subtitle } from 'youtube-caption-extractor'
import { youtube } from '../config/youtube.js'

/**
 * A YouTube link to a readable transcript.
 *
 * The one dependency in this repo that exists to work around another company's
 * anti-bot measures, and the reason it is a dependency rather than forty lines
 * here is that those measures move. The live path is a POST to InnerTube's
 * `player` endpoint carrying an **iOS client profile**, then a GET of the caption
 * track as `json3`; the watch page's own `captionTracks` URLs answer `200` with
 * an empty body now, so the obvious scrape does not work. Measured 2026-08-06:
 * of the three client profiles the package tries, only iOS is alive — Android VR
 * answers `LOGIN_REQUIRED` and Web answers `UNPLAYABLE`. When that last one goes,
 * this file is not where the fix lives; `pnpm update youtube-caption-extractor`
 * is, and `pnpm youtube:check` is how it is noticed.
 *
 * Everything the summarizer's quality depends on stays here rather than in the
 * package: which URL shapes are a video, how cues become prose, where the cap
 * falls, and — the part that matters — *what the reader is told when it binds*.
 *
 * Read-only over everything, like the rest of the conversational surface
 * ([invariant 8](../../AGENTS.md#invariants)). Two outbound GETs and no writes;
 * nothing here is stored, and a transcript is re-fetched rather than cached, for
 * the same reason `read-article` re-fetches a page.
 */

/**
 * What a video turned out to be, once its captions were read.
 *
 * `seconds` and `covered` are separate on purpose and only differ when the cap
 * bound: the first is how long the video is, the second is how much of it the
 * summary actually saw. A caller that reports one without the other is the
 * failure this shape exists to prevent.
 */
export interface VideoTranscript {
  videoId: string
  /** Canonical, rebuilt from the id — never the URL the reader pasted. */
  url: string
  title: string
  /** Whole-video length in seconds, from the last cue's end. */
  seconds: number
  /** Seconds of video the transcript below actually covers. */
  covered: number
  /** True when `maxTranscriptChars` cut the transcript short. */
  truncated: boolean
  /** The spoken text, cue boundaries collapsed into prose. */
  text: string
}

/** Why a link produced no transcript. Each maps to a different thing to tell the reader. */
export type TranscriptFailure =
  /** The id is not a video, or the video is private, deleted or region-locked. */
  | 'unavailable'
  /** A real video with no caption track at all — nothing to summarize, ever. */
  | 'no-captions'
  /** Captions exist but carry no speech: a music video, a silent clip. */
  | 'no-speech'

export type TranscriptResult =
  | ({ ok: true } & VideoTranscript)
  | { ok: false; reason: TranscriptFailure }

/**
 * The video id in a string, or null.
 *
 * Takes free text rather than a URL because that is what arrives: the reader
 * pastes a link into a sentence, and Telegram sends the sentence. The first
 * match wins — a message with two videos is a question about the first one, and
 * summarizing both unasked is worse than asking which.
 */
export function videoIdFromText(text: string): string | null {
  return youtube.urlPattern.exec(text)?.[1] ?? null
}

/** The canonical watch URL for an id. Templated, never echoed from the reader. */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

/** Bounds each of the two HTTP calls; the package exposes no timeout of its own. */
const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(youtube.timeoutMs) })

/** A cue's end time in seconds. Both fields arrive as strings. */
function cueEnd(cue: Subtitle): number {
  return (Number(cue.start) || 0) + (Number(cue.dur) || 0)
}

/**
 * Cues to prose, stopping at the cap and reporting where it stopped.
 *
 * The stop is measured in *video time* rather than as a fraction of characters,
 * because that is the only form a reader can act on: "covers the first 2h04m"
 * tells them what to go and watch, "covers 89%" does not.
 *
 * Cues are joined with spaces and re-wrapped, not with newlines. A caption track
 * breaks lines to fit a screen — mid-sentence, mid-clause — so keeping those
 * breaks hands the model 3,000 fragments and invites it to read them as a list.
 */
function toProse(cues: Subtitle[]): { text: string; covered: number; truncated: boolean } {
  const pieces: string[] = []
  let length = 0
  let covered = 0

  for (const cue of cues) {
    const piece = cue.text.replace(/\s+/g, ' ').trim()
    if (!piece) continue
    // +1 for the joining space, so the cap is the length of the result rather
    // than of the parts.
    if (length + piece.length + 1 > youtube.maxTranscriptChars) {
      return { text: pieces.join(' '), covered, truncated: true }
    }
    pieces.push(piece)
    length += piece.length + 1
    covered = cueEnd(cue)
  }

  return { text: pieces.join(' '), covered, truncated: false }
}

/**
 * One video's transcript, or the reason there isn't one.
 *
 * Never throws. The three failures are distinguished because they want three
 * different sentences from Newy — a private video is worth re-checking the link
 * for, a video with no captions never will have any however many times it is
 * asked for, and a music video is neither. Collapsing them into "it didn't work"
 * is what makes a reader retry something that cannot succeed.
 */
export async function fetchVideoTranscript(videoId: string): Promise<TranscriptResult> {
  let details: Awaited<ReturnType<typeof getVideoDetails>>
  try {
    details = await getVideoDetails({
      videoID: videoId,
      lang: youtube.preferredCaptionLanguage,
      fetch: timedFetch,
    })
  } catch {
    // The package throws one error for every way a video can be unreachable —
    // private, deleted, age-gated, region-locked, or a timeout — and does not
    // distinguish them. Neither can we, and neither can the reader.
    return { ok: false, reason: 'unavailable' }
  }

  if (details.subtitles.length === 0) return { ok: false, reason: 'no-captions' }

  const { text, covered, truncated } = toProse(details.subtitles)
  if (text.length < youtube.minTranscriptChars) return { ok: false, reason: 'no-speech' }

  return {
    ok: true,
    videoId,
    url: watchUrl(videoId),
    title: details.title,
    // The last cue ends at roughly the end of the video, which is the only
    // length available here — the package returns title, description and cues,
    // and nothing about the video itself.
    seconds: Math.round(cueEnd(details.subtitles.at(-1)!)),
    covered: Math.round(covered),
    truncated,
    text,
  }
}

/** `1h56m`, `19m`, `45s` — for a reader, not for a machine. */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}
