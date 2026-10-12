/**
 * `pnpm bench job-scorer` — `AVA_MODEL_JOB_SCORER`, through `scoreBatch`.
 *
 * A fixture is one saved search, the CV as the portfolio endpoint serves it
 * today, and thirty postings the previous scorer actually read — stratified by
 * the fit it stored: about ten at or above the search's bar, ten between 30 and
 * the bar, ten below 30. A batch of only junk or only winners cannot show
 * whether a model discriminates, which is most of what a scorer is for.
 *
 * **The stored fits are not ground truth.** They are what an earlier scorer
 * said, and ranking candidates by agreement with it would crown whoever imitates
 * the incumbent best. `ρ stored` is shown so a model that scores on a different
 * scale is noticed, not to rank. What a scorer *should* be ranked against —
 * reader verdicts, which jobs do not have yet — is an open question.
 *
 * The fixture carries the CV, which is why it lives under gitignored `.data/`.
 */
import { and, desc, eq, gt, isNotNull, notInArray } from 'drizzle-orm'
import { bench } from '../../../src/config/bench.js'
import { jobPipeline } from '../../../src/config/jobs.js'
import { db } from '../../../src/db/client.js'
import { activeSearches } from '../../../src/db/job-searches.js'
import { FILTERED_BEFORE_SCORING } from '../../../src/db/jobs.js'
import { jobMatches, jobs, type JobSearch } from '../../../src/db/schema.js'
import {
  jobAgents,
  jobScorerId,
  renderJobScoringPrompt,
  scoreBatch,
  type ScoredVerdict,
} from '../../../src/mastra/agents/job-scorer.js'
import { fetchPortfolio } from '../../../src/services/portfolio.js'
import { coverageFlags, scoreSpread, spearman, type BenchTask } from '../kit.js'

interface Posting {
  id: string
  title: string
  company: string
  location: string | null
  remote: string
  salaryText: string | null
  contractType: string | null
  description: string | null
}

export interface JobScorerFixture {
  search: JobSearch
  cv: string
  /** The bar a verdict must clear to be delivered for this search. */
  threshold: number
  postings: Posting[]
  /** What the previous scorer stored, per posting. Never shown to a candidate. */
  stored: Record<string, number>
}

/**
 * The axes the instructions list for a mismatch. Counted in the table, never
 * flagged: nothing in the app parses the axis — mismatches are stored and read
 * as text — and the first live run showed the off-list ones are often the most
 * precise ("language: fluent French required"). A flag reaches the judge as
 * fact, so flagging them penalized the models naming gaps best.
 */
const AXES = /^(seniority|location|stack|compensation|contract|domain|company type)\s*:/i

const prompt = (f: JobScorerFixture): string => renderJobScoringPrompt(f.cv, f.search, f.postings)

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length

/** Everything code can prove wrong with one batch of verdicts. */
export function jobScorerFlags(verdicts: ScoredVerdict[], fixture: JobScorerFixture): string[] {
  const flags = coverageFlags(
    fixture.postings.map(p => p.id),
    verdicts.map(v => v.id),
    'postings',
  )

  const long = verdicts.filter(v => words(v.reason) > 20)
  if (long.length) flags.push(`${long.length} reasons over 20 words, e.g. "${long[0]?.reason}"`)
  const empty = verdicts.filter(v => v.reason.trim() === '')
  if (empty.length) flags.push(`${empty.length} empty reasons`)

  return flags
}

/**
 * Three bands of the stored fit, most recently scored first within each, then
 * put in id order so the batch is not sorted by the answer.
 */
async function readFixtures(count: number): Promise<JobScorerFixture[]> {
  const portfolio = await fetchPortfolio()
  const searches = await activeSearches()
  const perBand = Math.ceil(bench.jobBatch / 3)

  const built = await Promise.all(
    searches.map(async search => {
      const threshold = search.fitThreshold ?? jobPipeline.defaultFitThreshold
      const rows = await db()
        .select({
          id: jobs.id,
          title: jobs.title,
          company: jobs.company,
          location: jobs.location,
          remote: jobs.remote,
          salaryText: jobs.salaryText,
          contractType: jobs.contractType,
          description: jobs.description,
          fit: jobMatches.fit,
        })
        .from(jobMatches)
        .innerJoin(jobs, eq(jobs.id, jobMatches.jobId))
        .where(
          and(
            eq(jobMatches.searchSlug, search.slug),
            isNotNull(jobMatches.scoredAt),
            // A fit of 0 with a settlement reason was never read by a model —
            // filtered or deduplicated before the scorer — so it is not a verdict.
            gt(jobMatches.fit, 0),
            notInArray(jobMatches.reason, [FILTERED_BEFORE_SCORING]),
          ),
        )
        .orderBy(desc(jobMatches.scoredAt))

      const band = (low: number, high: number) =>
        rows.filter(r => (r.fit ?? 0) >= low && (r.fit ?? 0) < high).slice(0, perBand)
      const picked = [...band(threshold, 101), ...band(30, threshold), ...band(1, 30)]
        .slice(0, bench.jobBatch)
        .sort((a, b) => a.id.localeCompare(b.id))

      return {
        search,
        cv: portfolio.markdown,
        threshold,
        postings: picked.map(({ fit: _fit, ...posting }) => posting),
        stored: Object.fromEntries(picked.map(r => [r.id, r.fit ?? 0])),
      } satisfies JobScorerFixture
    }),
  )

  // The searches whose batch reaches the most of the top band — a fixture with
  // no posting worth sending cannot show who finds the good ones.
  const top = (f: JobScorerFixture) => Object.values(f.stored).filter(fit => fit >= f.threshold).length
  return built
    .filter(f => f.postings.length > 0)
    .sort((a, b) => top(b) - top(a) || b.postings.length - a.postings.length)
    .slice(0, count)
}

export const jobScorer: BenchTask<JobScorerFixture, ScoredVerdict[]> = {
  title: 'job-scorer',
  knob: 'AVA_MODEL_JOB_SCORER',
  agentId: jobScorerId,
  agent: jobAgents[jobScorerId],
  field: [
    { model: 'openrouter/deepseek/deepseek-v4-flash-0731', efforts: [false] },
    { model: 'openrouter/deepseek/deepseek-v4.1-flash', efforts: [false, 'low'] },
    { model: 'openrouter/anthropic/claude-haiku-5.5', efforts: [false, 'low'] },
    { model: 'openrouter/z-ai/glm-5.3-flash', efforts: ['low'] },
  ],
  fixtures: readFixtures,
  describe: f =>
    `${f.search.label} — ${f.postings.length} postings, ${Object.values(f.stored).filter(fit => fit >= f.threshold).length
    } stored at or above its bar of ${f.threshold}, CV ${f.cv.length.toLocaleString('en-US')} chars`,
  call: async (mastra, fixture) => {
    const verdicts = await scoreBatch(mastra, prompt(fixture), new Set(fixture.postings.map(p => p.id)))
    // `scoreBatch` returns [] when every attempt failed — in production the
    // batch stays unscored for the next run; here it is a failed run.
    return verdicts.length ? verdicts : null
  },
  check: jobScorerFlags,
  metrics: (verdicts, fixture) => {
    const high = verdicts.filter(v => v.fit >= 70)
    return {
      'over bar': verdicts.filter(v => v.fit >= fixture.threshold).length,
      mean: verdicts.reduce((sum, v) => sum + v.fit, 0) / verdicts.length,
      // The instructions ask for mismatches on high scorers too: the field is the
      // only record of what to check before an interview.
      'off axis': verdicts.flatMap(v => v.mismatches).filter(m => !AXES.test(m.trim())).length,
      'hi w/ mism': high.length ? high.filter(v => v.mismatches.length > 0).length / high.length : NaN,
      'ρ stored': spearman(
        verdicts.filter(v => v.id in fixture.stored).map(v => [v.fit, fixture.stored[v.id] as number]),
      ),
    }
  },
  across: runs => ({ spread: scoreSpread(runs.map(run => run.map(v => ({ id: v.id, score: v.fit })))) }),
  judgeInput: prompt,
  renderOutput: (verdicts, fixture) => {
    const byId = new Map(verdicts.map(v => [v.id, v]))
    return fixture.postings
      .map(p => {
        const v = byId.get(p.id)
        const head = `${p.id} (${p.title} @ ${p.company})`
        return v
          ? `${head} | ${v.fit} | ${v.reason} | ${v.mismatches.join('; ') || 'none'}`
          : `${head} | NOT SCORED`
      })
      .join('\n')
  },
  criteria: [
    'Fit follows the anchored bands, judged against what the CV shows they have actually done and what ' +
    'the search says they want now. A posting that hits a stated dealbreaker, misses a must-have, or ' +
    'falls below the pay floor cannot score 70 or more.',
    'The scores discriminate: the postings that suit this person are clearly separated from the ones ' +
    'that do not. A batch scored mostly in one narrow range, when the postings differ, is a failure.',
    'Mismatches name real gaps on the listed axes with specifics from the posting and the CV — including ' +
    'on high scorers — and never invent a gap the posting does not support.',
    'Each reason is concrete and about this posting, at most 20 words. "Good match for their skills" fails.',
  ],
  caveats: () => [
    'No reader verdicts exist for jobs, so nothing here is ground truth. `ρ stored` is rank agreement with ' +
    'what the previous scorer stored — a different scale shows up there, a better model does not.',
    '`over bar` counts postings at or above the search\'s delivery bar; `hi w/ mism` is the share of ' +
    'fits ≥ 70 that came with at least one mismatch; `off axis` counts mismatches naming an axis the ' +
      'prompt does not list — format, not quality; `spread` is run-to-run movement, lower is steadier.',
  ],
}
