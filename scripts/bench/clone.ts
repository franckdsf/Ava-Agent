/**
 * A candidate model wearing the real agent's prompt and provider options.
 *
 * Lifted from the old `models:check` script, where it was proven: the clone is built from
 * `getInstructions()` and `getDefaultOptions()`, registered under the REAL id in
 * a throwaway Mastra, and the real function resolves it through
 * `mastra.getAgent(id)` without knowing it is being measured. The model and the
 * reasoning effort are the only things that change — everything else a bench
 * row says is about the code path that runs in production.
 */
import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'

/**
 * How hard an entrant is asked to think.
 *
 * `'shipped'` is whatever the real agent's `defaultOptions` send today, which is
 * often nothing at all — the provider's own default. It is the only honest
 * setting for the incumbent: a table comparing against the incumbent at an
 * effort production never uses answers a question nobody asked.
 *
 * `false` is reasoning off. `'low' | 'medium' | 'high'` are OpenRouter's levels,
 * each provider mapping them to a budget of its own. A number is that budget
 * said directly (`reasoning.max_tokens`) — the only way to ask two vendors to
 * think for the same amount rather than for the same adjective.
 */
export type Effort = 'shipped' | false | 'low' | 'medium' | 'high' | number

/**
 * How OpenRouter picks among the endpoints serving a model. A different
 * question from which model: the same model has measured 0.8s on one endpoint
 * and 46s on another, so for a call a reader waits on, routing can matter more
 * than the model does.
 */
export type Sort = 'price' | 'latency' | 'throughput'

/**
 * A model, the efforts to enter it at, and optionally the routings. Each
 * effort × routing is ranked as its own entrant. Without `sorts` the entrant
 * routes as the real agent does — or by price, when the agent says nothing.
 */
export interface Candidate {
  model: string
  efforts: readonly Effort[]
  sorts?: readonly Sort[]
}

/** One call to the model, as OpenRouter billed it. A retried call is several of these. */
export interface Call {
  ms: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  /** USD as OpenRouter reported it; `undefined` when it did not — never 0, which would read as free. */
  cost: number | undefined
  error?: string
}

/** What OpenRouter is sent under `reasoning` for an effort, or `undefined` to leave the agent's own. */
export function reasoningFor(effort: Effort): Record<string, unknown> | undefined {
  if (effort === 'shipped') return undefined
  if (effort === false) return { enabled: false }
  return typeof effort === 'number' ? { enabled: true, max_tokens: effort } : { enabled: true, effort }
}

/**
 * The provider options a clone sends: the real agent's, with the effort
 * replaced, the routing production would use, and usage accounting on.
 *
 * **An entrant routes as production would**: the entrant's own `sort` when the
 * field names one, else the agent's, else cheapest-first — the repo's default
 * for anything not waited on. A model chosen on one routing and run on another
 * is a latency and a price nobody measured. The rest of the agent's provider
 * block (an `only` fence, say) survives. Usage accounting is what makes the cost
 * column what OpenRouter actually charged, at whichever provider it routed to,
 * rather than a list price multiplied by a guess.
 */
export function cloneProviderOptions(
  shipped: Record<string, Record<string, unknown>> | undefined,
  effort: Effort,
  sort?: Sort,
): Record<string, Record<string, unknown>> {
  const openrouter = { ...(shipped?.openrouter ?? {}) }
  const reasoning = reasoningFor(effort)
  if (reasoning) openrouter.reasoning = reasoning
  const provider = openrouter.provider as Record<string, unknown> | undefined
  openrouter.provider = {
    ...provider,
    sort: sort ?? provider?.sort ?? 'price',
    // Only endpoints that honour every parameter sent — the effort being
    // measured and the structured-output format. Without it the cheapest
    // endpoint can drop the effort silently, and the row measures something
    // other than its label.
    require_parameters: true,
  }
  openrouter.usage = { include: true }
  return { ...shipped, openrouter }
}

/** The cost OpenRouter reported for one call, read off a Mastra result. */
export function reportedCost(metadata: unknown): number | undefined {
  const cost = (metadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage
    ?.cost
  return typeof cost === 'number' ? cost : undefined
}

/**
 * An agent that records every call it makes.
 *
 * A subclass, not a wrapper, because the real function resolves its agent with
 * `mastra.getAgent` — the measured one has to *be* an Agent to be registered.
 * A call that throws is recorded too, with no tokens: `withRetry` is about to
 * try again, and the table counts that retry against the model.
 *
 * `signal` aborts every call this agent makes, so a timeout covers the retries
 * as well as the first attempt.
 */
export class Measured extends Agent {
  readonly calls: Call[] = []
  signal: AbortSignal | undefined

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async generate(...args: any[]): Promise<any> {
    const [messages, options = {}] = args
    const started = performance.now()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (super.generate as any)(messages, { ...options, abortSignal: this.signal })
      const usage = response?.usage ?? {}
      this.calls.push({
        ms: performance.now() - started,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        cost: reportedCost(response?.providerMetadata),
      })
      return response
    } catch (error) {
      this.calls.push({
        ms: performance.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cost: undefined,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}

/**
 * A Mastra holding one measured clone under the real agent's id.
 *
 * `logger: false` because the real functions log each failed attempt as a
 * warning, and in a field of thirty calls that is noise over the progress
 * lines — the attempt is recorded in `calls` and reaches the table anyway.
 */
export async function clone(
  agent: Agent,
  agentId: string,
  model: string,
  effort: Effort,
  sort?: Sort,
): Promise<{ mastra: Mastra; measured: Measured }> {
  const defaults = await agent.getDefaultOptions()
  const measured = new Measured({
    id: agentId,
    name: agentId,
    model,
    instructions: await agent.getInstructions(),
    // The provider options and the model settings are carried over — the job
    // writer's output cap is part of what it costs and what can truncate it. The
    // rest of what `getDefaultOptions` resolves is Mastra's own defaulting, and
    // re-passing it would pin the bench to today's internals.
    defaultOptions: {
      providerOptions: cloneProviderOptions(
        defaults.providerOptions as Record<string, Record<string, unknown>> | undefined,
        effort,
        sort,
      ),
      ...(defaults.modelSettings ? { modelSettings: defaults.modelSettings } : {}),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  return { mastra: new Mastra({ agents: { [agentId]: measured }, logger: false }), measured }
}
