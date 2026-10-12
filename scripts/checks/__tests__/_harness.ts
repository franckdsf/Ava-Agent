/**
 * Running a check script against a tree that is not this repo.
 *
 * Every check test needs the same three things: a throwaway tree holding exactly the shapes under
 * test, the real script run against it, and the exit code plus what it printed. The scripts end in
 * `process.exit`, so there is nothing to import and assert on — the exit code and the finding text
 * are the whole contract. `CHECK_ROOT` is what aims them (see `scripts/checks/_lib.mjs`).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = fileURLToPath(new URL('..', import.meta.url))

/** Relative POSIX path → file contents. Directories are created as needed. */
export type Tree = Record<string, string>

const roots: string[] = []

export const makeTree = (tree: Tree): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'ava-check-'))
  roots.push(root)

  for (const [relative, contents] of Object.entries(tree)) {
    const file = path.join(root, ...relative.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }

  return root
}

/** Removes every tree made so far. Call it from `afterEach`. */
export const cleanupTrees = () => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
}

export type CheckResult = { code: number; output: string }

/**
 * Runs `script` (a bare filename in `scripts/checks/`) against `tree`, or against `at` when given —
 * this repo, in practice, for the test that the repo itself is clean.
 *
 * A crash and a violation both exit 1, and telling them apart is not optional: a check that throws
 * on its input "fails" every test asserting only the exit code, and so passes every test asserting a
 * violation. Every finding prints a ❌ banner; anything that exits non-zero without one is thrown.
 */
export const runCheck = (script: string, tree: Tree, at?: string): CheckResult => {
  const root = at ?? makeTree(tree)

  try {
    const stdout = execFileSync(process.execPath, [path.join(SCRIPTS, script)], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output: stdout }
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string }
    const output = `${failure.stdout}${failure.stderr}`
    if (!output.includes('❌')) throw new Error(`${script} crashed instead of reporting findings:\n${output}`)
    return { code: failure.status, output }
  }
}

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
