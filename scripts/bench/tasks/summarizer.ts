/**
 * `pnpm bench summarizer` — `AVA_MODEL_SUMMARIZER`, through `summarizeSource`.
 *
 * A fixture is one stored article, summarized in French — the language
 * the old `models:check` measured in, and the harder case: the frame the prompt
 * spends most words forbidding ("Cet article…") survives most often outside
 * English. With its title, as the command passes it.
 *
 * A call someone waits on, with no retry behind it, so routing is an axis here
 * as it is for the translator, and `worst` is the column to read beside `median`.
 */
import { summary as summaryConfig } from '../../../src/config/summary.js'
import { translation } from '../../../src/config/translation.js'
import {
  summarizeSource,
  summarizer as summarizerAgent,
  summarizerId,
  type SourceSummary,
} from '../../../src/mastra/agents/summarizer.js'
import type { BenchTask } from '../kit.js'
import { readArticleBodies, words } from './articles.js'

export interface SummarizerFixture {
  title: string
  source: string
  text: string
  language: string
}

/** The frames the prompt forbids, in the languages it writes in. Carried over from the old `models:check`. */
const FRAMES =
  /^\s*(cet? article|cette (vidéo|présentation)|dans cet article|este (resumo|artigo)|nesta|this (article|piece|post|video)|in this (article|piece|video)|the (article|author|video|speaker|presenter|paper) (covers|explains|describes|details)|el artículo|dieser artikel|данная статья|эта статья)/i

/** Everything code can prove wrong with one summary. */
export function summarizerFlags(result: SourceSummary): string[] {
  const flags: string[] = []
  if (result.paragraphs.every(p => !p.trim())) flags.push('empty summary')
  const framed = result.paragraphs.find(block => FRAMES.test(block))
  if (framed) flags.push(`opens a block on the article rather than its subject — "${framed.slice(0, 70)}"`)
  if (result.paragraphs.some(block => /^#{1,2}\s/.test(block.trimStart()))) flags.push('a "#" or "##" heading, which the template owns')
  if (result.paragraphs.some(block => /\[[^\]]*\]\([^)]*\)|https?:\/\//.test(block))) flags.push('contains a link')
  return flags
}

export const summarizer: BenchTask<SummarizerFixture, SourceSummary> = {
  title: 'summarizer',
  knob: 'AVA_MODEL_SUMMARIZER',
  agentId: summarizerId,
  agent: summarizerAgent,
  field: [
    { model: 'openrouter/openai/gpt-5.6-luna', efforts: [false, 'low'], sorts: ['price'] },
    { model: 'openrouter/deepseek/deepseek-v4.1-flash', efforts: [false, 'low'], sorts: ['throughput'] },
    { model: 'openrouter/anthropic/claude-haiku-5.5', efforts: [false, 'low'], sorts: ['price'] },
  ],
  fixtures: async count =>
    (await readArticleBodies(count, summaryConfig.maxSourceChars)).map(body => ({
      ...body,
      language: translation.fallbackLanguage,
    })),
  describe: f => `${f.title.slice(0, 60)} — ${f.source}, ${f.text.length} chars, into ${f.language}`,
  call: (mastra, f) => summarizeSource(mastra, { text: f.text, language: f.language, kind: 'article', title: f.title }),
  check: summarizerFlags,
  metrics: result => ({
    words: words(result.paragraphs.join(' ')),
    blocks: result.paragraphs.length,
    bullets: result.paragraphs.filter(block => block.trimStart().startsWith('- ')).length,
  }),
  judgeInput: f => [`Write the summary in: ${f.language}`, `Title: "${f.title}"`, '', '--- ARTICLE ---', f.text].join('\n'),
  renderOutput: result => [`language: ${result.language}`, '', ...result.paragraphs].join('\n\n'),
  criteria: [
    'Specific: it says what this article actually claims — its names, numbers and argument. A summary ' +
    'that would fit any article on the topic fails.',
    'Faithful: nothing that is not in the article.',
    'About the subject, never about the article ("Cet article explique…"), and in the requested language.',
    'Its length and structure suit the source, with no links and no "#"/"##" headings.',
  ],
  caveats: () => ['For a call someone waits on, read `worst` beside `median`: the reader remembers the slow one.'],
}
