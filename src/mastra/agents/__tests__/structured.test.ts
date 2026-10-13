import type { Agent } from '@mastra/core/agent'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { structured } from '../structured.js'

const schema = z.object({ text: z.string() })

/**
 * An agent whose `generate` plays back one scripted outcome per call: an object
 * is a parsed answer, `null` an answer that did not parse, an Error a throw — the
 * shape `generate()` takes on a schema mismatch.
 */
function scripted(...outcomes: ({ text: string } | null | Error)[]) {
  const calls: unknown[] = []
  const agent = {
    generate: async (input: unknown) => {
      calls.push(input)
      const next = outcomes.shift()
      if (next instanceof Error) throw next
      return { object: next ?? undefined }
    },
  } as unknown as Agent
  return { agent, calls }
}

describe('structured', () => {
  it('asks once when the first answer is good', async () => {
    const { agent, calls } = scripted({ text: 'good' })
    expect(await structured(agent, 'prompt', schema, { attempts: 3 })).toEqual({ text: 'good' })
    expect(calls).toEqual(['prompt'])
  })

  it('asks again after an answer that did not parse', async () => {
    const { agent, calls } = scripted(null, { text: 'good' })
    expect(await structured(agent, 'prompt', schema, { attempts: 2 })).toEqual({ text: 'good' })
    expect(calls).toHaveLength(2)
  })

  it('counts a throw as a failed attempt, and reports it', async () => {
    const { agent } = scripted(new Error('schema mismatch'), { text: 'good' })
    const failures: [number, unknown][] = []
    const result = await structured(agent, 'prompt', schema, {
      attempts: 2,
      onAttemptFailed: (attempt, error) => failures.push([attempt, error]),
    })
    expect(result).toEqual({ text: 'good' })
    expect(failures).toHaveLength(1)
    expect(failures[0]?.[0]).toBe(1)
    expect(String(failures[0]?.[1])).toMatch(/schema mismatch/)
  })

  it('retries an answer that parsed but was rejected', async () => {
    const { agent, calls } = scripted({ text: 'bad' }, { text: 'good' })
    const result = await structured(agent, 'prompt', schema, {
      attempts: 2,
      reject: object => (object.text === 'bad' ? 'it said bad' : null),
    })
    expect(result).toEqual({ text: 'good' })
    expect(calls).toHaveLength(2)
  })

  it('returns null once every attempt failed, and asks no more than it was told', async () => {
    const { agent, calls } = scripted(null, null, { text: 'too late' })
    expect(await structured(agent, 'prompt', schema, { attempts: 2 })).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('with orThrow, throws the caller’s message carrying the real failure', async () => {
    const failure = new Error('402 insufficient credits')
    const { agent } = scripted(failure)
    const call = structured(agent, 'prompt', schema, { attempts: 1, orThrow: 'The namer failed' })
    await expect(call).rejects.toThrow('The namer failed (402 insufficient credits)')
    await expect(call).rejects.toHaveProperty('cause', failure)
  })

  it('with orThrow and no attempt made, says so rather than "undefined"', async () => {
    const { agent } = scripted()
    await expect(structured(agent, 'prompt', schema, { attempts: 0, orThrow: 'The namer failed' })).rejects.toThrow(
      'The namer failed (no attempt was made)',
    )
  })
})
