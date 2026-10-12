/**
 * `pnpm bench translator` — `AVA_MODEL_TRANSLATOR`, through `translateChunk`.
 *
 * A fixture is the first part of one stored article, cut exactly as the command
 * cuts it, translated in `/translearn` mode — the one with a gloss floor, and so
 * the one with a retry behind it. The retry is part of what is measured: a model
 * that degenerates one call in seven costs the reader a second wait that often.
 *
 * This is a call someone waits on, so routing is a first-class axis here: the
 * field can enter one model under several `sorts`, and the table's `worst`
 * column is the number to read beside the median.
 *
 * **Parentheses are counted, not flagged.** `gloss/100` counts every
 * parenthesis, and a source's own "(2024)" or "(GPU)" is not a gloss — a flag
 * reaches the judge as fact, so only what the app itself treats as failure is
 * one: `isDegenerate`, the test `translateChunk` retries against.
 */
import { bench } from '../../../src/config/bench.js'
import { TRANSLATIONS, translation } from '../../../src/config/translation.js'
import {
  isDegenerate,
  translateChunk,
  translator as translatorAgent,
  translatorId,
  type Translation,
} from '../../../src/mastra/agents/translator.js'
import { chunkText } from '../../../src/services/article.js'
import type { BenchTask } from '../kit.js'
import { readArticleBodies, words } from './articles.js'

const MODE = TRANSLATIONS['/translearn']

export interface TranslatorFixture {
  title: string
  source: string
  /** The first part, as `chunkText` cuts it for the command. */
  part: string
}

/** Everything code can prove wrong with one translation. */
export function translatorFlags(result: Translation): string[] {
  const flags: string[] = []
  if (result.paragraphs.every(p => !p.trim())) flags.push('empty translation')
  // The app's own definition of "did not do the job", still true after its retry.
  else if (isDegenerate(result, MODE)) flags.push('degenerate even after the retry: echoed the source or carried no glosses')
  if (result.paragraphs.some(p => /\[[^\]]*\]\([^)]*\)|https?:\/\//.test(p))) flags.push('contains a link')
  return flags
}

/** What the old `models:check` measured, kept so a table reads like the old one. */
export function translatorMetrics(paragraphs: string[]): Record<string, number> {
  const joined = paragraphs.join(' ')
  const total = words(joined)
  const glosses = joined.match(/\(([^)]+)\)/g) ?? []
  return {
    'gloss/100': total ? (glosses.length / total) * 100 : NaN,
    // Glosses missing the `(_term_)` form, and glosses long enough to be a note
    // to the reader rather than a term — the failure the prompt argues against.
    'wrong form': glosses.filter(g => !/^\(_[^)]+_\)$/.test(g)).length,
    'long gloss': glosses.filter(g => words(g) > bench.longGlossWords).length,
    words: total,
  }
}

export const translator: BenchTask<TranslatorFixture, Translation> = {
  title: 'translator',
  knob: 'AVA_MODEL_TRANSLATOR',
  agentId: translatorId,
  agent: translatorAgent,
  field: [
    { model: 'openrouter/openai/gpt-5.6-luna', efforts: [false, 'low'], sorts: ['price'] },
    { model: 'openrouter/deepseek/deepseek-v4.1-flash', efforts: [false, 'low'], sorts: ['throughput'] },
    { model: 'openrouter/anthropic/claude-haiku-5.5', efforts: [false, 'low'], sorts: ['price'] },
  ],
  fixtures: async count =>
    (await readArticleBodies(count, translation.maxSourceChars)).map(({ title, source, text }) => ({
      title,
      source,
      part: chunkText(text, translation.sourceChunkChars)[0] ?? '',
    })),
  describe: f => `${f.title.slice(0, 60)} — ${f.source}, part 1 of the article (${f.part.length} chars)`,
  // Part 1 of 1 with no language passed: the first part is the one that reads
  // the reader's notes and decides the language, as the command's first does.
  call: (mastra, fixture) => translateChunk(mastra, { text: fixture.part, definition: MODE, part: { index: 1, total: 1 } }),
  check: translatorFlags,
  metrics: result => translatorMetrics(result.paragraphs),
  judgeInput: f => [`How to gloss: ${MODE.gloss}`, '', '--- TEXT TO TRANSLATE ---', f.part].join('\n'),
  renderOutput: result => [`language: ${result.language}`, '', ...result.paragraphs].join('\n\n'),
  criteria: [
    'Faithful: every sentence of the source is translated, nothing is added or left out, and the meaning ' +
    'survives — including numbers, names and code.',
    'Glossing follows the mode: the terms a reader at this level needs, in the `(_term_)` form, short, ' +
    'never a note to the reader — neither a gloss on every other word nor a passage with none.',
    'It reads as natural prose in the target language, with the source\'s blocks kept and no links.',
  ],
  caveats: () => [
    '`gloss/100` counts every parenthesis, including the source\'s own; `wrong form` and `long gloss` are ' +
    'counts, not flags, for the same reason. For a call someone waits on, read `worst` beside `median`.',
  ],
}
