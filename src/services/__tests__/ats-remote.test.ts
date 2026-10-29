import { describe, expect, it } from 'vitest'

import { remoteFrom } from '../ats.js'

const silent = 'You will build our billing platform with a small team.'
const saysRemote = 'Elastic is a distributed company — this role is fully remote.'

describe('remoteFrom — explicit words in the location win', () => {
  it('reads the remote words, the British "home based" among them', () => {
    expect(remoteFrom('Remote - EMEA', silent)).toBe('remote')
    expect(remoteFrom('Anywhere', silent)).toBe('remote')
    expect(remoteFrom('Home Based - Americas; Office Based - London, UK', silent)).toBe('remote')
  })

  it('reads an explicit on-site marker as on-site, whatever the advert says', () => {
    expect(remoteFrom('In-Office', saysRemote)).toBe('onsite')
    expect(remoteFrom('Office Based - London, UK', saysRemote)).toBe('onsite')
    expect(remoteFrom('On-site, Berlin', silent)).toBe('onsite')
    expect(remoteFrom('Onsite', silent)).toBe('onsite')
  })

  it('leaves hybrid unknown, for the model to judge', () => {
    expect(remoteFrom('Hybrid - San Francisco, New York City', silent)).toBe('unknown')
  })
})

describe('remoteFrom — a bare place is decided by the advert', () => {
  it('a place whose advert mentions remote is unknown — Elastic posts remote roles per country', () => {
    expect(remoteFrom('Spain', saysRemote)).toBe('unknown')
    expect(remoteFrom('San Francisco, California', 'Held from a US hub or remotely in the US.')).toBe('unknown')
  })

  it('a place whose advert never mentions remote is on-site', () => {
    expect(remoteFrom('Spain', silent)).toBe('onsite')
    expect(remoteFrom('San Francisco, California', null)).toBe('onsite')
  })

  it('"Home Office" is not read as remote — it is also how a US employer names its headquarters', () => {
    expect(remoteFrom('Home Office (Bentonville)', silent)).toBe('onsite')
  })
})

describe('remoteFrom — the board flag and an absent location', () => {
  it('the board flag wins, and no location is unknown', () => {
    expect(remoteFrom('In-Office', silent, true)).toBe('remote')
    expect(remoteFrom(null, silent)).toBe('unknown')
  })
})
