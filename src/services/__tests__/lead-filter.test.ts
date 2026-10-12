import { describe, expect, it } from 'vitest'

import type { ClientProfile, Lead } from '../../db/schema.js'
import { filterLead } from '../lead-filter.js'

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

describe('filter — two rules, and a missing fact is not a rejection', () => {
  it('a clean lead passes', () => {
    expect(filterLead(lead(), profile()).keep).toBe(true)
  })
  it('a dealbreaker in the page rejects', () => {
    expect(filterLead(lead({ pageText: 'We are a crypto exchange.' }), profile({ dealbreakers: ['crypto'] })).keep).toBe(false)
  })
  it('a dealbreaker in the name rejects', () => {
    expect(filterLead(lead({ company: 'Acme Agency' }), profile({ dealbreakers: ['agency'] })).keep).toBe(false)
  })
  it('no location stated is KEPT, not rejected', () => {
    expect(filterLead(lead({ location: null }), profile({ locations: ['Paris'] })).keep).toBe(true)
  })
  it('a stated wrong location rejects', () => {
    expect(filterLead(lead({ location: 'Berlin' }), profile({ locations: ['Paris'] })).keep).toBe(false)
  })
  it('a stated right location passes', () => {
    expect(filterLead(lead({ location: 'Paris' }), profile({ locations: ['Paris'] })).keep).toBe(true)
  })
})
