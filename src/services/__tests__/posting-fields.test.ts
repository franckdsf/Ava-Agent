import { describe, expect, it } from 'vitest'

import { jobPipeline } from '../../config/jobs.js'
import { clean, parseDate, truncate } from '../posting-fields.js'

describe('parseDate', () => {
  it('reads epoch seconds and epoch milliseconds alike — boards send both', () => {
    expect(parseDate(1_760_000_000)).toBe(1_760_000_000_000)
    expect(parseDate(1_760_000_000_000)).toBe(1_760_000_000_000)
  })

  it('parses a printed date, and is null for blank or unparseable', () => {
    expect(parseDate('2026-10-13T10:00:00Z')).toBe(Date.parse('2026-10-13T10:00:00Z'))
    expect(parseDate('   ')).toBeNull()
    expect(parseDate('soon')).toBeNull()
    expect(parseDate(undefined)).toBeNull()
  })
})

describe('clean and truncate', () => {
  it('trims to a string or null, and cuts a description to the configured length', () => {
    expect(clean('  Acme  ')).toBe('Acme')
    expect(clean('   ')).toBeNull()
    expect(clean(42)).toBeNull()
    expect(truncate('x'.repeat(jobPipeline.maxDescriptionChars + 10))).toHaveLength(jobPipeline.maxDescriptionChars)
    expect(truncate(null)).toBeNull()
  })
})
