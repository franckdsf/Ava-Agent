import { devServer } from '../src/config/dev-server.js'

/**
 * `pnpm workflow:run <target> [flags]`
 *
 * Fires a scheduled workflow by hand, against the server `pnpm dev` is already
 * running, and watches it to the end.
 *
 * **This is the one script here that is not a dry run.** Every `check-*` script
 * reads and prints; this one starts a real run that fetches real feeds, calls
 * real models and sends real Telegram messages. Each target below states what it
 * costs, and the script prints that line before it fires.
 *
 * Three things it exists to get right, all of them documented traps:
 *
 * **The route takes the registry key, the schedule rows take the workflow id.**
 * `curateAll` in `index.ts` declares `createWorkflow({ id: 'curate-all' })`, and
 * the two names are not interchangeable — an id in the URL is a bare 404, and a
 * registry key handed to `mastra.schedules.list()` matches nothing at all. The
 * table below holds the route name; the aliases accept either, so neither
 * spelling can be wrong here.
 *
 * **`initialState` is mandatory when a `stateSchema` has no defaults**, which is
 * true of `curateAll` and of nothing else. Studio fills it in from the schema, so
 * the gap only ever shows up over HTTP, as a 500 listing the four fields.
 *
 * **A 504 does not stop the run.** `start-async` waits for the workflow to
 * finish and the gateway times out first on anything long — deliveries have
 * landed six minutes after the 504. So this supplies its own `runId` up front
 * and *polls* rather than reading the response body: the run is watched through
 * `GET /runs/:runId` whatever the POST does, and re-firing — the thing that puts
 * two runs in flight at once — never comes up.
 *
 * Speaks HTTP and nothing else: no database, no model, no `.env`.
 */

/** A field of some workflow's `inputSchema`, as a flag. */
type Flag = 'beats' | 'searches' | 'force'

type Target = {
  /**
   * The key in `index.ts`'s `workflows` map, which is what the route wants — not
   * the kebab-case `createWorkflow` id, which is what schedule rows are keyed by.
   */
  route: string
  what: string
  /** What a run of this actually spends, printed before it fires. */
  cost: string
  /** The `inputSchema` fields this workflow has. Anything else is refused. */
  accepts: Flag[]
  /**
   * Only for a `stateSchema` whose fields carry no defaults. `findJobs` gives
   * every field one precisely to avoid this, and the others declare no state.
   */
  initialState?: Record<string, unknown>
}

const TARGETS: Record<string, Target> = {
  news: {
    route: 'curateAll',
    what: 'ingest every subscribed feed, rank, arbitrate, deliver each beat digest',
    cost: 'one ranking pass per beat plus a writer call per delivered article, and it sends to Telegram',
    accepts: ['beats'],
    initialState: { feedsFetched: 0, discovered: 0, linked: 0, feedErrors: [] },
  },
  jobs: {
    route: 'findJobs',
    what: 'fetch every job source, filter, score against the CV, deliver briefs',
    cost: 'the scoring call — the largest single prompt in this repo — plus scout and writer calls, and it sends to Telegram',
    accepts: ['searches', 'force'],
  },
  prune: {
    route: 'pruneArticles',
    what: 'delete articles past the retention window',
    cost: 'nothing — deterministic, no model, no message',
    accepts: [],
  },
  'review-feeds': {
    route: 'reviewFeeds',
    what: 'the weekly feed review — restore, prune, top up',
    cost: 'a scout call per under-filled beat, and it sends to Telegram',
    accepts: [],
  },
  'review-memories': {
    route: 'reviewMemories',
    what: 'the weekly memory review — promote short-term notes, sweep the rest',
    cost: 'one reviewer call, and it deletes notes it does not promote',
    accepts: [],
  },
}

/**
 * Both spellings of every target, so neither the registry key nor the workflow
 * id can be the wrong one to type.
 *
 * `discoverFeeds` is deliberately absent. It takes a `slug` and a `subject` and
 * assumes the beat already exists and is paused, which is a state only `/follow`
 * produces — firing it by hand against a beat nothing prepared writes feeds onto
 * whatever slug you typed. `/follow` is its entry point.
 */
const ALIASES = new Map<string, string>()
for (const [name, target] of Object.entries(TARGETS)) {
  ALIASES.set(name, name)
  ALIASES.set(target.route.toLowerCase(), name)
  ALIASES.set(target.route.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(), name)
}

function usage(): never {
  console.log('usage: pnpm workflow:run <target> [flags]\n')
  console.log('targets:')
  for (const [name, target] of Object.entries(TARGETS)) {
    console.log(`  ${name.padEnd(16)} ${target.route.padEnd(15)} ${target.what}`)
    console.log(`  ${''.padEnd(16)} ${''.padEnd(15)} costs: ${target.cost}`)
  }
  console.log('\nflags — all optional. With none, a target runs exactly what its cron fires.')
  console.log('  --beats a,b        news only — narrow to these beat slugs. Omit for every active beat')
  console.log('  --searches a,b     jobs only — narrow to these search slugs. Omit for every active search')
  console.log('  --force            jobs only — skip the elapsed-time gate')
  console.log('  --no-watch         fire and print the run id, do not follow it')
  console.log('\nexamples:')
  console.log('  pnpm workflow:run news                  every active beat — the scheduled run')
  console.log('  pnpm workflow:run news --beats design   one beat')
  console.log('  pnpm workflow:run jobs --force          every active search, gate skipped')
  console.log('  pnpm workflow:run prune')
  console.log('\nA slug that matches no beat or search is silently absent, not an error —')
  console.log('`activeBeats` treats it as a beat archived mid-run. So a typo is a run that')
  console.log('does nothing and reports success. Zeroes in the report are the tell.')
  console.log('\nNeeds `pnpm dev` running: a workflow cannot be started from a plain script,')
  console.log('only over HTTP against the server that owns the pubsub loop.')
  process.exit(0)
}

/* ────────────────────────────── the arguments ────────────────────────────── */

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '--help') usage()

const name = ALIASES.get(args[0]!.toLowerCase())
if (!name) {
  console.error(`unknown target "${args[0]}" — one of: ${Object.keys(TARGETS).join(', ')}`)
  process.exit(1)
}
const target = TARGETS[name]!

/**
 * Flags rather than a JSON argument, and that is not a style choice: PowerShell
 * strips the inner double quotes when a native exe is handed `'{"a":1}'`, which
 * is how `mastra api workflow run start` fails here with `INVALID_JSON`. Named
 * flags need no quoting on any shell, and between them they cover every field
 * the two schedulable workflows accept.
 */
const flags = new Map<string, string>()
let watch = true
for (let i = 1; i < args.length; i++) {
  const arg = args[i]!
  if (arg === '--no-watch') {
    watch = false
    continue
  }
  if (!arg.startsWith('--')) {
    console.error(`unexpected argument "${arg}" — flags only, see --help`)
    process.exit(1)
  }
  const key = arg.slice(2)
  // `--force` is a boolean; the list flags take the next argument as their value.
  if (key === 'force') {
    flags.set(key, 'true')
    continue
  }
  const value = args[++i]
  if (value === undefined) {
    console.error(`--${key} needs a value`)
    process.exit(1)
  }
  flags.set(key, value)
}

const inputData: Record<string, unknown> = {}
for (const [key, value] of flags) {
  // Refused rather than ignored: a `--beats` silently dropped on a jobs run
  // looks exactly like a narrow run that found nothing.
  if (!target.accepts.includes(key as Flag)) {
    console.error(`${name} does not accept --${key} (it takes: ${target.accepts.map(f => `--${f}`).join(', ') || 'no flags'})`)
    process.exit(1)
  }
  if (key === 'force') inputData.force = true
  else inputData[key] = value.split(',').map(part => part.trim()).filter(Boolean)
}

/* ──────────────────────────────── the firing ─────────────────────────────── */

const api = `${devServer.baseUrl}/api/workflows/${target.route}`

// Preflight, so an unreachable server is one clear line rather than a fetch
// stack trace on the start call.
try {
  const probe = await fetch(`${devServer.baseUrl}/api/workflows`)
  if (!probe.ok) throw new Error(`${probe.status} ${probe.statusText}`)
} catch (error) {
  console.error(`No Mastra server at ${devServer.baseUrl} — start one with \`pnpm dev\`.`)
  console.error(`  (${error instanceof Error ? error.message : String(error)})`)
  process.exit(1)
}

// Supplied rather than read back: a 504 never returns a body, and without an id
// agreed up front there is nothing to poll and the only recovery is re-firing.
const runId = crypto.randomUUID()

console.log(`\n${name} (${target.route})  ${target.what}`)
console.log(`costs   ${target.cost}`)
console.log(`input   ${JSON.stringify(inputData)}`)
console.log(`runId   ${runId}\n`)

let fatal: string | null = null
const started = fetch(`${api}/start-async?runId=${runId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ inputData, ...(target.initialState ? { initialState: target.initialState } : {}) }),
})
  .then(async response => {
    // A gateway timeout is the expected ending for any long run, not a failure:
    // `start-async` waits for the workflow and the proxy gives up first while
    // the run carries on. Anything else in the 4xx/5xx range is a real refusal —
    // a bad input shape, a missing `initialState` — and there is no run to watch.
    if (response.ok || response.status === 502 || response.status === 504) return
    fatal = `${response.status} ${response.statusText}\n${(await response.text()).slice(0, 800)}`
  })
  .catch(error => {
    // A dropped socket is the same story as a 504 — the server keeps running the
    // workflow — so this is recorded for the summary and never acted on.
    console.log(`  (the start request itself dropped: ${error instanceof Error ? error.message : String(error)})`)
  })

if (!watch) {
  await started
  if (fatal) {
    console.error(`\nrefused:\n${fatal}`)
    process.exit(1)
  }
  console.log(`fired. watch it with:\n  ${api}/runs/${runId}`)
  process.exit(0)
}

/* ──────────────────────────────── the watch ──────────────────────────────── */

type RunSnapshot = {
  status: string
  result?: { output?: unknown }
  error?: unknown
  steps?: Record<string, { status?: string }>
}

const TERMINAL = new Set(['success', 'failed', 'canceled', 'bailed', 'tripwire', 'skipped'])

const seen = new Map<string, string>()
const deadline = Date.now() + devServer.maxWatchMs
let final: RunSnapshot | null = null

while (Date.now() < deadline) {
  if (fatal) {
    console.error(`refused:\n${fatal}`)
    process.exit(1)
  }

  let run: RunSnapshot | null = null
  try {
    const response = await fetch(`${api}/runs/${runId}`)
    // A 404 until the first step persists a snapshot — the run exists, the row
    // does not yet.
    if (response.ok) run = (await response.json()) as RunSnapshot
  } catch {
    // The server restarting mid-run is worth surviving; the next tick retries.
  }

  if (run) {
    for (const [step, state] of Object.entries(run.steps ?? {})) {
      const status = state?.status ?? 'running'
      if (seen.get(step) === status) continue
      seen.set(step, status)
      console.log(`  ${status.padEnd(9)} ${step}`)
    }
    if (TERMINAL.has(run.status)) {
      final = run
      break
    }
  }

  await new Promise(resolve => setTimeout(resolve, devServer.pollMs))
}

if (!final) {
  // Standing down is not cancelling: nothing here can stop a run, and the run
  // does not care that the terminal stopped watching.
  console.log(`\nstill running after ${(devServer.maxWatchMs / 60_000).toFixed(0)}m — it carries on without this script.`)
  console.log(`  ${api}/runs/${runId}`)
  process.exit(0)
}

console.log(`\nstatus  ${final.status}`)
if (final.result?.output !== undefined) {
  console.log(`report  ${JSON.stringify(final.result.output, null, 2).replace(/\n/g, '\n        ')}`)
}
if (final.error) console.log(`error   ${JSON.stringify(final.error)}`)

process.exit(final.status === 'success' ? 0 : 1)
