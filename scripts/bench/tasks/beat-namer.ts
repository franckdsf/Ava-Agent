/**
 * `pnpm bench beat-namer` — `AVA_MODEL_BEAT_NAMER`, through `nameBeat`.
 *
 * The fixtures are written: subjects a reader might hand Newy, in English and
 * in French, broad and narrow. Unlike the targeter there is no single right
 * answer to label — a beat about Formula 1 has many fair rubrics — so code
 * checks only what `nameBeat` and the instructions make checkable, and the
 * judge weighs whether the rubric would rank this subject's news well.
 *
 * `nameBeat` already throws on an unusable slug or no subtopics; that is a
 * failed parse here, as it is a failed command for the reader.
 */
import { discovery } from '../../../src/config/discovery.js'
import { nameBeat, namerId, scoutAgents, type NamedBeat } from '../../../src/mastra/agents/scout.js'
import type { BenchTask } from '../kit.js'

export interface BeatNamerFixture {
  subjects: string[]
}

const FIXTURES: BeatNamerFixture[] = [
  { subjects: ['la formule 1', 'Rust and systems programming', 'urban cycling and bike infrastructure', 'quantum computing research'] },
  { subjects: ['jardinage en permaculture', 'indie game development', 'les nouveautés de Postgres', 'climate policy in the EU'] },
]

type Named = (NamedBeat | null)[]

/** Everything code can prove wrong with one run's beats. */
export function beatNamerFlags(named: Named, fixture: BeatNamerFixture): string[] {
  return named.flatMap((beat, index) => {
    const at = `subject ${index + 1}`
    if (!fixture.subjects[index]) return []
    if (!beat) return [`${at}: no usable beat — the reader is told to try again`]
    const flags: string[] = []
    if (beat.subtopics.length < discovery.subtopicCount.min) {
      flags.push(`${at}: ${beat.subtopics.length} subtopics, at least ${discovery.subtopicCount.min} needed`)
    }
    // `nameBeat` falls back to the title when the model skipped the query.
    if (beat.searchQuery === beat.title) flags.push(`${at}: no search query — the scout searches on the title`)
    if (beat.emoji === '📌') flags.push(`${at}: no usable emoji — the generic fallback was used`)
    return flags
  })
}

export const beatNamer: BenchTask<BeatNamerFixture, Named> = {
  title: 'beat-namer',
  knob: 'AVA_MODEL_BEAT_NAMER',
  agentId: namerId,
  agent: scoutAgents[namerId],
  field: [
    { model: 'openrouter/deepseek/deepseek-v4.1-flash', efforts: [false, 'low'] },
    { model: 'openrouter/openai/gpt-5.6-luna', efforts: [false, 'low'] },
    { model: 'openrouter/anthropic/claude-haiku-5.5', efforts: [false] },
  ],
  fixtures: async count => FIXTURES.slice(0, count),
  written: true,
  describe: f => f.subjects.map(s => `"${s}"`).join(' · '),
  call: async (mastra, fixture) => {
    const named: Named = []
    for (const subject of fixture.subjects) {
      try {
        named.push(await nameBeat(mastra, subject))
      } catch {
        named.push(null)
      }
    }
    return named.some(Boolean) ? named : null
  },
  check: beatNamerFlags,
  metrics: named => {
    const ok = named.filter((b): b is NamedBeat => b !== null)
    return {
      subtopics: ok.length ? ok.reduce((sum, b) => sum + b.subtopics.length, 0) / ok.length : NaN,
      'rubric words': ok.length ? ok.reduce((sum, b) => sum + b.rubric.split(/\s+/).length, 0) / ok.length : NaN,
    }
  },
  judgeInput: f => f.subjects.map((s, i) => `## Subject ${i + 1}\nThe reader wants to follow this subject:\n\n${s}`).join('\n\n'),
  renderOutput: (named, fixture) =>
    named
      .map((b, i) => {
        const head = `Subject ${i + 1} — "${fixture.subjects[i] ?? ''}"`
        return b
          ? [head, `${b.emoji} ${b.title} (${b.slug})`, `search: ${b.searchQuery}`, `subtopics: ${b.subtopics.join(', ')}`, b.rubric].join('\n')
          : `${head}\nNO BEAT`
      })
      .join('\n\n'),
  criteria: [
    'The rubric would rank this subject\'s news well: what scores high and low is specific to the subject, ' +
      'so a ranker reading it separates the stories the reader wants from the ones they do not.',
    'The title and subtopics are what a person following the subject would recognise; subtopics split the ' +
      'subject into the parts its news actually falls into.',
    'Everything is in English whatever the subject\'s language, and the search query is an English phrase a ' +
      'web search would find feeds with.',
  ],
  caveats: () => ['Fixtures are written subjects, English and French; there is no labelled answer, only the rules.'],
}
