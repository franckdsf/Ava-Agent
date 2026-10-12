/**
 * Compares models for one pipeline agent, through the code path that runs in
 * production.
 *
 *     pnpm bench ranker
 *     pnpm bench ranker --models gemini,luna --runs 1
 *     pnpm bench ranker --fixtures 3 --refresh
 *
 * Nothing is stored and no message is sent: the bench calls the real function a
 * workflow calls and never the `save*` that follows it. Fixtures are read from
 * the database once and frozen under `.data/bench/fixtures/` so that two runs
 * a week apart compare models on the same inputs; `--refresh` re-reads them.
 *
 * See [the plan](../docs/plans/model-bench.md) for which tasks exist and why the
 * assistants and the scouts are not among them.
 */
// Type-only, so it is erased: the tokens below must be gone before anything that
// reads env is evaluated, which is why every real import is dynamic.
import type { BenchTask } from './bench/kit.js'

delete process.env.NEWY_TELEGRAM_BOT_TOKEN
delete process.env.JOOB_TELEGRAM_BOT_TOKEN

const { bench } = await import('../src/config/bench.js')
const { runBench } = await import('./bench/kit.js')
const { ranker } = await import('./bench/tasks/ranker.js')
const { jobScorer } = await import('./bench/tasks/job-scorer.js')
const { articleWriter } = await import('./bench/tasks/article-writer.js')
const { jobWriter } = await import('./bench/tasks/job-writer.js')
const { translator } = await import('./bench/tasks/translator.js')
const { summarizer } = await import('./bench/tasks/summarizer.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TASKS: Record<string, BenchTask<any, any>> = { ranker, 'article-writer': articleWriter, 'job-scorer': jobScorer, 'job-writer': jobWriter, translator, summarizer }

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const taskName = argv[0]
const task = taskName ? TASKS[taskName] : undefined
if (!task) {
  console.error(`Usage: pnpm bench <task> [--models a,b] [--runs N] [--fixtures N] [--refresh]\nTasks: ${Object.keys(TASKS).join(', ')}`)
  process.exit(1)
}

const result = await runBench(task, {
  models: (flag('models') ?? '').split(',').map(value => value.trim()).filter(Boolean),
  runs: Number(flag('runs') ?? bench.runs),
  fixtures: Number(flag('fixtures') ?? bench.fixtures),
  refresh: argv.includes('--refresh'),
})

// An empty field — a dead model id, a bad key — exits non-zero, so it is not
// mistaken for a field of bad models.
process.exit(result.ok === 0 ? 1 : 0)
