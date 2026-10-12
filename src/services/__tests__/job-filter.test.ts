import { describe, expect, it } from 'vitest'

import type { Job, JobSearch } from '../../db/schema.js'
import { filterJob } from '../job-filter.js'

const search = (overrides: Partial<JobSearch> = {}): JobSearch => ({
  label: 'x', request: 'x', domain: null, locations: [], remote: 'any', seniority: [],
  contractTypes: [], mustHave: [], dealbreakers: [], minCompensation: null, currency: null, notes: null,
  ...overrides,
}) as unknown as JobSearch
const job = (description: string, title = 'Software Engineer'): Job => ({
  title, company: 'Acme', location: null, remote: 'remote', description, listedRoles: null,
}) as unknown as Job

const keeps = (description: string, mustHave: string[]) => filterJob(job(description), search({ mustHave }), []).keep

describe('mustHave — any one term, mentioned as a word', () => {
  it('a posting mentioning one of the terms is kept, not only one mentioning all', () => {
    expect(keeps('We write Rust.', ['Go', 'Rust'])).toBe(true)
  })
  it('a short term is not found inside a longer word', () => {
    expect(keeps('A good role at a Google-scale company, posted a week ago.', ['Go'])).toBe(false)
    expect(keeps('We aim high.', ['AI'])).toBe(false)
  })
  it('a short term is found as a word, and as its plural', () => {
    expect(keeps('Backend in Go, Postgres.', ['Go'])).toBe(true)
    expect(keeps('You will design APIs.', ['API'])).toBe(true)
  })
  it('no term is found where it does not start a word', () => {
    expect(keeps('Built on trust.', ['Rust'])).toBe(false)
  })
  it('a long term may run on — the bias is toward keeping', () => {
    expect(keeps('ReactJS front end.', ['React'])).toBe(true)
  })
  it('an edge that is punctuation needs no boundary', () => {
    expect(keeps('ASP.NET and C++ services.', ['.NET'])).toBe(true)
    expect(keeps('ASP.NET and C++ services.', ['C++'])).toBe(true)
  })
  it('case does not matter', () => {
    expect(keeps('TYPESCRIPT everywhere.', ['typescript'])).toBe(true)
  })
})

describe('dealbreakers — the same matcher, and the reason names the hit', () => {
  it('a dealbreaker as a word rejects, and says which', () => {
    const verdict = filterJob(job('Our Consulting arm.'), search({ dealbreakers: ['agency', 'consulting'] }), [])
    expect(verdict).toEqual({ keep: false, reason: 'mentions "consulting", which you ruled out' })
  })
  it('a short dealbreaker inside a longer word does not reject', () => {
    expect(filterJob(job('Our goal is speed.'), search({ dealbreakers: ['Go'] }), []).keep).toBe(true)
  })
})
