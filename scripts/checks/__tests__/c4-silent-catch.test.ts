import { afterEach, describe, expect, it } from 'vitest'

import { cleanupTrees, REPO_ROOT, runCheck } from './_harness.js'

afterEach(cleanupTrees)

it('rejects an empty catch block', () => {
  const { code, output } = runCheck('c4-silent-catch.mjs', {
    'src/x.ts': 'try {\n  run()\n} catch (error) {}',
  })
  expect(code).toBe(1)
  expect(output).toContain('src/x.ts:3')
})

it('accepts a catch that says why, in a comment', () => {
  const { code } = runCheck('c4-silent-catch.mjs', {
    'src/x.ts': 'try {\n  run()\n} catch {\n  // A failed notice must not fail the run.\n}',
  })
  expect(code).toBe(0)
})

it('does not read the rule written in a comment as a violation', () => {
  const { code } = runCheck('c4-silent-catch.mjs', { 'src/x.ts': '/** never `catch {}` */\nexport const x = 1' })
  expect(code).toBe(0)
})

it('rejects a swallowed promise in a file with no baseline', () => {
  const { code, output } = runCheck('c4-silent-catch.mjs', {
    'src/x.ts': 'await send(text).catch(() => {})\nawait send(text).catch(() => undefined)',
  })
  expect(code).toBe(1)
  expect(output).toContain('2 swallowed promise(s), baseline 0')
})

it('accepts a catch that logs', () => {
  const { code } = runCheck('c4-silent-catch.mjs', {
    'src/x.ts': "await send(text).catch(error => logger.warn('send failed', { error }))",
  })
  expect(code).toBe(0)
})

describe('the baseline ratchet', () => {
  const baseline = JSON.stringify({ 'src/x.ts': 2 })
  const swallow = 'send(a).catch(() => {})\n'

  it('accepts a baselined file at its count', () => {
    const { code } = runCheck('c4-silent-catch.mjs', {
      'scripts/checks/c4-baseline.json': baseline,
      'src/x.ts': swallow.repeat(2),
    })
    expect(code).toBe(0)
  })

  it('rejects one more than the baseline — a new swallow', () => {
    const { code, output } = runCheck('c4-silent-catch.mjs', {
      'scripts/checks/c4-baseline.json': baseline,
      'src/x.ts': swallow.repeat(3),
    })
    expect(code).toBe(1)
    expect(output).toContain('3 swallowed promise(s), baseline 2')
  })

  it('rejects one fewer until the entry is lowered — it only turns one way', () => {
    const { code, output } = runCheck('c4-silent-catch.mjs', {
      'scripts/checks/c4-baseline.json': baseline,
      'src/x.ts': swallow,
    })
    expect(code).toBe(1)
    expect(output).toContain('to 1.')
  })
})

it('passes on this repo', () => {
  expect(runCheck('c4-silent-catch.mjs', {}, REPO_ROOT).code).toBe(0)
})
