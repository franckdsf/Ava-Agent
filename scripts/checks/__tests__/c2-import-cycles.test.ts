import { afterEach, expect, it } from 'vitest'

import { cleanupTrees, REPO_ROOT, runCheck } from './_harness.js'

afterEach(cleanupTrees)

it('reports a cycle written with .js specifiers, once', () => {
  const { code, output } = runCheck('c2-import-cycles.mjs', {
    'src/a.ts': "import { b } from './b.js'\nexport const a = 1",
    'src/b.ts': "import { a } from './a.js'\nexport const b = 2",
  })
  expect(code).toBe(1)
  expect(output).toContain('1 violation(s)')
  expect(output).toMatch(/src\/(a|b)\.ts → src\/(a|b)\.ts → src\/(a|b)\.ts/)
})

it('ignores a type-only edge, which is erased before anything runs', () => {
  const { code } = runCheck('c2-import-cycles.mjs', {
    'src/a.ts': "import type { B } from './b.js'\nexport const a = 1",
    'src/b.ts': "import { a } from './a.js'\nexport type B = number",
  })
  expect(code).toBe(0)
})

it('does not let `export type X =` swallow the runtime import after it', () => {
  // No semicolons in this repo: a lazy match from `export type` once ran into the next line.
  const { code } = runCheck('c2-import-cycles.mjs', {
    'src/a.ts': "export type X = { n: number }\nimport { b } from './b.js'\nexport const a = b",
    'src/b.ts': "import { a } from './a.js'\nexport const b = 2",
  })
  expect(code).toBe(1)
})

it('follows a multi-line import and a side-effect import', () => {
  const { code } = runCheck('c2-import-cycles.mjs', {
    'src/a.ts': "import {\n  b,\n} from './b.js'\nexport const a = 1",
    'src/b.ts': "import './a.js'\nexport const b = 2",
  })
  expect(code).toBe(1)
})

it('ignores an import written in a comment', () => {
  const { code } = runCheck('c2-import-cycles.mjs', {
    'src/a.ts': "// import { b } from './b.js'\nexport const a = 1",
    'src/b.ts': "import { a } from './a.js'\nexport const b = 2",
  })
  expect(code).toBe(0)
})

it('passes on this repo', () => {
  expect(runCheck('c2-import-cycles.mjs', {}, REPO_ROOT).code).toBe(0)
})
