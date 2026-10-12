import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

// @ts-expect-error — a plain .mjs module with no declaration file.
import { problemsIn } from '../commit-message.mjs'

const check = (message: string): string[] => problemsIn(message)

describe('the title', () => {
  it('accepts every prefix in use', () => {
    for (const type of ['feat', 'fix', 'hotfix', 'clean']) {
      expect(check(`(${type}) beats — something changed\n\nWhy it changed.`)).toEqual([])
    }
  })

  it('rejects the conventional-commits spelling and a missing prefix', () => {
    expect(check('feat: add a beat')).toHaveLength(1)
    expect(check('feat(beats): add a beat')).toHaveLength(1)
    expect(check('add a beat')).toHaveLength(1)
    expect(check('(chore) bump deps')).toHaveLength(1)
  })

  it("leaves git's own wording alone", () => {
    expect(check("Merge branch 'main' into fix/x")).toEqual([])
    expect(check('Revert "(feat) beats — x"')).toEqual([])
    expect(check('fixup! (fix) jobs — y')).toEqual([])
  })

  it('ignores the comment lines git strips', () => {
    expect(check('# Please enter the commit message\n(fix) jobs — y\n# On branch main')).toEqual([])
  })
})

describe('AI attribution', () => {
  it('rejects a co-author trailer and a generated-with footer', () => {
    expect(check('(fix) x — y\n\nBody.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>')).toHaveLength(1)
    expect(check('(fix) x — y\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)')).toHaveLength(1)
  })

  it('accepts a human co-author', () => {
    expect(check('(fix) x — y\n\nCo-Authored-By: Someone <someone@example.com>')).toEqual([])
  })
})

it('accepts every title in this repo before the hook existed, bar one typo', () => {
  // The rule was written from the history, not the other way round — so the history must pass it.
  // The one title that does not is a stray character, which the hook would have refused.
  const KNOWN_TYPO = '@ (feat) translation — gemini-3.1-flash-lite for the translator'
  const titles = execFileSync('git', ['log', '--no-merges', '--format=%s'], { encoding: 'utf8' })
    .trim()
    .split('\n')
  const refused = titles.filter((title) => check(title).length > 0)
  expect(refused).toEqual([KNOWN_TYPO])
})
