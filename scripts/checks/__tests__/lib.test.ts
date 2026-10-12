/**
 * The stripper every check reads source through. If it desyncs, a check stops seeing code and
 * reports the file clean — so each case here is a shape that once desynced it, in this repo.
 */
import { describe, expect, it } from 'vitest'

// @ts-expect-error — a plain .mjs module with no declaration file; its shape is asserted below.
import { stripCommentsAndStrings } from '../_lib.mjs'

const strip = (text: string, options?: object): string => stripCommentsAndStrings(text, options)

describe('stripCommentsAndStrings', () => {
  it('keeps length and line count, so offsets point at the original', () => {
    const source = "const a = 'x' // note\n/* block\n */ const b = `t ${a}`\n"
    for (const options of [{}, { keepStrings: true }, { keepComments: true }]) {
      const out = strip(source, options)
      expect(out.length).toBe(source.length)
      expect(out.split('\n').length).toBe(source.split('\n').length)
    }
  })

  it('blanks comments and string bodies, and keeps the code', () => {
    const out = strip("process.cwd() // process.cwd()\nconst s = 'process.cwd()'")
    expect(out.match(/process\.cwd/g)).toHaveLength(1)
  })

  it('keeps string bodies with keepStrings, for import specifiers', () => {
    expect(strip("import x from './x.js' // './y.js'", { keepStrings: true })).toContain("'./x.js'")
    expect(strip("import x from './x.js' // './y.js'", { keepStrings: true })).not.toContain('./y.js')
  })

  it('keeps comments with keepComments, for a catch that says why', () => {
    expect(strip("catch { /* why */ } 'str'", { keepComments: true })).toContain('/* why */')
  })

  it('does not open a template on a backtick inside a regex literal', () => {
    // src/services/telegram.ts — this once blanked the next two hundred lines.
    const out = strip("const r = text.replace(/[\\\\`*_]/g, '')\nprocess.cwd()")
    expect(out).toContain('process.cwd()')
  })

  it('reads a slash after an expression as division, not a regex', () => {
    const out = strip("const half = total / 2; const s = 'x / y'\nprocess.cwd()")
    expect(out).toContain('/ 2')
    expect(out).toContain('process.cwd()')
  })

  it('scans ${} as code, nested templates included', () => {
    // src/mastra/commands/beats.ts — a template inside ${} once closed the outer one early.
    const source = 'const s = `a ${xs.map(x => `\\`${x}\\``).join(", ")} b`\nprocess.cwd()'
    const out = strip(source)
    expect(out).toContain('xs.map')
    expect(out).toContain('process.cwd()')
    expect(out).not.toContain(' a ')
  })

  it('tells an object literal inside ${} from the end of the expression', () => {
    const out = strip('const s = `${f({ a: 1 })} tail`\nprocess.cwd()')
    expect(out).toContain('f({ a: 1 })')
    expect(out).not.toContain('tail')
    expect(out).toContain('process.cwd()')
  })
})
