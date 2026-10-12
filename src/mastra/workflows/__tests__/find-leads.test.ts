import { describe, expect, it } from 'vitest'

import type { ClientProfile, Lead, LeadSignal } from '../../../db/schema.js'
import { renderLeadMessage } from '../find-leads.js'

const profile = (overrides: Partial<ClientProfile> = {}): ClientProfile => ({
  slug: 'dtc', label: 'DTC brands', request: 'x', offer: 'product photography',
  industries: [], locations: [], signalKinds: [], dealbreakers: [],
  minDealSize: null, currency: null, notes: null, fitThreshold: null,
  createdAt: 0, updatedAt: 0, archivedAt: null, ...overrides,
})
const lead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'acme.com', company: 'Acme', location: null, url: 'https://acme.com',
  pageText: 'We make skincare.', pageFetchedAt: 1, visionVerdict: null, visionAt: null,
  discoveredAt: 0, lastSignalAt: 0, ...overrides,
})

/**
 * The ack is a race between a timer and the parse, and both orderings matter: a fast parse must
 * stay ONE message, a slow one must promise before it answers.
 *
 * @limitation This tests a copy of the race, not the real one in `src/mastra/commands/clients.ts`,
 * so it stays green whatever happens there. **Accepted because** it was moved verbatim from
 * `check-leads.ts` (slice 1 changes no assertion). **The fix** is to extract the timer race from
 * `clients.ts` into a function and test that, beside it — slice 5 opens that file anyway.
 */
describe('acknowledgement — silence is what makes a reader retype the command', () => {
  const sent: string[] = []
  const send = async (text: string) => {
    sent.push(text.slice(0, 24))
  }
  const run = async (parseMs: number, ackAfterMs: number) => {
    sent.length = 0
    let acked: Promise<unknown> | null = null
    const timer = setTimeout(() => {
      acked = send('WORKING…')
    }, ackAfterMs)
    const text = await new Promise<string>(resolve => setTimeout(() => resolve('RESULT'), parseMs))
    clearTimeout(timer)
    if (acked) await acked
    await send(text)
    return [...sent]
  }

  it('a fast parse stays one message', async () => {
    expect(await run(5, 60)).toEqual(['RESULT'])
  })
  it('a slow parse promises, then answers — in that order', async () => {
    expect(await run(60, 5)).toEqual(['WORKING…', 'RESULT'])
  })
})

describe('message — structure from the template, prose from the model', () => {
  const signal: LeadSignal = {
    id: 's1', leadId: 'acme.com', kind: 'funding',
    sourceUrl: 'https://news.example.com/acme-raises', origin: 'feed',
    occurredAt: Date.now(), summary: 'Raised $4M seed', discoveredAt: Date.now(),
  }
  const message = renderLeadMessage(lead({ location: 'Paris' }), profile(), signal, 82, {
    summary: 'They just raised and sell skincare direct.',
    angle: 'Your three product shots are lit differently.',
    watchOuts: ['size: 4 people'],
  })

  it('links the company, not the signal, in the heading', () => {
    expect(message.startsWith('## 🎯 [Acme](https://acme.com)')).toBe(true)
  })
  it('the angle is a blockquote the reader can copy', () => {
    expect(message.includes('> Your three product shots')).toBe(true)
  })
  it('the footer names the signal and the profile', () => {
    expect(message.includes('Paris · just raised · DTC brands · fit 82')).toBe(true)
  })
  it('no single-newline soft wraps between blocks', () => {
    expect(/[^\n]\n[^\n>\-_*#]/.test(message.replace(/^- .*$/gm, ''))).toBe(false)
  })
})
