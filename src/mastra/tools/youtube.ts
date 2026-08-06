import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { summary } from '../../config/summary.js'
import { youtube } from '../../config/youtube.js'
import {
  fetchVideoTranscript,
  formatDuration,
  videoIdFromText,
  watchUrl,
} from '../../services/youtube.js'
import { summarizeSource } from '../agents/summarizer.js'

/**
 * A YouTube link, explained — Newy's one tool that reads something from outside
 * this system.
 *
 * **A tool rather than a command, and that is the whole point of it.** Every
 * other long-form explanation here is a slash command, for a structural reason
 * that does not apply to a video: `/summarize` and `/translate` work on the
 * article a reader *swiped*, and a swipe is only reachable from the raw Telegram
 * payload a command handler receives. A video link is not swiped, it is pasted —
 * it arrives in an ordinary message, on the message path, where Newy is already
 * reading. Making it `/summarizevideo <url>` would mean the reader typing a
 * command to do the one thing the link already says.
 * See [ADR-0032](../../../docs/decisions/0032-a-youtube-link-summarizes-itself.md).
 *
 * Read-only, like the rest of her surface
 * ([invariant 8](../../../AGENTS.md#invariants)): two outbound GETs and a model
 * call, nothing stored, no run started, no table touched. And it is inbound and
 * human-triggered, so it sits under invariant 2's second category with the
 * translator and the summarizer — a person pasted a link, rather than a cron
 * fire nobody watches.
 */

/**
 * What the reader is told when there is no transcript.
 *
 * Three sentences rather than one, because they ask for three different things
 * and a reader who gets "it didn't work" will retry the one that cannot succeed.
 * Written here rather than left to the model so that the *facts* in them are
 * fixed — whether captions can appear later is not something to be improvised —
 * while Newy still says them in the reader's own language.
 */
const FAILURES = {
  unavailable:
    'The video could not be opened — it may be private, deleted, age-restricted or ' +
    'unavailable in this region, or the link may be wrong. Worth checking the link.',
  'no-captions':
    'The video has no captions at all, so there is no transcript to work from. This will ' +
    'not change unless its owner adds them — nothing is worth retrying.',
  'no-speech':
    'The video has captions but almost no speech in them — music, or sound effects. There ' +
    'is nothing to summarize.',
} as const

export const summarizeVideo = createTool({
  id: 'summarize-video',
  description:
    'Fetch a YouTube video\'s transcript and summarize what was actually said, at length. ' +
    'Call this whenever the reader\'s message contains a YouTube link (youtube.com or youtu.be) ' +
    'and they want to know what is in it — including when they paste the link on its own with ' +
    'no question, which is a request for this. Do not call it for a non-YouTube video link, and ' +
    'do not try to describe a YouTube video without calling it: you cannot watch video, and the ' +
    'title alone is not what it is about.',
  inputSchema: z.object({
    url: z
      .string()
      .describe(
        'The YouTube URL exactly as the reader sent it. Every shape works — youtu.be, ' +
        '/shorts/, /live/, /embed/, with or without a timestamp or playlist.',
      ),
    language: z
      .string()
      .default(summary.defaultLanguage)
      .describe(
        'The language to write the summary in, named in English ("French", "Brazilian ' +
        'Portuguese"). Pass the language the reader is writing to you in, not the video\'s.',
      ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    /** Present only on failure; the sentence to tell the reader, in their language. */
    problem: z.string().nullable(),
    title: z.string().nullable(),
    /** Canonical watch URL, rebuilt from the id. The one to link — never the pasted one. */
    url: z.string().nullable(),
    duration: z.string().nullable(),
    /**
     * Set only when the transcript was cut short, and it must be passed on.
     * A summary of the first two hours of a three-hour stream is not wrong, but
     * a reader who is not told is being misled about what they just read.
     */
    covers: z.string().nullable(),
    /** The language the summary actually came back in, named in English. */
    language: z.string().nullable(),
    /** The summary as markdown blocks, in order. Reproduce them, do not re-summarize. */
    summary: z.array(z.string()).nullable(),
  }),
  execute: async ({ url, language }, context) => {
    const fail = (problem: string) => ({
      ok: false,
      problem,
      title: null,
      url: null,
      duration: null,
      covers: null,
      language: null,
      summary: null,
    })

    const videoId = videoIdFromText(url)
    if (!videoId) {
      return fail('That does not contain a YouTube link, so there is nothing to fetch.')
    }

    const transcript = await fetchVideoTranscript(videoId)
    if (!transcript.ok) {
      return { ...fail(FAILURES[transcript.reason]), url: watchUrl(videoId) }
    }

    // From the execution context rather than a module import: the agent that
    // registered this tool is the one holding the live Mastra instance, and
    // `summarizeSource` resolves the summarizer through it so that this call is
    // logged and traced like every other one in the system.
    const mastra = context?.mastra
    if (!mastra) throw new Error('summarize-video ran with no Mastra instance in context.')

    const result = await summarizeSource(mastra, {
      text: transcript.text,
      language,
      kind: 'transcript',
    })

    return {
      ok: true,
      problem: null,
      title: transcript.title,
      url: transcript.url,
      duration: formatDuration(transcript.seconds),
      // Only when it bound. A null here means the summary saw the whole video,
      // and Newy has nothing to qualify.
      covers: transcript.truncated
        ? `the first ${formatDuration(transcript.covered)} of ${formatDuration(transcript.seconds)}`
        : null,
      language: result.language,
      summary: result.paragraphs,
    }
  },
})

/**
 * Exported as its own group rather than folded into `newsTools`, because it is
 * not news: it reads nothing this pipeline stored and answers a question about
 * something the reader found themselves. Grouping it with the database tools
 * would be the first step toward Newy offering to "search her videos".
 */
export const videoTools = { summarizeVideo }

/** Re-exported so the check script and Newy's prompt agree on the cap. */
export const videoTranscriptCap = youtube.maxTranscriptChars
