/**
 * `pnpm bench job-targeter` — `AVA_MODEL_JOB_TARGETER`, through `parseTarget`.
 *
 * The fixtures are written, with what each request must parse to — the second
 * task here whose inputs carry their answer. The instructions are unusually
 * precise about the failure that matters: **do not invent a constraint they did
 * not state**, because a wrong filter drops postings before anything reads them
 * and the reader never learns what they missed. So every request lists the
 * fields it names, and the fields it does not name must come back empty.
 *
 * One run parses all four requests of a fixture, one call each — the command
 * parses one sentence, and four of them show a model rather than a sentence.
 */
import {
  jobTargeterAgents,
  jobTargeterId,
  parseTarget,
  type ParsedTarget,
} from '../../../src/mastra/agents/job-targeter.js'
import { bench } from '../../../src/config/bench.js'
import type { BenchTask } from '../kit.js'

type Remote = ParsedTarget['remote']

interface Request {
  text: string
  /** Each accepted value; a request that could fairly read two ways lists both. */
  remote?: Remote[]
  /** Each must appear, case-insensitively, inside some returned location. */
  locations?: string[]
  minCompensation?: number | null
  currency?: string | null
  contractTypes?: string[]
  seniority?: string[]
  /** Must come back empty: the request says nothing about them. */
  empty?: ('locations' | 'seniority' | 'contractTypes' | 'dealbreakers' | 'mustHave')[]
  /** A dealbreaker matching this must be present. */
  dealbreaker?: RegExp
}

export interface JobTargeterFixture {
  requests: Request[]
}

const FIXTURES: JobTargeterFixture[] = [
  {
    requests: [
      {
        text: 'senior frontend, Paris',
        remote: ['any'],
        locations: ['Paris'],
        seniority: ['senior'],
        minCompensation: null,
        empty: ['contractTypes', 'dealbreakers'],
      },
      {
        text: "Je cherche un poste de développeur Rust en full remote, pas d'ESN, minimum 65k€",
        remote: ['required'],
        minCompensation: 65000,
        currency: 'EUR',
        dealbreaker: /esn|consult|agency|service/i,
        empty: ['locations', 'contractTypes'],
      },
      {
        text: "data scientist in Berlin or Munich, permanent contract, I'd rather work remote but an office is fine",
        remote: ['preferred'],
        locations: ['Berlin', 'Munich'],
        contractTypes: ['permanent'],
        minCompensation: null,
        empty: ['dealbreakers'],
      },
      {
        text: 'freelance React Native mission, 3 to 6 months',
        remote: ['any'],
        contractTypes: ['freelance'],
        minCompensation: null,
        empty: ['locations', 'dealbreakers'],
      },
    ],
  },
  {
    requests: [
      {
        text: 'staff backend engineer, Go or Rust, remote within Europe, no on-call',
        remote: ['required', 'preferred'],
        seniority: ['staff'],
        dealbreaker: /on.?call/i,
        minCompensation: null,
        empty: ['contractTypes'],
      },
      {
        text: 'un stage en UX design à Lyon',
        locations: ['Lyon'],
        contractTypes: ['internship'],
        minCompensation: null,
        empty: ['dealbreakers'],
      },
      {
        text: 'engineering manager at a climate tech startup, London, £110k or more',
        locations: ['London'],
        minCompensation: 110000,
        currency: 'GBP',
        empty: ['contractTypes', 'dealbreakers'],
      },
      {
        text: 'anything in machine learning really',
        remote: ['any'],
        minCompensation: null,
        empty: ['locations', 'seniority', 'contractTypes', 'dealbreakers'],
      },
    ],
  },
]

/** Every way one parse departs from what its request says. */
function departures(parsed: ParsedTarget, request: Request): string[] {
  const out: string[] = []
  if (request.remote && !request.remote.includes(parsed.remote)) {
    out.push(`remote is "${parsed.remote}", the request reads as ${request.remote.join(' or ')}`)
  }
  for (const place of request.locations ?? []) {
    if (!parsed.locations.some(l => l.toLowerCase().includes(place.toLowerCase()))) out.push(`location "${place}" missing`)
  }
  if (request.minCompensation !== undefined && parsed.minCompensation !== request.minCompensation) {
    out.push(`pay floor ${parsed.minCompensation ?? 'none'}, the request says ${request.minCompensation ?? 'none'}`)
  }
  if (request.currency !== undefined && parsed.currency !== request.currency) {
    out.push(`currency ${parsed.currency ?? 'none'}, the request says ${request.currency ?? 'none'}`)
  }
  for (const kind of request.contractTypes ?? []) {
    if (!parsed.contractTypes.includes(kind)) out.push(`contract "${kind}" missing`)
  }
  for (const band of request.seniority ?? []) {
    if (!parsed.seniority.includes(band)) out.push(`seniority "${band}" missing`)
  }
  for (const field of request.empty ?? []) {
    if (parsed[field].length) out.push(`invented ${field}: ${parsed[field].join(', ')}`)
  }
  if (request.dealbreaker && !parsed.dealbreakers.some(d => request.dealbreaker?.test(d))) {
    out.push('the stated dealbreaker is missing')
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(parsed.slug) || parsed.slug.length > bench.promptLimits.targeterSlugChars) out.push(`slug "${parsed.slug}" breaks the format`)
  if (parsed.mustHave.length > bench.promptLimits.targeterMustHaves) {
    out.push(`${parsed.mustHave.length} must-haves, the limit is ${bench.promptLimits.targeterMustHaves}`)
  }
  return out
}

type Parses = (ParsedTarget | null)[]

/** Everything the labels prove wrong with one run's parses. */
export function jobTargeterFlags(parses: Parses, fixture: JobTargeterFixture): string[] {
  return parses.flatMap((parsed, index) => {
    const request = fixture.requests[index]
    if (!request) return []
    if (!parsed) return [`request ${index + 1}: no parse — the reader gets the usage line`]
    return departures(parsed, request).map(d => `request ${index + 1}: ${d}`)
  })
}

export const jobTargeter: BenchTask<JobTargeterFixture, Parses> = {
  title: 'job-targeter',
  knob: 'AVA_MODEL_JOB_TARGETER',
  agentId: jobTargeterId,
  agent: jobTargeterAgents[jobTargeterId],
  field: [
    { model: 'openrouter/deepseek/deepseek-v4.1-flash', efforts: [false, 'low'], sorts: ['latency'] },
    { model: 'openrouter/openai/gpt-5.6-luna', efforts: [false, 'low'], sorts: ['latency'] },
    { model: 'openrouter/anthropic/claude-haiku-5.5', efforts: [false], sorts: ['latency'] },
  ],
  fixtures: async count => FIXTURES.slice(0, count),
  written: true,
  describe: f => f.requests.map(r => `"${r.text.slice(0, 40)}"`).join(' · '),
  call: async (mastra, fixture) => {
    const parses: Parses = []
    for (const request of fixture.requests) {
      try {
        parses.push(await parseTarget(mastra, request.text))
      } catch {
        // The command answers a failed parse with its usage line; here it is a flag.
        parses.push(null)
      }
    }
    return parses.some(Boolean) ? parses : null
  },
  check: jobTargeterFlags,
  metrics: (parses, fixture) => {
    const labelled = parses.filter((p, i) => p && fixture.requests[i])
    const exact = parses.filter((p, i) => p && fixture.requests[i] && departures(p, fixture.requests[i] as Request).length === 0)
    return { 'exact parses': labelled.length ? exact.length / fixture.requests.length : NaN }
  },
  judgeInput: f => f.requests.map((r, i) => `## Request ${i + 1}\n${r.text}`).join('\n\n'),
  renderOutput: (parses, fixture) =>
    parses
      .map((p, i) => `Request ${i + 1} — "${fixture.requests[i]?.text ?? ''}"\n${p ? JSON.stringify(p) : 'NO PARSE'}`)
      .join('\n\n'),
  criteria: [
    'No constraint the request did not state: an empty list is the right answer for anything it does not ' +
      'mention, and a guessed filter is the worst failure here.',
    'What it did state is captured exactly — place, remote preference, pay floor and currency, contract.',
    'Soft or uncertain wishes go to notes, not to a filter; notes describe what would suit them.',
    'Every field is English except the label, which follows the reader\'s language.',
  ],
  caveats: () => [
    'Fixtures are written with what each request must parse to; `exact parses` is the share matching ' +
      'every label. The command is waited on, so `worst` counts.',
  ],
}
