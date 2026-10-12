/**
 * Retrying a *malformed answer*, which is not what any layer below this retries.
 *
 * `modelSettings.maxRetries` covers a failed HTTP call; `structuredOutput.
 * errorStrategy: 'fallback'` substitutes a value without asking again. Neither
 * re-prompts a model that answered badly, and re-prompting is exactly the right
 * response to the two failures measured here — a JSON body truncated mid-string,
 * and an answer wrapped under a key the schema never named. Both are stochastic
 * per call, so the same prompt usually succeeds on the next attempt.
 *
 * `generate()` **throws** on a schema mismatch rather than returning a null
 * `object`, so the `?? fallback` pattern used elsewhere in this repo does not
 * catch it. That is what made a single bad response take down a whole step and
 * lose every other item in the batch — first in job delivery, then again in news
 * ranking on 2026-08-07.
 *
 * Returns null when every attempt failed. The caller decides what that means:
 * for a writer it is a degraded message, for a ranker or scorer it is a batch
 * left untouched so the next run can retry it whole.
 *
 * Lives here rather than beside one caller because both pipelines need it — it
 * was `agents/job-scorer.ts`-local until the news ranker hit the same wall.
 */
export async function withRetry<T>(
  attempts: number,
  run: () => Promise<{ object?: unknown }>,
  onAttemptFailed?: (attempt: number, error: unknown) => void,
  reject?: (object: T) => string | null,
): Promise<T | null> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await run()
      // A parsed object can still be unusable in a way no schema expresses —
      // `reject` names why, and the answer is retried like an unparseable one.
      const rejected = response.object ? reject?.(response.object as T) : null
      if (response.object && !rejected) return response.object as T
      lastError = new Error(rejected ?? 'the model returned no parseable object')
    } catch (error) {
      lastError = error
    }
    onAttemptFailed?.(attempt, lastError)
  }
  return null
}

/**
 * Characters tolerated between a leaked key and the `=` or `:` opening its value.
 * Three because the one measured was `watchOutsる=[` — one stray character — and
 * a guard tuned to exactly one would miss the next variant by a byte.
 */
const LEAK_KEY_JUNK_CHARS = 3

/** How much of the offending field a rejection quotes in the retry warning. */
const LEAK_EXCERPT_CHARS = 60

/**
 * Why a writer's parsed answer still carries its own JSON, or null when it does
 * not.
 *
 * Measured on 2026-10-12 (`pnpm bench job-writer`): gpt-5.6-luna, reasoning on,
 * twice returned a `fits` array whose last real element ended `…experience.],`
 * followed by an element that was the next key — `watchOuts`, once
 * `watchOutsる=[`. The model broke its own JSON and the provider's parser
 * recovered it into extra strings. Every field is still a string, so the schema
 * accepts it, and the brief reached Telegram with the debris in it.
 *
 * Two shapes, both from those answers: a field ending in a closing bracket or
 * brace, and a field that is a schema key — alone, or followed by the `=`/`:`
 * that opens its value. Keys are matched case-sensitively and only in those
 * positions, so prose saying "in summary:" or "it fits your stack" passes.
 */
export function leakedStructure(fields: string[], keys: string[]): string | null {
  // Schema keys are plain identifiers; anything else would change the pattern's
  // meaning once interpolated, so it is skipped rather than escaped.
  const patterns = keys
    .filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(key => ({
      key,
      alone: new RegExp(`^\\s*"?${key}"?\\s*$`),
      opening: new RegExp(`(^|[^A-Za-z])"?${key}"?[^\\sA-Za-z0-9]{0,${LEAK_KEY_JUNK_CHARS}}\\s*(=|":|:\\s*[\\[{"])`),
    }))
  for (const field of fields) {
    if (/[\]}]\s*,?\s*$/.test(field)) {
      return `a field ends in JSON punctuation: "${field.slice(-LEAK_EXCERPT_CHARS)}"`
    }
    const hit = patterns.find(p => p.alone.test(field) || p.opening.test(field))
    if (hit) return `a field carries the schema key "${hit.key}": "${field.slice(0, LEAK_EXCERPT_CHARS)}"`
  }
  return null
}
