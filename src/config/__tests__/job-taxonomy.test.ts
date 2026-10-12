import { describe, expect, it } from 'vitest'

import { knownSeniority, seniorityIds } from '../job-taxonomy.js'

describe('seniority vocabulary', () => {
  it('keeps the bands the filter knows and drops the rest', () => {
    expect(knownSeniority(['Senior', 'director', 'manager', 'senior', 'rockstar'])).toEqual(['senior', 'manager'])
  })

  it('offers the targeter exactly the filter\'s bands, "director" not among them', () => {
    expect(seniorityIds()).toContain('manager')
    expect(seniorityIds()).not.toContain('director')
  })
})
