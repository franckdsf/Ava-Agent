import { describe, expect, it } from 'vitest'

import { cleanCompanyName, cleanScoutText, parseEventDate } from '../lead-scout.js'

// Defects the FIRST live run produced, not hypotheticals.
describe('scout — text the model wrote is cleaned before it reaches a message', () => {
  it('citation markers are stripped — they reached the message on run 1', () => {
    expect(cleanScoutText('Raised $4M to expand its DTC range.[24][23][29]', 220)).toBe('Raised $4M to expand its DTC range.')
  })
  it('grouped citations too', () => {
    expect(cleanScoutText('Launched a store.[24, 25]', 220)).toBe('Launched a store.')
  })
  it('a bracketed year is not a citation', () => {
    expect(cleanScoutText('Founded [2019] in Lyon', 220)).toBe('Founded [2019] in Lyon')
  })
  it('a long summary is cut on a word boundary, visibly', () => {
    expect(cleanScoutText('a'.repeat(20) + ' ' + 'b'.repeat(300), 50).endsWith('…')).toBe(true)
  })
  it('a parent company is dropped from the name', () => {
    expect(cleanCompanyName('Tome Skincare (Dermata Therapeutics)')).toBe('Tome Skincare')
  })
  it('a name that is only a parenthetical survives', () => {
    expect(cleanCompanyName('(Stealth)')).toBe('(Stealth)')
  })
})

describe('scout — dates are read strictly', () => {
  it('a full date parses', () => {
    expect(parseEventDate('2026-08-01')).not.toBeNull()
  })
  it('a bare year is refused, not read as January 1st', () => {
    expect(parseEventDate('2026')).toBeNull()
  })
  it('prose is refused', () => {
    expect(parseEventDate('last week')).toBeNull()
  })
  it('a malformed date is refused', () => {
    expect(parseEventDate('2026-8-1')).toBeNull()
  })
})
