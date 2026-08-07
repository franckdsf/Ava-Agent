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
): Promise<T | null> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await run()
      if (response.object) return response.object as T
      lastError = new Error('the model returned no parseable object')
    } catch (error) {
      lastError = error
    }
    onAttemptFailed?.(attempt, lastError)
  }
  return null
}
