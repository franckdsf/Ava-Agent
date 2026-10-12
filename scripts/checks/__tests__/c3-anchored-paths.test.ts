import { afterEach, expect, it } from 'vitest'

import { cleanupTrees, REPO_ROOT, runCheck } from './_harness.js'

afterEach(cleanupTrees)

it('rejects process.cwd() outside project-root.ts', () => {
  const { code, output } = runCheck('c3-anchored-paths.mjs', {
    'src/services/x.ts': "const dir = process.cwd()",
  })
  expect(code).toBe(1)
  expect(output).toContain('src/services/x.ts:1')
})

it('allows process.cwd() in project-root.ts, which is the affordance', () => {
  const { code } = runCheck('c3-anchored-paths.mjs', {
    'src/lib/project-root.ts': "export const projectRoot = () => process.cwd()",
  })
  expect(code).toBe(0)
})

it('rejects an fs call on a relative literal, and allows an absolute one', () => {
  const relative = runCheck('c3-anchored-paths.mjs', {
    'src/services/x.ts': "readFileSync('.data/cv.md', 'utf8')",
  })
  expect(relative.code).toBe(1)
  expect(relative.output).toContain('readFileSync(".data/cv.md")')

  const absolute = runCheck('c3-anchored-paths.mjs', {
    'src/services/x.ts': "readFileSync('/data/cv.md', 'utf8')\nreadFileSync(resolveFromRoot('.data/cv.md'))",
  })
  expect(absolute.code).toBe(0)
})

it('ignores the rule written in a comment', () => {
  const { code } = runCheck('c3-anchored-paths.mjs', {
    'src/services/x.ts': '/** never call process.cwd() here */\nexport const x = 1',
  })
  expect(code).toBe(0)
})

it('does not check scripts/, which pnpm runs from the root', () => {
  const { code } = runCheck('c3-anchored-paths.mjs', { 'scripts/x.ts': 'process.cwd()' })
  expect(code).toBe(0)
})

it('passes on this repo', () => {
  expect(runCheck('c3-anchored-paths.mjs', {}, REPO_ROOT).code).toBe(0)
})
