import { describe, expect, it } from 'vitest'

import { leakedStructure, withRetry } from '../structured-output.js'

const keys = ['summary', 'fits', 'watchOuts']

describe('leakedStructure', () => {
  // Both from `pnpm bench job-writer`, 2026-10-12: the fits array as gpt-5.6-luna returned it.
  it('catches the two leaks measured live', () => {
    expect(
      leakedStructure(['The video focus matches your Remotion and video experience.],', 'watchOuts'], keys),
    ).toMatch(/JSON punctuation/)
    expect(leakedStructure(['The platform includes AWS and Terraform.', 'watchOutsる=['], keys)).toMatch(
      /schema key "watchOuts"/,
    )
    expect(leakedStructure(['"fits": ["React"'], keys)).toMatch(/schema key "fits"/)
  })

  it('passes prose that merely uses a key as a word', () => {
    expect(
      leakedStructure(
        [
          'In summary: a React role at a fintech.',
          'It fits your stack: React and TypeScript.',
          'Supports images (PNG, JPG).',
          'Ships formats like [PNG, JPG] today.',
        ],
        keys,
      ),
    ).toBeNull()
  })
})

describe('withRetry with a rejection', () => {
  it('retries a rejected answer and returns the next good one', async () => {
    const answers = [{ object: { text: 'bad],' } }, { object: { text: 'good' } }]
    const failures: unknown[] = []
    const result = await withRetry<{ text: string }>(
      2,
      async () => answers.shift() ?? {},
      (_, error) => failures.push(error),
      object => leakedStructure([object.text], ['text']),
    )
    expect(result).toEqual({ text: 'good' })
    expect(String(failures[0])).toMatch(/JSON punctuation/)
  })

  it('returns null when every answer is rejected, so the caller degrades', async () => {
    expect(
      await withRetry<{ text: string }>(
        2,
        async () => ({ object: { text: 'bad]' } }),
        undefined,
        object => leakedStructure([object.text], ['text']),
      ),
    ).toBeNull()
  })
})
