import { describe, expect, it } from 'vitest'

import { cloneProviderOptions } from '../clone.js'
import { attemptCost, blind, entrantsFor, judgePrompt, pool, renderTable, scoreSpread, spearman, type Row } from '../kit.js'
import { mentionsReader, rankerFlags, voteAgreement, type RankerFixture } from '../tasks/ranker.js'

describe('field', () => {
  const field = [
    { model: 'openrouter/a/one', efforts: [false, 'low'] as const },
    { model: 'openrouter/b/two', efforts: ['shipped'] as const },
  ]

  it('puts the incumbent first at its shipped effort, once', () => {
    expect(entrantsFor(field, 'openrouter/b/two', []).map(e => `${e.model}:${e.effort}`)).toEqual([
      'openrouter/b/two:shipped',
      'openrouter/a/one:false',
      'openrouter/a/one:low',
    ])
  })

  it('keeps the incumbent whatever the filter says', () => {
    expect(entrantsFor(field, 'openrouter/c/three', ['one']).map(e => e.model)).toEqual([
      'openrouter/c/three',
      'openrouter/a/one',
      'openrouter/a/one',
    ])
  })
})

describe('blind labels', () => {
  it('letters follow the shuffled order, so the incumbent is not always A', () => {
    // A random() of 0 swaps every item with the first: [a, b, c] → [b, c, a].
    expect(blind(['a', 'b', 'c'], () => 0)).toEqual([
      { label: 'A', item: 'b' },
      { label: 'B', item: 'c' },
      { label: 'C', item: 'a' },
    ])
  })

  it('runs past Z', () => {
    expect(blind(Array.from({ length: 28 }, (_, i) => i), () => 0.999).map(x => x.label).slice(25)).toEqual(['Z', 'AA', 'AB'])
  })
})

describe('pool', () => {
  it('keeps input order while finishing out of order, never more than the limit in flight', async () => {
    let inFlight = 0
    let peak = 0
    const done: number[] = []
    const results = await pool(
      [30, 10, 20, 5],
      2,
      async ms => {
        peak = Math.max(peak, ++inFlight)
        await new Promise(resolve => setTimeout(resolve, ms))
        inFlight -= 1
        return ms * 2
      },
      result => done.push(result),
    )
    expect(results).toEqual([60, 20, 40, 10])
    expect(done).not.toEqual(results)
    expect(peak).toBe(2)
  })
})

describe('provider options', () => {
  it('keeps the real pinning, swaps the effort, turns on usage', () => {
    const shipped = { openrouter: { provider: { order: ['groq'] }, reasoning: { effort: 'high' } } }
    expect(cloneProviderOptions(shipped, false)).toEqual({
      openrouter: { provider: { order: ['groq'] }, reasoning: { enabled: false }, usage: { include: true } },
    })
    expect(cloneProviderOptions(shipped, 'shipped').openrouter?.reasoning).toEqual({ effort: 'high' })
    expect(cloneProviderOptions(undefined, 2000).openrouter?.reasoning).toEqual({ enabled: true, max_tokens: 2000 })
  })
})

describe('cost', () => {
  const call = (cost: number | undefined) => ({ ms: 1, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cost })
  it('sums retries, and unreported is not free', () => {
    expect(attemptCost([call(0.001), call(0.002)])).toBeCloseTo(0.003)
    expect(attemptCost([call(undefined)])).toBeUndefined()
  })
})

describe('table', () => {
  const row = (over: Partial<Row>): Row => ({
    label: 'A',
    key: 'x @ off',
    incumbent: false,
    ok: 3,
    clean: 3,
    total: 3,
    medianMs: 1500,
    costPerRun: 0.0001,
    reasoning: 0,
    retries: 0,
    metrics: { spread: 4 },
    rank: 2,
    score: 7,
    ...over,
  })

  it('a field that failed entirely renders dashes, not NaN, and judged rows come first', () => {
    const table = renderTable([
      row({ label: 'B', key: 'dead @ low', ok: 0, clean: 0, medianMs: NaN, costPerRun: undefined, reasoning: NaN, metrics: {}, rank: NaN, score: NaN }),
      row({ label: 'A', incumbent: true }),
    ])
    expect(table).not.toMatch(/NaN|undefined/)
    const [, first, second] = table.split('\n')
    expect(first).toMatch(/^A\s+x @ off \*/)
    expect(second).toMatch(/^B\s+dead @ low\s+0\/3\s+0\/3\s+—\s+n\/a/)
  })
})

describe('spearman', () => {
  it('is 1 for the same order, -1 reversed, NaN when one side is flat', () => {
    expect(spearman([[1, 10], [2, 20], [3, 30]])).toBeCloseTo(1)
    expect(spearman([[1, 30], [2, 20], [3, 10]])).toBeCloseTo(-1)
    expect(spearman([[1, 5], [2, 5], [3, 5]])).toBeNaN()
    expect(spearman([[1, 1], [2, 2]])).toBeNaN()
  })
})

describe('judge prompt', () => {
  it('mentions flags only when a run has some', () => {
    const attempt = { key: 'k', fixture: 0, run: 0, ms: 1, calls: [], output: 'x', flags: [] as string[], metrics: {} }
    const base = { rules: 'R', given: 'G', criteria: ['C'], runs: 1, render: (o: string) => o }
    expect(judgePrompt({ ...base, candidates: [{ label: 'A', attempts: [attempt] }] })).not.toMatch(/verified by code/)
    expect(judgePrompt({ ...base, candidates: [{ label: 'A', attempts: [{ ...attempt, flags: ['bad'] }] }] })).toMatch(
      /verified by code/,
    )
  })
})

describe('ranker checks', () => {
  const fixture: RankerFixture = {
    beat: { slug: 'rust', title: 'Rust', rubric: 'r', subtopics: ['release', 'tooling'], digestThreshold: 70 },
    profile: '',
    reader: '',
    articles: [
      { id: 'a', source: 's', title: 't', excerpt: null },
      { id: 'b', source: 's', title: 't', excerpt: null },
      { id: 'c', source: 's', title: 't', excerpt: null },
    ],
    votes: { a: 'up', b: 'down' },
  }
  const r = (id: string, score: number, subtopic = 'release', reason = 'Compiler release ships') => ({ id, score, subtopic, reason })

  it('a clean ranking has no flags', () => {
    expect(rankerFlags([r('a', 80), r('b', 20), r('c', 40)], fixture)).toEqual([])
  })

  it('names what is missing, doubled, off-list and personal', () => {
    const flags = rankerFlags([r('a', 80), r('a', 70, 'drama'), r('b', 20, 'release', 'Your kind of article')], fixture)
    expect(flags).toEqual([
      '1 of 3 articles not scored: c',
      'scored more than once: a',
      'subtopic not in the beat\'s labels: "drama"',
      '1 reasons mention the reader, e.g. "Your kind of article"',
    ])
  })

  // Every string here is a reason a model wrote on the first live run.
  it('a mention of the reader is flagged; a subject containing the word is not', () => {
    for (const reason of [
      'Accessibility improvement for screen readers on timelines; narrow feature, low impact for this reader',
      'PR limits config change, not relevant to reader.',
      'Your kind of article',
    ]) {
      expect(mentionsReader(reason), reason).toBe(true)
    }
    for (const reason of [
      "Amazon's About You section critiqued for data collection; thin UX commentary.",
      'Screen reader timeline navigation improvement; accessibility-only change.',
      'GitHub timelines navigable as lists for screen readers; accessibility polish, no AI relevance.',
    ]) {
      expect(mentionsReader(reason), reason).toBe(false)
    }
  })

  it('agreement is the share of (up, down) pairs ordered the reader\'s way', () => {
    expect(voteAgreement([r('a', 80), r('b', 20)], fixture.votes)).toBe(1)
    expect(voteAgreement([r('a', 20), r('b', 20)], fixture.votes)).toBe(0.5)
    expect(voteAgreement([r('a', 80)], fixture.votes)).toBeNaN()
  })

  it('spread is the mean gap between one entrant\'s runs', () => {
    expect(scoreSpread([[r('a', 80), r('b', 20)], [r('a', 70), r('b', 20)]])).toBe(5)
  })
})
