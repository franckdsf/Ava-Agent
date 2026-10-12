/**
 * `pnpm bench memory-reviewer` — `AVA_MODEL_MEMORY_REVIEWER`, through
 * `reviewMemories`.
 *
 * **The one task whose fixtures carry the answer.** The reviewer decides which
 * short-term notes become lasting, and its instructions define that rule
 * sharply: still true of the person → keep; a moment that left nothing → let
 * go; already said by a lasting note → let go; could go either way → keep. So
 * the fixtures are written here, about an invented person, each short note
 * labelled with what the rule says. Written, not read from the database, because a week's
 * real notes are a handful and nobody's own memories belong in a repo.
 *
 * The costs are not equal and neither are the flags. Losing a fact about who
 * someone is deletes it for good, so every `keep` not promoted is a flag;
 * keeping an ordinary day costs one line, so that is a count.
 */
import { reviewMemories, memoryReviewer, memoryReviewerId, type Promotion } from '../../../src/mastra/agents/memory.js'
import type { Memory } from '../../../src/db/memories.js'
import { bench } from '../../../src/config/bench.js'
import type { BenchTask } from '../kit.js'

/**
 * `borderline` is a note a careful reader could argue either way. The
 * instructions lean on it — "when a note could go either way, keep it" — so
 * keeping one is right and `borderline kept` measures it. Counted, never
 * flagged: left unscored, every model looked perfect; flagged, every model
 * looked unshippable. Measured, the efforts separate (v4-pro and v4.1 at `high`
 * kept 7 of 9 on the first run, v4.1 off 4, luna off 1), which is the
 * judgement the reviewer exists for — though v4-pro kept 42% on a rerun, so one
 * run is not the number.
 */
type Label = 'keep' | 'borderline' | 'drop' | 'duplicate'

interface Note {
  fact: string
  happenedOn: string
  label?: Label
}

export interface MemoryReviewerFixture {
  name: string
  long: Note[]
  short: Note[]
}

const memory = (tier: 'long' | 'short', note: Note, index: number): Memory => ({
  id: `${tier}-${index + 1}`,
  tier,
  fact: note.fact,
  happenedOn: note.happenedOn,
  recordedOn: note.happenedOn,
})

const notes = (f: MemoryReviewerFixture) => ({
  long: f.long.map((n, i) => memory('long', n, i)),
  short: f.short.map((n, i) => memory('short', n, i)),
})

const FIXTURES: MemoryReviewerFixture[] = [
  {
    name: 'a month of a designer in Nantes',
    long: [
      { fact: 'They are a product designer.', happenedOn: '2025-11-02' },
      { fact: 'They live in Nantes.', happenedOn: '2025-11-02' },
      { fact: 'They are vegetarian.', happenedOn: '2026-01-14' },
      { fact: 'Their partner is called Inès.', happenedOn: '2026-02-03' },
    ],
    short: [
      { fact: 'They started a new job at Lumen as lead designer.', happenedOn: '2026-09-01', label: 'keep' },
      { fact: 'They had a crêpe for lunch at the market.', happenedOn: '2026-09-03', label: 'drop' },
      { fact: 'Their brother Hugo moved to Montréal.', happenedOn: '2026-09-04', label: 'keep' },
      { fact: 'They spent Tuesday fixing a broken Figma library.', happenedOn: '2026-09-09', label: 'drop' },
      { fact: 'They do not eat meat.', happenedOn: '2026-09-10', label: 'duplicate' },
      { fact: 'They were diagnosed with asthma.', happenedOn: '2026-09-11', label: 'keep' },
      { fact: 'They watched a documentary about Brutalism.', happenedOn: '2026-09-12', label: 'drop' },
      { fact: 'They asked to be reminded that they prefer replies in French.', happenedOn: '2026-09-14', label: 'keep' },
      { fact: 'They felt tired after a long sprint review.', happenedOn: '2026-09-16', label: 'drop' },
      { fact: 'They have started learning the cello.', happenedOn: '2026-09-18', label: 'keep' },
      { fact: 'They went to a friend\'s birthday dinner.', happenedOn: '2026-09-20', label: 'drop' },
      { fact: 'They are thinking about adopting a cat.', happenedOn: '2026-09-22', label: 'borderline' },
      { fact: 'Their partner Inès is a nurse.', happenedOn: '2026-09-24', label: 'keep' },
      { fact: 'They bought new running shoes.', happenedOn: '2026-09-26', label: 'drop' },
    ],
  },
  {
    name: 'a month of an engineer in Lyon',
    long: [
      { fact: 'They are a backend engineer working mostly in Go.', happenedOn: '2025-06-10' },
      { fact: 'They live in Lyon.', happenedOn: '2025-06-10' },
      { fact: 'They have a daughter, Léa, born in 2022.', happenedOn: '2025-08-21' },
      { fact: 'They are allergic to peanuts.', happenedOn: '2025-12-01' },
    ],
    short: [
      { fact: 'They moved from Lyon to Grenoble.', happenedOn: '2026-09-02', label: 'keep' },
      { fact: 'They debugged a flaky integration test all morning.', happenedOn: '2026-09-03', label: 'drop' },
      { fact: 'They avoid peanuts because of an allergy.', happenedOn: '2026-09-05', label: 'duplicate' },
      { fact: 'They ordered sushi on Friday night.', happenedOn: '2026-09-06', label: 'drop' },
      { fact: 'They have switched to writing most new services in Rust.', happenedOn: '2026-09-08', label: 'keep' },
      { fact: 'Léa started nursery school.', happenedOn: '2026-09-09', label: 'keep' },
      { fact: 'They read an article about database indexes.', happenedOn: '2026-09-11', label: 'drop' },
      { fact: 'Their father passed away.', happenedOn: '2026-09-13', label: 'keep' },
      { fact: 'They had a dentist appointment.', happenedOn: '2026-09-15', label: 'drop' },
      { fact: 'They do not want news about cryptocurrency.', happenedOn: '2026-09-17', label: 'keep' },
      { fact: 'They are planning a trip to Japan next spring.', happenedOn: '2026-09-19', label: 'borderline' },
      { fact: 'They played board games with neighbours.', happenedOn: '2026-09-21', label: 'drop' },
      { fact: 'They work remotely on Fridays.', happenedOn: '2026-09-23', label: 'borderline' },
      { fact: 'They were promoted to staff engineer.', happenedOn: '2026-09-25', label: 'keep' },
    ],
  },
]

/** The labelled short notes, by the id `reviewMemories` sees. */
function labelled(f: MemoryReviewerFixture, label: Label): { id: string; fact: string }[] {
  return f.short.flatMap((n, i) => (n.label === label ? [{ id: `short-${i + 1}`, fact: n.fact }] : []))
}

/** Everything code can prove wrong with one review, given the labels. */
export function memoryReviewerFlags(promoted: Promotion[], fixture: MemoryReviewerFixture): string[] {
  const kept = new Set(promoted.map(p => p.id))
  const flags: string[] = []
  // Clear keeps only. A dropped borderline note is counted, not flagged: a flag
  // reaches the judge as fact, and the second live run showed the cost — every
  // entrant "unshippable" over "thinking about adopting a cat", a note the
  // instructions' own let-go list ("a plan tied to that one week") also covers.
  const lost = labelled(fixture, 'keep').filter(n => !kept.has(n.id))
  if (lost.length) flags.push(`${lost.length} lasting fact(s) left to be deleted, e.g. "${lost[0]?.fact}"`)
  const dup = labelled(fixture, 'duplicate').filter(n => kept.has(n.id))
  if (dup.length) flags.push(`kept a duplicate of a lasting note: "${dup[0]?.fact}"`)
  const twice = promoted.filter((p, i) => promoted.findIndex(q => q.id === p.id) !== i)
  if (twice.length) flags.push(`promoted the same note twice: ${twice[0]?.id}`)
  return flags
}

export const memoryReviewerTask: BenchTask<MemoryReviewerFixture, Promotion[]> = {
  title: 'memory-reviewer',
  knob: 'AVA_MODEL_MEMORY_REVIEWER',
  agentId: memoryReviewerId,
  agent: memoryReviewer,
  // Edited freely between runs. The fields that kept v4-pro at `high` on
  // 2026-10-12 (see memory.ts) were v4.1-flash off/low/high, gpt-5.6-luna
  // off/low/medium/high and glm-5.3-flash low, over two runs.
  field: [
    // { model: 'openrouter/deepseek/deepseek-v4.1-flash', efforts: [false, 'low', 'high'] },
    { model: 'openrouter/openai/gpt-5.6-luna', efforts: ['medium', 'high'] },
    // { model: 'openrouter/z-ai/glm-5.3-flash', efforts: ['low'] },
  ],
  fixtures: async count => FIXTURES.slice(0, count),
  written: true,
  describe: f => `${f.name} — ${f.long.length} lasting, ${f.short.length} recent (${labelled(f, 'keep').length} to keep)`,
  // An empty promotion list is a valid answer, not a failure — `reviewMemories`
  // throws when the model returned nothing parseable, and that is the failure.
  call: (mastra, fixture) => reviewMemories(mastra, notes(fixture)),
  check: memoryReviewerFlags,
  metrics: (promoted, fixture) => {
    const kept = new Set(promoted.map(p => p.id))
    const keeps = labelled(fixture, 'keep')
    const borderline = labelled(fixture, 'borderline')
    return {
      // The share of facts about the person that survive — the number that matters.
      'keep recall': keeps.length ? keeps.filter(n => kept.has(n.id)).length / keeps.length : NaN,
      'borderline kept': borderline.length ? borderline.filter(n => kept.has(n.id)).length / borderline.length : NaN,
      'moments kept': labelled(fixture, 'drop').filter(n => kept.has(n.id)).length,
      'long reasons': promoted.filter(p => p.reason.split(/\s+/).filter(Boolean).length > bench.promptLimits.reviewerReasonWords).length,
    }
  },
  judgeInput: f => {
    const { long, short } = notes(f)
    return [
      `## LASTING notes — context only`,
      ...long.map(n => `- ${n.id} | ${n.happenedOn} | ${n.fact}`),
      '',
      `## RECENT notes to judge`,
      ...short.map(n => `- ${n.id} | ${n.happenedOn} | ${n.fact}`),
    ].join('\n')
  },
  renderOutput: (promoted, fixture) => {
    const facts = new Map(notes(fixture).short.map(n => [n.id, n.fact]))
    return promoted.length
      ? promoted.map(p => `KEEP ${p.id} | ${facts.get(p.id) ?? '?'} | ${p.reason}`).join('\n')
      : '(kept nothing)'
  },
  criteria: [
    'Every note still true of the person — who they are, who is close to them, where they live, their work, ' +
    'health, lasting preferences, a change of state that persists, anything they asked to be remembered — ' +
    'is kept. Losing one is the worst failure: it is deleted for good.',
    'A note that could go either way is kept, as the instructions say — keeping it is correct, not a lapse.',
    'Notes about a passing moment are let go, and so is any note a lasting note already says in other words.',
    'Each reason says, in at most 12 words, why the note is still true of the person.',
  ],
  caveats: () => [
    'Fixtures are written, not read: an invented person, each recent note labelled by the rule in the ' +
    'instructions. `keep recall` is the clear keeps (a miss is a flag); `borderline kept` is the arguable ' +
    'ones the rule says to keep — a column, not a flag, because arguable is not provable.',
  ],
}
