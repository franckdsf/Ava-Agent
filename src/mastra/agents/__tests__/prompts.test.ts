import { describe, expect, it } from 'vitest'

import type { PendingArticle } from '../../../db/types.js'
import type { JobSearch, LeadSignal } from '../../../db/schema.js'
import { renderRankingPrompt } from '../curator.js'
import { renderJobBriefPrompt, renderJobScoringPrompt } from '../job-scorer.js'
import { renderLeadBriefPrompt, renderLeadVisionPrompt } from '../lead-scorer.js'

/**
 * These prompts were assembled inline in the workflow steps until the model bench needed to send
 * exactly what a run sends. Each expectation is the string the inline code produced, so a change
 * here is a change to what the model reads — deliberate, or a regression.
 */

const article = {
  id: 'a1',
  source: 'LWN',
  title: 'Rust 2.0 ships',
  excerpt: 'The edition lands.',
} as PendingArticle

const posting = {
  id: 'j1',
  title: 'Backend engineer',
  company: 'Acme',
  location: 'Paris',
  remote: 'hybrid',
  salaryText: null,
  contractType: 'CDI',
  description: 'Build things.',
}

const search = {
  label: 'Rust backend',
  request: 'rust backend in Paris',
  locations: ['Paris'],
  remote: 'any',
  seniority: [],
  contractTypes: ['CDI'],
  mustHave: ['rust'],
  dealbreakers: [],
  minCompensation: 60000,
  currency: 'EUR',
  notes: null,
} as unknown as JobSearch

describe('ranker prompt', () => {
  it('beat, rubric, labels, both profiles, then the batch', () => {
    const prompt = renderRankingPrompt({
      beat: { title: 'Rust', rubric: 'Language news.', subtopics: ['release', 'tooling'] },
      profile: 'No feedback recorded yet. Judge on the rubric alone.',
      reader: 'Nothing recorded yet. Judge on the rubric and the votes alone.',
      articles: [article],
    })
    expect(prompt).toBe(
      [
        '## Beat: Rust',
        '',
        '## Rubric',
        'Language news.',
        '',
        '## Subtopic labels (choose exactly one per article)',
        'release, tooling',
        '',
        '## Reader interest profile',
        'No feedback recorded yet. Judge on the rubric alone.',
        '',
        '## What is known about the reader',
        'Nothing recorded yet. Judge on the rubric and the votes alone.',
        '',
        '## Articles to score (1)',
        'id: a1\nsource: LWN\ntitle: Rust 2.0 ships\nexcerpt: The edition lands.',
      ].join('\n'),
    )
  })
})

describe('job prompts', () => {
  it('scoring: the CV once, the search once, then every posting', () => {
    expect(renderJobScoringPrompt('CV TEXT', search, [posting, { ...posting, id: 'j2' }])).toBe(
      [
        '## The person',
        'CV TEXT',
        '',
        '## What they are looking for right now',
        'title: Rust backend\nin their own words: rust backend in Paris\nlocations: Paris\nremote: any\n' +
          'seniority: no preference stated\ncontract: CDI\nmust involve: rust\nruled out: no preference stated\n' +
          'pay floor: 60,000 EUR',
        '',
        '## Postings to judge (2)',
        'id: j1\ntitle: Backend engineer\ncompany: Acme\nlocation: Paris (hybrid)\ncontract: CDI\ndescription: Build things.' +
          '\n\n---\n\n' +
          'id: j2\ntitle: Backend engineer\ncompany: Acme\nlocation: Paris (hybrid)\ncontract: CDI\ndescription: Build things.',
      ].join('\n'),
    )
  })

  it('brief: a null reason and null mismatches render as placeholders, not "null"', () => {
    expect(renderJobBriefPrompt(search, { fit: 82, reason: null, mismatches: null }, posting)).toBe(
      [
        'search: Rust backend',
        'fit: 82/100',
        'why it scored that: —',
        'mismatches found: none',
        '',
        'id: j1\ntitle: Backend engineer\ncompany: Acme\nlocation: Paris (hybrid)\ncontract: CDI\ndescription: Build things.',
      ].join('\n'),
    )
  })
})

describe('lead prompts', () => {
  const profile = { label: 'DTC brands', offer: 'product photography' }
  const lead = { company: 'Acme', url: 'https://acme.com', pageText: 'We make skincare.' }
  const signal = {
    kind: 'not-a-known-kind',
    summary: 'Launched a new line',
    occurredAt: Date.UTC(2026, 9, 1),
  } as unknown as LeadSignal

  it('vision: what they sell, the company, the instruction', () => {
    expect(renderLeadVisionPrompt(profile, lead)).toBe(
      'What this person sells: product photography\nThe company: Acme (https://acme.com)\n\n' +
        'Look at the images from their page and answer the schema.',
    )
  })

  it('brief: the visual line appears only when there is a verdict', () => {
    const verdict = { fit: 74, reason: '', mismatches: ['no budget stated'] }
    const without = renderLeadBriefPrompt(profile, verdict, signal, lead, null)
    expect(without).toBe(
      [
        'client profile: DTC brands',
        'what you sell: product photography',
        'fit: 74/100',
        'why it scored that: —',
        'mismatches found: no budget stated',
        'signal: not-a-known-kind — Launched a new line',
        'signal seen: 2026-10-01',
        '',
        'company: Acme',
        'site: https://acme.com',
        'their page says: We make skincare.',
      ].join('\n'),
    )
    expect(renderLeadBriefPrompt(profile, verdict, signal, lead, 'Studio shots.')).toBe(
      without.replace('signal seen: 2026-10-01\n', 'signal seen: 2026-10-01\nwhat their images look like: Studio shots.\n'),
    )
  })
})
