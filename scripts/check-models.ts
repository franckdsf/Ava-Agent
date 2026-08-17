/**
 * Benchmarks candidate models for the translator and the summarizer — the two
 * calls a reader waits on synchronously — on latency, price and measurable
 * output shape.
 *
 *     pnpm models:check
 *     pnpm models:check --task translator --fixtures 1 --repeats 10
 *     pnpm models:check --models deepseek --concurrency 1 --language French
 *
 * Sibling of `check-sonar.ts` and it exists for the same reason: the thing that
 * can go wrong here is not the code, it is what a model returns and how long it
 * takes, and that is only observable by running it. Nothing is stored and no
 * message is sent — it reads `articles` for real bodies and calls models.
 *
 * **It swaps the model and nothing else.** Each candidate is a clone of the real
 * agent built from `getInstructions()` and `getDefaultOptions()`, so the prompt
 * and the provider pinning are identical to production, and the calls go through
 * `translateChunk` and `summarizeSource` themselves — including the translator's
 * degenerate-result retry, which is part of what a model costs.
 *
 * **What it does not measure is whether the prose is any good.** Gloss density,
 * word count and a frame-phrase check catch a model that did not do the job at
 * all; they cannot rank two that did. Every response is written out in full under
 * `--out` for exactly that reason — the table narrows the field, a human reads
 * the transcripts and picks.
 *
 * **Run it more than once before believing a latency number.** OpenRouter routes
 * to whichever endpoint is fastest at that moment (see the note in
 * `translator.ts`), so a single call measures the pool, not the model.
 */
delete process.env.NEWY_TELEGRAM_BOT_TOKEN
delete process.env.JOOB_TELEGRAM_BOT_TOKEN

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { and, desc, isNotNull, sql } from 'drizzle-orm'
import { summary } from '../src/config/summary.js'
import { TRANSLATIONS, translation } from '../src/config/translation.js'
import { db } from '../src/db/client.js'
import { articles } from '../src/db/schema.js'
import { summarizeSource, summarizer, summarizerId } from '../src/mastra/agents/summarizer.js'
import { translateChunk, translator, translatorId } from '../src/mastra/agents/translator.js'
import { capText, chunkText } from '../src/services/article.js'

/**
 * The field. The incumbent is in it on purpose — it is the only baseline that
 * shares this run's routing luck, and a comparison against a number measured on
 * another evening is not a comparison.
 */
const FIELD = [
  'openrouter/google/gemini-3.1-flash-lite',
  'openrouter/deepseek/deepseek-v4-flash-0731',
  'openrouter/tencent/hy3',
  'openrouter/upstage/solar-pro4',
] as const

const INCUMBENT = 'openrouter/google/gemini-3.1-flash-lite'

interface Options {
  repeats: number
  fixtures: number
  task: 'both' | 'translator' | 'summarizer'
  language: string
  out: string
  models: string[]
  concurrency: number
}

function parseOptions(argv: string[]): Options {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index === -1 ? undefined : argv[index + 1]
  }
  return {
    repeats: Number(flag('repeats') ?? 2),
    fixtures: Number(flag('fixtures') ?? 2),
    task: (flag('task') ?? 'both') as Options['task'],
    language: flag('language') ?? translation.fallbackLanguage,
    out: flag('out') ?? join('.data', 'model-bench'),
    concurrency: Number(flag('concurrency') ?? 8),
    // A substring match against `FIELD`, so narrowing to the two models still in
    // contention is `--models deepseek,gemini` rather than two full ids. The
    // incumbent is added back below whatever the filter says: a run that cannot
    // compare against it measures the pool's mood, not a model.
    models: (flag('models') ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  }
}

const options = parseOptions(process.argv.slice(2))

const CANDIDATES = options.models.length
  ? [
      INCUMBENT,
      ...FIELD.filter(
        model => model !== INCUMBENT && options.models.some(filter => model.includes(filter)),
      ),
    ]
  : [...FIELD]

/** One measured call: what it cost and how long it took. */
interface Attempt {
  ms: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
}

interface Result {
  model: string
  task: 'translator' | 'summarizer'
  fixture: string
  run: number
  ms: number
  attempts: Attempt[]
  language: string
  blocks: number
  words: number
  metrics: Record<string, number>
  text: string
  error?: string
}

/**
 * An agent that records what every call cost.
 *
 * A subclass rather than a wrapper because `translateChunk` and
 * `summarizeSource` resolve their agent through `mastra.getAgent`, so the
 * instrumented one has to *be* an Agent to be registerable — and the whole point
 * of this script is that the code path under measurement is the real one.
 */
class Measured extends Agent {
  readonly attempts: Attempt[] = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generate(...args: any[]): Promise<any> {
    const started = performance.now()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (super.generate as any)(...args)
    const usage = response?.usage ?? {}
    this.attempts.push({
      ms: performance.now() - started,
      inputTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
      outputTokens: usage.outputTokens ?? usage.completionTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
    })
    return response
  }
}

/** A candidate wearing the real agent's prompt and provider options. */
async function clone(agent: Agent, id: string, model: string): Promise<Measured> {
  const defaults = await agent.getDefaultOptions()
  return new Measured({
    id,
    name: id,
    model,
    instructions: await agent.getInstructions(),
    // Only the provider pinning and reasoning effort are ours; the rest of what
    // `getDefaultOptions` resolves is Mastra's own defaulting, and re-passing it
    // would pin this run to today's internals.
    defaultOptions: { providerOptions: defaults.providerOptions },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

/** OpenRouter's own price list, so nothing here carries a hardcoded rate. */
async function pricing(): Promise<Map<string, { input: number; output: number }>> {
  const response = await fetch('https://openrouter.ai/api/v1/models')
  if (!response.ok) throw new Error(`OpenRouter models list: ${response.status}`)
  const body = (await response.json()) as {
    data: { id: string; pricing?: { prompt?: string; completion?: string } }[]
  }
  return new Map(
    body.data.map(model => [
      model.id,
      {
        input: Number(model.pricing?.prompt ?? 0) * 1_000_000,
        output: Number(model.pricing?.completion ?? 0) * 1_000_000,
      },
    ]),
  )
}

/** Real bodies, because a synthetic article has none of what breaks these two. */
async function fixtures(count: number): Promise<{ title: string; source: string; text: string }[]> {
  const rows = await db()
    .select({ title: articles.title, source: articles.source, content: articles.content })
    .from(articles)
    .where(and(isNotNull(articles.content), sql`length(${articles.content}) between 3000 and 8000`))
    .orderBy(desc(articles.discoveredAt))
    .limit(count)

  if (rows.length === 0) throw new Error('No stored article has a body — run the pipeline first.')
  return rows.map(row => ({
    title: row.title,
    source: row.source,
    text: capText(row.content ?? '', summary.maxSourceChars),
  }))
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length

/**
 * What can be checked without judgement, for the translator.
 *
 * `glossesPer100Words` is the one that matters: it is the command's whole point
 * and the floor `minGlossesPer100Words` guards. `wrongForm` counts glosses that
 * skipped the italic underscores, and `sentenceGlosses` counts the failure the
 * prompt argues against at length — a note to the reader inside a gloss.
 */
function translatorMetrics(paragraphs: string[]): Record<string, number> {
  const joined = paragraphs.join(' ')
  const total = words(joined)
  const glosses = joined.match(/\(([^)]+)\)/g) ?? []
  const italic = glosses.filter(gloss => /^\(_[^)]+_\)$/.test(gloss))
  return {
    glossesPer100Words: total ? Number(((glosses.length / total) * 100).toFixed(1)) : 0,
    glosses: glosses.length,
    wrongForm: glosses.length - italic.length,
    sentenceGlosses: glosses.filter(gloss => words(gloss) > 4).length,
    // The failure the retry path exists for: extraction debris carried straight
    // through, which proves the source was echoed rather than translated.
    debris: /a\]:hidden|<\/?[a-z][^>]*>|\{[^}]*:[^}]*\}/i.test(joined) ? 1 : 0,
  }
}

/** The frames the summarizer prompt forbids, in the languages it writes in. */
const FRAMES =
  /^\s*(cet? article|cette (vidéo|présentation)|dans cet article|este (resumo|artigo)|nesta|this (article|piece|post|video)|in this (article|piece|video)|the (article|author|video|speaker|presenter|paper) (covers|explains|describes|details)|el artículo|dieser artikel|данная статья|эта статья)/i

/**
 * What can be checked without judgement, for the summarizer.
 *
 * `frames` counts blocks opening with a sentence about the article instead of
 * about its subject — the failure the prompt spends the most words on, and the
 * one that survives most often when writing in a language other than English.
 */
function summarizerMetrics(paragraphs: string[]): Record<string, number> {
  const joined = paragraphs.join('\n\n')
  return {
    frames: paragraphs.filter(block => FRAMES.test(block)).length,
    bullets: paragraphs.filter(block => block.trimStart().startsWith('- ')).length,
    bannedHeadings: paragraphs.filter(block => /^#{1,2}\s/.test(block.trimStart())).length,
    links: (joined.match(/\[[^\]]*\]\([^)]*\)|https?:\/\//g) ?? []).length,
    codeSpans: (joined.match(/`[^`\n]+`/g) ?? []).length,
  }
}

async function runTranslator(
  model: string,
  fixture: { text: string },
  run: number,
): Promise<Result> {
  const agent = await clone(translator, translatorId, model)
  const mastra = new Mastra({ agents: { [translatorId]: agent } })
  const part = chunkText(fixture.text, translation.sourceChunkChars)[0] ?? ''
  const started = performance.now()
  try {
    const result = await translateChunk(mastra, {
      text: part,
      definition: TRANSLATIONS['/translearn'],
      part: { index: 1, total: 1 },
    })
    return {
      model,
      task: 'translator',
      fixture: part.slice(0, 40),
      run,
      ms: performance.now() - started,
      attempts: agent.attempts,
      language: result.language,
      blocks: result.paragraphs.length,
      words: words(result.paragraphs.join(' ')),
      metrics: translatorMetrics(result.paragraphs),
      text: result.paragraphs.join('\n\n'),
    }
  } catch (error) {
    return failure(model, 'translator', part.slice(0, 40), run, started, agent, error)
  }
}

async function runSummarizer(
  model: string,
  fixture: { text: string; title: string },
  run: number,
): Promise<Result> {
  const agent = await clone(summarizer, summarizerId, model)
  const mastra = new Mastra({ agents: { [summarizerId]: agent } })
  const started = performance.now()
  try {
    const result = await summarizeSource(mastra, {
      text: fixture.text,
      language: options.language,
      kind: 'article',
    })
    return {
      model,
      task: 'summarizer',
      fixture: fixture.title.slice(0, 40),
      run,
      ms: performance.now() - started,
      attempts: agent.attempts,
      language: result.language,
      blocks: result.paragraphs.length,
      words: words(result.paragraphs.join(' ')),
      metrics: summarizerMetrics(result.paragraphs),
      text: result.paragraphs.join('\n\n'),
    }
  } catch (error) {
    return failure(model, 'summarizer', fixture.title.slice(0, 40), run, started, agent, error)
  }
}

/**
 * A failed call is a result, not an exception.
 *
 * A model that throws on one article in three is disqualified by that fact, and
 * a script that stopped at the first one would never get far enough to say so.
 */
function failure(
  model: string,
  task: 'translator' | 'summarizer',
  fixture: string,
  run: number,
  started: number,
  agent: Measured,
  error: unknown,
): Result {
  return {
    model,
    task,
    fixture,
    run,
    ms: performance.now() - started,
    attempts: agent.attempts,
    language: '—',
    blocks: 0,
    words: 0,
    metrics: {},
    text: '',
    error: error instanceof Error ? error.message : String(error),
  }
}

const usd = (value: number): string => `$${value.toFixed(5)}`

/**
 * What one command actually bills, summed over its attempts.
 *
 * **Reasoning tokens are not added to output tokens**, because they are already
 * in it — measured, not assumed: gemini reported 2344 output against 1797
 * reasoning on a summary whose visible French prose is ~550 tokens. Adding them
 * charged this model twice for its thinking and made it look 60% dearer than it
 * is. They are still recorded per attempt, since a model that spends three
 * thinking tokens per written one is the reason a cheap rate stops being cheap.
 */
function cost(result: Result, rates: Map<string, { input: number; output: number }>): number {
  const rate = rates.get(result.model.replace(/^openrouter\//, ''))
  if (!rate) return 0
  return result.attempts.reduce(
    (total, attempt) =>
      total + (attempt.inputTokens * rate.input + attempt.outputTokens * rate.output) / 1_000_000,
    0,
  )
}

/**
 * How much of what this model emitted was thinking rather than answer.
 *
 * The column that explains a latency number: a model billing 80% of its output
 * as reasoning is not slow because the endpoint is busy, it is slow because
 * `effort: 'low'` means something different to it than to the incumbent.
 */
function thinkShare(results: Result[]): string {
  const out = results.flatMap(result => result.attempts).reduce((sum, a) => sum + a.outputTokens, 0)
  const reasoning = results
    .flatMap(result => result.attempts)
    .reduce((sum, a) => sum + a.reasoningTokens, 0)
  return out ? `${((reasoning / out) * 100).toFixed(0)}%` : '—'
}

/**
 * Runs `jobs` with at most `limit` in flight, keeping results in input order.
 *
 * **Concurrency changes what a latency number means, and that is a trade this
 * script makes on purpose.** Ten calls at once contend for the same endpoints, so
 * every number here is the pessimistic reading — a lone reader on a quiet pool
 * does better. That is the right bias for the translator, which really does fire
 * up to six parts simultaneously ([translation.sourceChunkChars](../src/config/translation.ts)),
 * and it is the only way a ten-repeat sweep finishes in minutes instead of an
 * hour. Pass `--concurrency 1` for the optimistic reading; the honest answer for
 * a model is the pair.
 */
async function pool<T, R>(jobs: T[], limit: number, run: (job: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(jobs.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    while (next < jobs.length) {
      const index = next++
      results[index] = await run(jobs[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const mean = (values: number[]): number =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0

async function main(): Promise<void> {
  const rates = await pricing()
  const sources = await fixtures(options.fixtures)

  console.log(
    `Candidates: ${CANDIDATES.length} · fixtures: ${sources.length} · repeats: ${options.repeats}` +
      ` · ${options.concurrency} calls in flight`,
  )
  console.log(
    `Summaries in: ${options.language} · translations glossed by /translearn's rule\n`,
  )
  for (const [index, source] of sources.entries()) {
    console.log(
      `  fixture ${index + 1}: ${source.title} — ${source.source} (${source.text.length} chars)`,
    )
  }
  console.log('\nList price, per million tokens:')
  for (const model of CANDIDATES) {
    const rate = rates.get(model.replace(/^openrouter\//, ''))
    console.log(
      `  ${model.padEnd(46)} in ${rate ? `$${rate.input.toFixed(3)}` : '?'} · out ${
        rate ? `$${rate.output.toFixed(3)}` : '?'
      }`,
    )
  }
  console.log('')

  const tasks: ('translator' | 'summarizer')[] =
    options.task === 'both' ? ['translator', 'summarizer'] : [options.task]

  const jobs = tasks.flatMap(task =>
    CANDIDATES.flatMap(model =>
      sources.flatMap((source, index) =>
        Array.from({ length: options.repeats }, (_, run) => ({
          task,
          model,
          source,
          fixture: index + 1,
          run: run + 1,
        })),
      ),
    ),
  )

  await mkdir(options.out, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const live = join(options.out, `${stamp}.jsonl`)

  const started = performance.now()
  const results = await pool(jobs, options.concurrency, async job => {
    const result =
      job.task === 'translator'
        ? await runTranslator(job.model, job.source, job.run)
        : await runSummarizer(job.model, job.source, job.run)

    // Appended as it lands, not collected for the end. A forty-call sweep runs
    // for minutes and the interesting draw is often the one that made it run
    // long, so a run killed at minute nine has to leave its first thirty-nine
    // results behind. stdout cannot be relied on for that: a `| grep` between
    // this process and a terminal buffers every line until exit.
    await appendFile(live, `${JSON.stringify({ ...result, text: undefined })}\n`, 'utf8')

    // Logged on completion rather than on dispatch: under concurrency the two
    // orders differ, and a half-written line waiting on a 200s call is worse
    // than no progress line at all.
    console.log(
      `  ${`+${((performance.now() - started) / 1000).toFixed(0)}s`.padStart(5)}  ` +
        `${job.task} · ${job.model.replace('openrouter/', '')} · fixture ${job.fixture} · run ${job.run} … ` +
        (result.error
          ? `FAILED after ${(result.ms / 1000).toFixed(1)}s — ${result.error}`
          : `${(result.ms / 1000).toFixed(1)}s · ${result.words} words · ${usd(cost(result, rates))}` +
            `${result.attempts.length > 1 ? ` · ${result.attempts.length} attempts` : ''}`),
    )
    return result
  })

  for (const task of tasks) {
    console.log(`\n=== ${task.toUpperCase()} ===`)
    console.log(
      task === 'translator'
        ? 'model                                    ok   median   worst  words   think    $/call  vs base  gloss/100  wrongForm  sentences  debris'
        : 'model                                    ok   median   worst  words   think    $/call  vs base   blocks  bullets  frames  links',
    )

    const forTask = results.filter(result => result.task === task)
    const baseline = mean(
      forTask.filter(result => result.model === INCUMBENT && !result.error).map(result => cost(result, rates)),
    )

    for (const model of CANDIDATES) {
      const rows = forTask.filter(result => result.model === model)
      const ok = rows.filter(result => !result.error)
      const latencies = ok.map(result => result.ms / 1000)
      const average = mean(ok.map(result => cost(result, rates)))
      const ratio = baseline ? `${(average / baseline).toFixed(2)}×` : '—'
      const metric = (key: string): string =>
        mean(ok.map(result => Number(result.metrics[key] ?? 0))).toFixed(1)
      const shared =
        `${model.replace('openrouter/', '').padEnd(40)} ` +
        `${ok.length}/${rows.length}  ` +
        `${median(latencies).toFixed(1).padStart(5)}s  ` +
        `${(latencies.length ? Math.max(...latencies) : 0).toFixed(1).padStart(5)}s  ` +
        `${mean(ok.map(result => result.words)).toFixed(0).padStart(5)}  ` +
        `${thinkShare(ok).padStart(6)}  ` +
        `${usd(average).padStart(8)}  ` +
        `${ratio.padStart(7)}  `
      console.log(
        task === 'translator'
          ? `${shared}${metric('glossesPer100Words').padStart(9)}  ${metric('wrongForm').padStart(9)}  ` +
              `${metric('sentenceGlosses').padStart(9)}  ${metric('debris').padStart(6)}`
          : `${shared}${mean(ok.map(result => result.blocks)).toFixed(1).padStart(7)}  ` +
              `${metric('bullets').padStart(7)}  ${metric('frames').padStart(6)}  ${metric('links').padStart(5)}`,
      )
    }
  }

  await writeFile(join(options.out, `${stamp}.json`), JSON.stringify({ options, results }, null, 2), 'utf8')
  const transcript = results
    .map(
      result =>
        `## ${result.task} · ${result.model} · ${result.fixture} · run ${result.run}\n\n` +
        `${(result.ms / 1000).toFixed(1)}s · ${result.words} words · ${result.blocks} blocks · ` +
        `language: ${result.language} · ${JSON.stringify(result.metrics)}\n\n` +
        `${result.error ? `FAILED: ${result.error}` : result.text}\n`,
    )
    .join('\n---\n\n')
  await writeFile(join(options.out, `${stamp}.md`), transcript, 'utf8')
  console.log(`\nTranscripts: ${join(options.out, `${stamp}.md`)}`)
}

await main()
process.exit(0)
