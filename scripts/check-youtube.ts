import { youtube } from '../src/config/youtube.js'
import {
  fetchVideoTranscript,
  formatDuration,
  videoIdFromText,
} from '../src/services/youtube.js'

/**
 * Dry-runs the transcript half of `summarize-video`: parses URLs, fetches real
 * captions, and reports what the summarizer would have been handed.
 *
 * **This is the early-warning system for a dependency that scrapes another
 * company.** YouTube's caption endpoints are behind anti-bot measures that move,
 * and the failure when they move is total and silent from the outside — Newy
 * simply starts saying she cannot read any video. The watch page's own caption
 * URLs already answer 200 with an empty body, which is exactly what this looks
 * like; `youtube-caption-extractor` gets past it with an iOS client profile, and
 * measured 2026-08-06 that was the **only** one of its three profiles still
 * alive. When this script starts failing on every video, the fix is
 * `pnpm update youtube-caption-extractor`, not this repo.
 *
 * Read-only, writes nothing, needs no `.env` and calls **no model** — it stops
 * at the transcript. The summarizer is exercised by using the thing.
 *
 * Pass a URL or id to check one video; with no argument it runs a fixed set
 * chosen to cover the shapes that behave differently.
 */

/**
 * The default set, and each one earns its place by failing differently.
 *
 * A 19-second clip and a 1h56m talk are the two ends of the length problem; the
 * long one is the case `maxTranscriptChars` exists for and the only way to see
 * the cap bind. A music video is the `no-speech` floor. A dead id is the
 * `unavailable` path, which must not be reported as "no captions".
 */
const DEFAULTS = [
  { url: 'https://youtu.be/jNQXAC9IVRw', note: 'shortest real video — 19s of speech' },
  { url: 'https://www.youtube.com/watch?v=aircAruvnKk', note: '19m, manual captions, 31 tracks' },
  { url: 'https://www.youtube.com/watch?v=kCc8FmEb1nY', note: '1h56m, auto captions — the cap case' },
  { url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk', note: 'music video — mostly lyrics' },
  { url: 'https://www.youtube.com/watch?v=ZZZZZZZZZZZ', note: 'nonexistent id — must be "unavailable"' },
]

/** Every URL shape Telegram might deliver, plus one that must be refused. */
const URL_SHAPES = [
  'https://www.youtube.com/watch?v=aircAruvnKk',
  'https://youtu.be/aircAruvnKk?t=42',
  'https://www.youtube.com/shorts/aircAruvnKk',
  'https://www.youtube.com/live/aircAruvnKk',
  'https://www.youtube.com/embed/aircAruvnKk',
  'https://m.youtube.com/watch?v=aircAruvnKk&list=PLxyz',
  'youtube.com/watch?v=aircAruvnKk',
  'have a look at https://youtu.be/aircAruvnKk it is good',
  'https://example.com/watch?v=aircAruvnKk',
  'https://vimeo.com/123456789',
]

const argument = process.argv[2]

console.log(`cap        ${youtube.maxTranscriptChars.toLocaleString('en-US')} characters ` +
  `(~${Math.round(youtube.maxTranscriptChars / 4).toLocaleString('en-US')} tokens, ~${Math.round(youtube.maxTranscriptChars / 940)}m of speech)`)
console.log(`floor      ${youtube.minTranscriptChars} characters below which a video counts as speechless`)
console.log(`captions   preferring "${youtube.preferredCaptionLanguage}", falling back to whatever exists`)

if (!argument) {
  console.log('\nURL SHAPES')
  for (const shape of URL_SHAPES) {
    const id = videoIdFromText(shape)
    // The last two must be null. A parser that accepts them turns any link with
    // a "v=" parameter into a video, and turns a Vimeo link into a wrong answer.
    const expected = /youtube\.com|youtu\.be/.test(shape)
    const verdict = Boolean(id) === expected ? '  ' : '!!'
    console.log(`  ${verdict} ${(id ?? 'no match').padEnd(12)} ${shape}`)
  }
  console.log('     "!!" marks a shape parsed wrongly — a bare id means it was accepted.')
}

const targets = argument
  ? [{ url: argument, note: 'from the command line' }]
  : DEFAULTS

console.log('\nTRANSCRIPTS')
for (const target of targets) {
  const videoId = videoIdFromText(target.url) ?? (/^[A-Za-z0-9_-]{11}$/.test(target.url) ? target.url : null)
  console.log(`\n  ${target.url}`)
  console.log(`    ${target.note}`)
  if (!videoId) {
    console.log('    -> no video id in that argument')
    continue
  }

  const started = Date.now()
  const result = await fetchVideoTranscript(videoId)
  const took = `${Date.now() - started}ms`

  if (!result.ok) {
    console.log(`    -> ${result.reason.toUpperCase()} in ${took}`)
    continue
  }

  const words = result.text.split(/\s+/).length
  console.log(`    -> ok in ${took}`)
  console.log(`       title     ${result.title}`)
  console.log(`       length    ${formatDuration(result.seconds)}`)
  console.log(`       text      ${result.text.length.toLocaleString('en-US')} chars, ` +
    `${words.toLocaleString('en-US')} words, ~${Math.round(result.text.length / 4).toLocaleString('en-US')} tokens`)
  console.log(`       coverage  ${result.truncated
    ? `TRUNCATED — first ${formatDuration(result.covered)} of ${formatDuration(result.seconds)} ` +
      `(${Math.round((result.covered / result.seconds) * 100)}%)`
    : 'whole video'}`)
  console.log(`       opens     ${result.text.slice(0, 140)}…`)
}

console.log(
  '\nEvery video failing at once means the caption route has been blocked, not that\n' +
  'these videos changed. Try `pnpm update youtube-caption-extractor` first.\n' +
  'A container on a datacenter IP can be blocked while this machine is not — the\n' +
  'package accepts a custom fetch for a proxy if that day comes.',
)
