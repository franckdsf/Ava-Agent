/**
 * The bench: one task, a field of models × efforts, the real call path, a blind
 * judge, a table and a transcript.
 *
 * A task file says what is being chosen — which agent, which function, which
 * inputs, what code can prove wrong with an answer, what a judge should weigh.
 * Everything about *how a comparison is run* lives here, so every table in the
 * repo is produced the same way and reads the same way.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { bench } from '../../src/config/bench.js'
import { env } from '../../src/config/env.js'
import { clone, reportedCost, type Call, type Candidate, type Effort } from './clone.js'

export type ModelKnob = Extract<keyof typeof env, `AVA_MODEL_${string}`>

export interface BenchTask<Fixture, Output> {
  /** The name on the command line: `pnpm bench <title>`. */
  title: string
  /** The env knob this task re-decides. Its current value is the incumbent, always in the field. */
  knob: ModelKnob
  /** The id the real function resolves with `mastra.getAgent`. */
  agentId: string
  /** The real agent, cloned once per entrant. */
  agent: Agent
  /** The field. Edit this list; the incumbent at `'shipped'` is added if it is missing. */
  field: readonly Candidate[]
  /** Read from the database. Frozen to `.data/bench/fixtures/<title>.json` by the kit, not here. */
  fixtures(count: number): Promise<Fixture[]>
  /** One line naming a fixture, for progress lines and the transcript. */
  describe(fixture: Fixture): string
  /** The real function. `null` is a failed run, as `withRetry` exhausting its attempts is in production. */
  call(mastra: Mastra, fixture: Fixture): Promise<Output | null>
  /** Everything wrong that code can prove, one readable string per defect. */
  check?(output: Output, fixture: Fixture): string[]
  /** Numbers per run, averaged per entrant. `NaN` means "not measurable on this fixture" and is skipped. */
  metrics?(output: Output, fixture: Fixture): Record<string, number>
  /** Numbers across one entrant's runs on one fixture — run-to-run stability. */
  across?(outputs: Output[], fixture: Fixture): Record<string, number>
  /** What the candidates were given, rendered for the judge. */
  judgeInput(fixture: Fixture): string
  /** One run's answer for the judge. Defaults to JSON. */
  renderOutput?(output: Output, fixture: Fixture): string
  /** How to weigh the answers, heaviest first, specific enough that a verdict can cite a line. */
  criteria: readonly string[]
  /** Said under the table, once — what this task's numbers do not measure. */
  caveats?(fixtures: Fixture[]): string[]
}

export interface Entrant {
  model: string
  effort: Effort
}

export interface BenchOptions {
  /** Substrings of model ids to keep; the incumbent is kept whatever they say. */
  models: string[]
  runs: number
  fixtures: number
  refresh: boolean
}

export interface BenchResult {
  ok: number
  clean: number
  total: number
  spent: number
  transcript: string
}

export const effortLabel = (effort: Effort): string =>
  effort === false ? 'off' : typeof effort === 'number' ? `${effort}tok` : effort

export const entrantKey = (entrant: Entrant): string =>
  `${entrant.model.replace(/^openrouter\//, '')} @ ${effortLabel(entrant.effort)}`

/**
 * The field as entrants, the incumbent first.
 *
 * The incumbent is entered at `'shipped'` whatever the filter says: it is the
 * only baseline that shares this run's routing luck, and a table that cannot
 * compare against it measures the pool's mood, not a model.
 */
export function entrantsFor(field: readonly Candidate[], incumbent: string, filters: string[]): Entrant[] {
  const chosen = filters.length ? field.filter(c => filters.some(filter => c.model.includes(filter))) : field
  const list: Entrant[] = [
    { model: incumbent, effort: 'shipped' },
    ...chosen.flatMap(candidate => candidate.efforts.map(effort => ({ model: candidate.model, effort }))),
  ]
  const seen = new Set<string>()
  return list.filter(entrant => {
    const key = entrantKey(entrant)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Letters assigned after a shuffle, so the judge's positional bias — every
 * judge has one — lands on a random entrant rather than always on the
 * incumbent, which is first in the field.
 */
export function blind<T>(items: readonly T[], random: () => number = Math.random): { label: string; item: T }[] {
  const shuffled = [...items]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j] as T, shuffled[i] as T]
  }
  return shuffled.map((item, index) => ({ label: labelAt(index), item }))
}

/** A, B, … Z, AA, AB — a field over 26 entrants is unlikely, not impossible. */
function labelAt(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26))
  return index < 26 ? letter : labelAt(Math.floor(index / 26) - 1) + letter
}

/**
 * Every item through `work`, at most `limit` at a time, results in input order.
 * `onDone` fires as each lands, which is what puts progress lines on screen
 * during a ten-minute run rather than after it.
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
  onDone?: (result: R, item: T) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      const item = items[index] as T
      results[index] = await work(item)
      onDone?.(results[index] as R, item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

/** One run of one entrant on one fixture. */
export interface Attempt<Output = unknown> {
  key: string
  fixture: number
  run: number
  ms: number
  calls: Call[]
  output: Output | null
  error?: string
  flags: string[]
  metrics: Record<string, number>
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? NaN
}

/** The mean of the finite values; `NaN` when there are none, which the table prints as "—". */
export const mean = (values: number[]): number => {
  const finite = values.filter(Number.isFinite)
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN
}

/**
 * What one run cost: the sum over its calls, retries included. `undefined` when
 * no call reported a cost — a different fact from "free", and printed as one.
 */
export function attemptCost(calls: Call[]): number | undefined {
  const reported = calls.map(call => call.cost).filter((cost): cost is number => cost !== undefined)
  return reported.length ? reported.reduce((a, b) => a + b, 0) : undefined
}

/**
 * The ids a batch answer left out or answered twice — the failure every
 * one-call-per-batch scorer shares. In production the missed ones stay
 * unscored and the doubled one is written twice, so both are flags, not notes.
 */
export function coverageFlags(expected: string[], returned: string[], noun: string): string[] {
  const seen = new Map<string, number>()
  for (const id of returned) seen.set(id, (seen.get(id) ?? 0) + 1)
  const flags: string[] = []
  const missing = expected.filter(id => !seen.has(id))
  if (missing.length) flags.push(`${missing.length} of ${expected.length} ${noun} not scored: ${missing.slice(0, 5).join(', ')}`)
  const twice = [...seen].filter(([, n]) => n > 1).map(([id]) => id)
  if (twice.length) flags.push(`scored more than once: ${twice.slice(0, 5).join(', ')}`)
  return flags
}

/**
 * How far an entrant disagrees with itself: for each item, the gap between its
 * highest and lowest score across runs, averaged. A scorer whose verdict on the
 * same input swings by 13 points sends an item on one run and drops it on the
 * next — the judge sees that only as anecdotes, this column sees all of it.
 */
export function scoreSpread(runs: { id: string; score: number }[][]): number {
  const byId = new Map<string, number[]>()
  for (const run of runs) for (const r of run) byId.set(r.id, [...(byId.get(r.id) ?? []), r.score])
  const gaps = [...byId.values()].filter(scores => scores.length > 1).map(s => Math.max(...s) - Math.min(...s))
  return gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : NaN
}

/** Spearman's rank correlation, ties averaged. `NaN` under three pairs or with no variance on either side. */
export function spearman(pairs: [number, number][]): number {
  if (pairs.length < 3) return NaN
  const ranks = (values: number[]): number[] => {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
    const out = new Array<number>(values.length)
    for (let i = 0; i < order.length; ) {
      let j = i
      while (j + 1 < order.length && order[j + 1]?.[0] === order[i]?.[0]) j += 1
      for (let k = i; k <= j; k += 1) out[order[k]?.[1] as number] = (i + j) / 2
      i = j + 1
    }
    return out
  }
  const a = ranks(pairs.map(p => p[0]))
  const b = ranks(pairs.map(p => p[1]))
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = (a[i] as number) - ma
    const y = (b[i] as number) - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da && db ? num / Math.sqrt(da * db) : NaN
}

const verdictSchema = z.object({
  rows: z
    .array(
      z.object({
        label: z.string().describe('The letter of the candidate — "A", "B", …'),
        rank: z.number().describe('1 is best. No ties: break them on whichever you would ship.'),
        score: z.number().describe('Out of 10. Absolute quality, so two bad candidates both score low.'),
        note: z
          .string()
          .describe(
            'One or two SPECIFIC sentences: name the rule broken and quote the line that broke it. ' +
              'Never "good structure" or "followed the prompt".',
          ),
      }),
    )
    .describe('One row per candidate letter, best first. Every letter gets a row.'),
  verdict: z
    .string()
    .describe('Two or three sentences: which to ship and the single most important reason — or that none is good enough.'),
})

export type Verdict = z.infer<typeof verdictSchema>

/** The rules every candidate was given — the real agent's instructions, whatever shape Mastra holds them in. */
export function instructionsText(instructions: unknown): string {
  if (typeof instructions === 'string') return instructions
  if (Array.isArray(instructions)) return instructions.map(instructionsText).join('\n\n')
  const content = (instructions as { content?: unknown } | null)?.content
  return typeof content === 'string' ? content : JSON.stringify(instructions)
}

/**
 * Everything the judge sees for one fixture, in one prompt.
 *
 * The paragraph about efforts is not politeness: without it a judge that spots
 * two near-identical answers concludes one copied the other, rather than that
 * they are one model at two settings.
 */
export function judgePrompt<Output>(input: {
  rules: string
  given: string
  criteria: readonly string[]
  runs: number
  candidates: { label: string; attempts: Attempt<Output>[] }[]
  render: (output: Output) => string
}): string {
  const flagged = input.candidates.some(c => c.attempts.some(a => a.output !== null && a.flags.length))
  const run = (label: string, attempt: Attempt<Output>, index: number): string =>
    attempt.output === null
      ? `### ${label}, run ${index + 1} — FAILED after ${(attempt.ms / 1000).toFixed(1)}s\n${attempt.error ?? ''}`
      : [
          `### ${label}, run ${index + 1}`,
          input.render(attempt.output),
          ...(attempt.flags.length ? ['Automated checks flagged this run:', ...attempt.flags.map(f => `- ${f}`)] : []),
        ].join('\n')

  return [
    `${input.candidates.length} candidates were given the same input and the same rules. Rank them.`,
    '',
    'Some candidates may be the same underlying model at a different reasoning setting, which is why ' +
      'two can read almost identically. You are not told which, and must not guess: judge only what is ' +
      'in front of you.',
    '',
    '# The rules they were given',
    '',
    input.rules,
    '',
    '# What they were given to work from',
    '',
    input.given,
    '',
    '# What each candidate returned',
    '',
    ...input.candidates.map(c => [`## Candidate ${c.label}`, ...c.attempts.map((a, i) => run(c.label, a, i))].join('\n\n')),
    '',
    '# How to weigh them',
    '',
    'In this order, heaviest first:',
    ...[...input.criteria, `Consistency across the ${input.runs} runs.`].map((c, i) => `${i + 1}. ${c}`),
    '',
    'A failed run counts against its candidate as heavily as a bad one — the pipeline cannot ship a ' +
      'model that throws.',
    // Only when there is something flagged: a paragraph about evidence that does
    // not exist invites the judge to go looking for it and invent some.
    ...(flagged
      ? [
          '',
          'Runs marked as flagged by automated checks were verified by code before you saw them. Those ' +
            'findings are facts: weigh them as hard evidence, do not argue with them, and do not credit a ' +
            'candidate for something a check has already contradicted.',
        ]
      : []),
  ].join('\n')
}

async function runJudge(prompt: string): Promise<{ verdict: Verdict | null; cost: number | undefined; error?: string }> {
  const judge = new Agent({
    id: 'bench-judge',
    name: 'Bench judge',
    model: bench.judge,
    instructions:
      'You are ranking model outputs. You are strict, you quote the line you object to, and you never ' +
      'praise a candidate for something every candidate did.',
    defaultOptions: {
      providerOptions: {
        openrouter: { reasoning: { enabled: true, effort: 'high' }, provider: { sort: 'price' }, usage: { include: true } },
      },
    },
  })
  const mastra = new Mastra({ agents: { judge }, logger: false })
  try {
    const response = await mastra.getAgent('judge').generate(prompt, {
      structuredOutput: { schema: verdictSchema },
      abortSignal: AbortSignal.timeout(bench.judgeTimeoutMs),
    })
    return { verdict: response.object ?? null, cost: reportedCost(response.providerMetadata) }
  } catch (error) {
    return { verdict: null, cost: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Entrants asked to reason that came back with none.
 *
 * Price routing found this on its first run: claude-haiku-5.5 at `low` reported
 * 0 reasoning tokens where it had reported ~1.5k on default routing — the
 * cheapest endpoint dropped the setting without an error. `require_parameters`
 * is meant to prevent that; this is how a table says so when it did not.
 */
export function droppedEffort(entrants: Entrant[], rows: Pick<Row, 'key' | 'ok' | 'reasoning'>[]): string[] {
  return entrants
    .filter(e => e.effort !== false && e.effort !== 'shipped')
    .map(entrantKey)
    .filter(key => {
      const row = rows.find(r => r.key === key)
      return row !== undefined && row.ok > 0 && row.reasoning === 0
    })
}

/** One entrant's line in the table. */
export interface Row {
  label: string
  key: string
  incumbent: boolean
  ok: number
  clean: number
  total: number
  medianMs: number
  costPerRun: number | undefined
  reasoning: number
  retries: number
  metrics: Record<string, number>
  rank: number
  score: number
}

const fixed = (value: number, digits: number): string => (Number.isFinite(value) ? value.toFixed(digits) : '—')

/**
 * The table, best judged first.
 *
 * Sorted by the judge's mean rank and then by clean runs, so a field whose judge
 * failed still comes out ordered by what code could prove.
 */
export function renderTable(rows: Row[]): string {
  const metricKeys = [...new Set(rows.flatMap(row => Object.keys(row.metrics)))]
  const sorted = [...rows].sort(
    (a, b) => (Number.isFinite(a.rank) ? a.rank : Infinity) - (Number.isFinite(b.rank) ? b.rank : Infinity) || b.clean - a.clean,
  )
  const header = ['', 'entrant', 'ok', 'clean', 'median', '$/run', 'reason tok', 'retries', 'judge rank', 'judge /10', ...metricKeys]
  const lines = sorted.map(row => [
    row.label,
    `${row.key}${row.incumbent ? ' *' : ''}`,
    `${row.ok}/${row.total}`,
    `${row.clean}/${row.total}`,
    Number.isFinite(row.medianMs) ? `${(row.medianMs / 1000).toFixed(1)}s` : '—',
    row.costPerRun === undefined ? 'n/a' : `$${row.costPerRun.toFixed(5)}`,
    fixed(row.reasoning, 0),
    String(row.retries),
    fixed(row.rank, 1),
    fixed(row.score, 1),
    ...metricKeys.map(key => fixed(row.metrics[key] ?? NaN, 2)),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map(line => (line[i] ?? '').length)))
  const format = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd()
  return [format(header), ...lines.map(format), '', '* the incumbent, at the effort production sends'].join('\n')
}

async function frozenFixtures<Fixture>(task: BenchTask<Fixture, unknown>, count: number, refresh: boolean): Promise<Fixture[]> {
  const path = join('.data', 'bench', 'fixtures', `${task.title}.json`)
  if (!refresh) {
    try {
      const saved = JSON.parse(await readFile(path, 'utf8')) as Fixture[]
      // More than asked for is fine — the same first N stay comparable across
      // runs. Fewer is not, and is re-read rather than silently short.
      if (saved.length >= count) return saved.slice(0, count)
    } catch {
      // No frozen file yet: read the database below.
    }
  }
  const fresh = await task.fixtures(count)
  await mkdir(join('.data', 'bench', 'fixtures'), { recursive: true })
  await writeFile(path, JSON.stringify(fresh, null, 2), 'utf8')
  return fresh
}

export async function runBench<Fixture, Output>(task: BenchTask<Fixture, Output>, options: BenchOptions): Promise<BenchResult> {
  const incumbent = env[task.knob]
  const fixtures = await frozenFixtures(task, options.fixtures, options.refresh)
  if (fixtures.length === 0) throw new Error(`${task.title}: the database has nothing to build a fixture from.`)

  const entrants = blind(entrantsFor(task.field, incumbent, options.models))
  const jobs = entrants.flatMap(({ label, item }) =>
    fixtures.flatMap((fixture, f) => Array.from({ length: options.runs }, (_, run) => ({ label, entrant: item, fixture, f, run }))),
  )

  console.log(`${task.title} — ${task.knob} = ${incumbent}`)
  for (const [f, fixture] of fixtures.entries()) console.log(`  fixture ${f + 1}: ${task.describe(fixture)}`)
  console.log(
    `\n${entrants.length} entrants × ${fixtures.length} fixtures × ${options.runs} runs = ${jobs.length} calls ` +
      `(${bench.concurrency} in flight, ${bench.timeoutMs / 1000}s each), then ${fixtures.length} judge calls to ${bench.judge}\n`,
  )

  const started = performance.now()
  const attempts = await pool(
    jobs,
    bench.concurrency,
    async (job): Promise<Attempt<Output>> => {
      const key = entrantKey(job.entrant)
      const { mastra, measured } = await clone(task.agent, task.agentId, job.entrant.model, job.entrant.effort)
      measured.signal = AbortSignal.timeout(bench.timeoutMs)
      const t0 = performance.now()
      let output: Output | null = null
      let error: string | undefined
      try {
        output = await task.call(mastra, job.fixture)
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown)
      }
      const ms = performance.now() - t0
      if (output === null) error ??= measured.calls.at(-1)?.error ?? 'every attempt returned nothing usable'
      // A check or metric that throws is the task's bug, not the model's — loud, not a quiet clean row.
      const flags = output === null ? [] : (task.check?.(output, job.fixture) ?? [])
      const metrics = output === null ? {} : (task.metrics?.(output, job.fixture) ?? {})
      return { key, fixture: job.f, run: job.run, ms, calls: measured.calls, output, error, flags, metrics }
    },
    (attempt, job) => {
      const cost = attemptCost(attempt.calls)
      console.log(
        `  ${`+${((performance.now() - started) / 1000).toFixed(0)}s`.padStart(6)}  ${job.label} ${attempt.key} · ` +
          `fixture ${attempt.fixture + 1} · run ${attempt.run + 1} … ` +
          (attempt.output === null
            ? `FAILED after ${(attempt.ms / 1000).toFixed(1)}s — ${attempt.error}`
            : `${(attempt.ms / 1000).toFixed(1)}s · ${cost === undefined ? 'cost n/a' : `$${cost.toFixed(5)}`}` +
              `${attempt.calls.some(c => c.error) ? ` · ${attempt.calls.filter(c => c.error).length} failed calls retried` : ''}` +
              `${attempt.flags.length ? ` · ${attempt.flags.length} flags` : ''}`),
      )
    },
  )

  console.log(`\nJudging ${fixtures.length} fixture(s)…`)
  const rules = instructionsText(await task.agent.getInstructions())
  const render = (fixture: Fixture) => (output: Output) =>
    task.renderOutput ? task.renderOutput(output, fixture) : JSON.stringify(output, null, 2)
  const judged = await Promise.all(
    fixtures.map(async (fixture, f) => {
      const candidates = entrants.map(({ label, item }) => ({
        label,
        attempts: attempts.filter(a => a.fixture === f && a.key === entrantKey(item)),
      }))
      return runJudge(
        judgePrompt({ rules, given: task.judgeInput(fixture), criteria: task.criteria, runs: options.runs, candidates, render: render(fixture) }),
      )
    }),
  )

  const rows: Row[] = entrants.map(({ label, item }) => {
    const key = entrantKey(item)
    const mine = attempts.filter(a => a.key === key)
    const ok = mine.filter(a => a.output !== null)
    const costs = mine.map(a => attemptCost(a.calls))
    const metricKeys = [...new Set(ok.flatMap(a => Object.keys(a.metrics)))]
    const across = fixtures.map((fixture, f) => {
      const outputs = ok.filter(a => a.fixture === f).map(a => a.output as Output)
      return outputs.length > 1 ? (task.across?.(outputs, fixture) ?? {}) : {}
    })
    const acrossKeys = [...new Set(across.flatMap(Object.keys))]
    const verdictRows = judged.map(j => j.verdict?.rows.find(row => row.label === label))
    return {
      label,
      key,
      incumbent: item.model === incumbent && item.effort === 'shipped',
      ok: ok.length,
      clean: ok.filter(a => a.flags.length === 0).length,
      total: mine.length,
      medianMs: median(ok.map(a => a.ms)),
      costPerRun: costs.some(c => c !== undefined) ? mean(costs.map(c => c ?? NaN)) : undefined,
      reasoning: mean(ok.map(a => a.calls.reduce((sum, call) => sum + call.reasoningTokens, 0))),
      // Failed calls, not extra calls: a task whose run makes several calls on
      // purpose (one per article) would otherwise count each as a retry.
      retries: mine.reduce((sum, a) => sum + a.calls.filter(call => call.error).length, 0),
      metrics: Object.fromEntries([
        ...metricKeys.map(k => [k, mean(ok.map(a => a.metrics[k] ?? NaN))] as const),
        ...acrossKeys.map(k => [k, mean(across.map(m => m[k] ?? NaN))] as const),
      ]),
      rank: mean(verdictRows.map(row => row?.rank ?? NaN)),
      score: mean(verdictRows.map(row => row?.score ?? NaN)),
    }
  })

  const spent =
    attempts.reduce((sum, a) => sum + (attemptCost(a.calls) ?? 0), 0) + judged.reduce((sum, j) => sum + (j.cost ?? 0), 0)
  const table = renderTable(rows)

  // A winner only when the fixtures agree on one. Different firsts on different
  // inputs is the task sitting inside its noise floor, and the table says so
  // rather than crowning whoever the mean happens to favour.
  const firsts = judged.map(j => j.verdict?.rows.find(row => row.rank === 1)?.label).filter(Boolean)
  const agreed = firsts.length === fixtures.length && new Set(firsts).size === 1
  const caveats = [
    ...(judged.some(j => !j.verdict) ? [`The judge failed on ${judged.filter(j => !j.verdict).length} fixture(s): ${judged.map(j => j.error).filter(Boolean).join(' · ')}`] : []),
    agreed
      ? `The judge put ${firsts[0]} first on every fixture.`
      : `No winner: the judge's first place differs across fixtures (${firsts.join(', ') || 'none'}) — inside the noise floor.`,
    ...droppedEffort(entrants.map(({ item }) => item), rows).map(
      key =>
        `${key} used no reasoning tokens: the endpoint ignored the effort, so that row measured reasoning off.`,
    ),
    ...(task.caveats?.(fixtures) ?? []),
  ]

  console.log(`\n${table}\n`)
  for (const caveat of caveats) console.log(`- ${caveat}`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const transcript = join('.data', 'bench', 'runs', `${task.title}_${stamp}.md`)
  await mkdir(join('.data', 'bench', 'runs'), { recursive: true })
  await writeFile(
    transcript,
    renderTranscript({ task, incumbent, fixtures, entrants, attempts, judged, table, caveats, render }),
    'utf8',
  )

  const ok = attempts.filter(a => a.output !== null)
  console.log(`\nSpent $${spent.toFixed(4)} · ${ok.length}/${attempts.length} ok · transcript: ${transcript}`)
  return { ok: ok.length, clean: ok.filter(a => a.flags.length === 0).length, total: attempts.length, spent, transcript }
}

/**
 * Every answer, every flag and the judge's notes, in one file — the table
 * narrows the field and this is what a human reads before changing a knob.
 */
function renderTranscript<Fixture, Output>(input: {
  task: BenchTask<Fixture, Output>
  incumbent: string
  fixtures: Fixture[]
  entrants: { label: string; item: Entrant }[]
  attempts: Attempt<Output>[]
  judged: { verdict: Verdict | null }[]
  table: string
  caveats: string[]
  render: (fixture: Fixture) => (output: Output) => string
}): string {
  const { task } = input
  return [
    `# pnpm bench ${task.title}`,
    '',
    `${task.knob} = ${input.incumbent} · judge ${bench.judge}`,
    '',
    '```',
    input.table,
    '```',
    '',
    ...input.caveats.map(c => `- ${c}`),
    '',
    '## Labels',
    '',
    ...input.entrants.map(({ label, item }) => `- **${label}** — ${entrantKey(item)}`),
    ...input.fixtures.flatMap((fixture, f) => [
      '',
      `## Fixture ${f + 1} — ${task.describe(fixture)}`,
      '',
      `**Judge:** ${input.judged[f]?.verdict?.verdict ?? 'no verdict'}`,
      '',
      ...(input.judged[f]?.verdict?.rows ?? []).map(row => `- ${row.label} · rank ${row.rank} · ${row.score}/10 — ${row.note}`),
      ...input.entrants.flatMap(({ label, item }) =>
        input.attempts
          .filter(a => a.fixture === f && a.key === entrantKey(item))
          .flatMap(a => [
            '',
            `### ${label} · ${a.key} · run ${a.run + 1} · ${(a.ms / 1000).toFixed(1)}s · ${a.calls.length} call(s)`,
            '',
            ...(a.flags.length ? ['Flags:', ...a.flags.map(flag => `- ${flag}`), ''] : []),
            a.output === null ? `FAILED: ${a.error}` : ['```', input.render(fixture)(a.output), '```'].join('\n'),
          ]),
      ),
    ]),
    '',
  ].join('\n')
}
