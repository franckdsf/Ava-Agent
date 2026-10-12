import { defineConfig } from 'vitest/config'

/**
 * One project, plain Node — the runtime everything here runs on.
 *
 * Tests live in a `__tests__/` folder beside their subject, and nowhere else: given a file there is
 * exactly one place its test can be, so nobody needs an opinion about it. Anything that reaches a
 * real service — a feed, a model, Telegram — is a `pnpm <thing>:check` script, not a test; a test
 * here runs offline, on every commit, and costs nothing.
 *
 * `*.manual.test.ts` is excluded so a hand-run test can sit beside its subject without being billed
 * on every commit.
 *
 * `vitest.setup.ts` gives every test file a placeholder model key and its own empty database.
 */
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/**/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.history/**', '**/.mastra/**', '**/.claude/worktrees/**', '**/*.manual.test.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
})
