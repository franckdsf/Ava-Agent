import type { Agent } from '@mastra/core/agent'
import type { z } from 'zod'

import { withRetry } from '../../services/structured-output.js'

/** What a caller states about one structured call. */
type StructuredOptions<S extends z.ZodType> = {
  /** How many times to ask. Required, so `1` is a choice written down, not a default. */
  attempts: number
  /** Why a parsed answer is still unusable — retried like an unparseable one. */
  reject?: (object: z.infer<S>) => string | null
  onAttemptFailed?: (attempt: number, error: unknown) => void
}

/**
 * The one place this repo asks a model for an answer. Every agent call in `src/`
 * comes through here, and C5 refuses a `.generate(` anywhere else.
 *
 * It is `withRetry` around `agent.generate(input, { structuredOutput: { schema } })`,
 * nothing more. What it adds is the place: `attempts` is required, so how many
 * times each call asks is written at the call site instead of drifting — `/target`
 * asked once while its twin `/client` asked twice, and nobody had chosen that.
 *
 * Returns null when every attempt failed; the caller decides what that means.
 * With `orThrow`, it throws that message instead, carrying the last attempt's
 * error — so a call that fails on a 402 or a timeout is logged as one, not as
 * "the model returned junk".
 */
export function structured<S extends z.ZodType>(
  agent: Agent<any, any, any, any>,
  input: Parameters<Agent['generate']>[0],
  schema: S,
  options: StructuredOptions<S> & { orThrow: string },
): Promise<z.infer<S>>
export function structured<S extends z.ZodType>(
  agent: Agent<any, any, any, any>,
  input: Parameters<Agent['generate']>[0],
  schema: S,
  options: StructuredOptions<S> & { orThrow?: undefined },
): Promise<z.infer<S> | null>
export async function structured<S extends z.ZodType>(
  agent: Agent<any, any, any, any>,
  input: Parameters<Agent['generate']>[0],
  schema: S,
  options: StructuredOptions<S> & { orThrow?: string },
): Promise<z.infer<S> | null> {
  let lastError: unknown
  const object = await withRetry<z.infer<S>>(
    options.attempts,
    () => agent.generate(input, { structuredOutput: { schema } }),
    (attempt, error) => {
      lastError = error
      options.onAttemptFailed?.(attempt, error)
    },
    options.reject,
  )
  if (object !== null || options.orThrow === undefined) return object
  const reason =
    lastError === undefined
      ? 'no attempt was made'
      : lastError instanceof Error
        ? lastError.message
        : String(lastError)
  throw new Error(`${options.orThrow} (${reason})`, { cause: lastError })
}
