import { describe, expect, it } from 'vitest'

import { PLATFORM_HOSTS } from '../../config/leads.js'
import { canonicalizeSourceUrl, isPlatformHost, normalizeHost, sameCompany, signalId } from '../lead-identity.js'

// ADR-0038: every case is one the ADR argues about, so a regression here is a regression against a
// recorded decision rather than against a guess.

describe('identity — one company, one row', () => {
  it('strips scheme, www, path and query', () => {
    expect(normalizeHost('https://www.acme.com/blog/x?utm=1')).toBe('acme.com')
  })
  it('a subdomain is the same company', () => {
    expect(normalizeHost('https://shop.acme.com')).toBe('acme.com')
  })
  it('keeps a multi-part suffix intact', () => {
    expect(normalizeHost('https://shop.acme.co.uk/a')).toBe('acme.co.uk')
  })
  it('an unparseable url is not a lead', () => {
    expect(normalizeHost('not a url')).toBeNull()
  })
  it('a bare IP is a server, not a company', () => {
    expect(normalizeHost('http://192.168.1.4/')).toBeNull()
  })
  it('a single-label host is not a company', () => {
    expect(normalizeHost('http://localhost/')).toBeNull()
  })
})

describe('identity — the platform-host trap (the one that fails silently)', () => {
  it('a Shopify tenant keeps its subdomain', () => {
    expect(normalizeHost('https://acme.myshopify.com/products/x')).toBe('acme.myshopify.com')
  })
  it('two tenants stay two leads', () => {
    expect([normalizeHost('https://acme.myshopify.com'), normalizeHost('https://other.myshopify.com')]).toEqual([
      'acme.myshopify.com',
      'other.myshopify.com',
    ])
  })
  it('a bare platform domain is dropped, not stored', () => {
    expect(normalizeHost('https://myshopify.com')).toBeNull()
  })
  it('a lookalike host is not a tenant', () => {
    expect(normalizeHost('https://notmyshopify.com/x')).toBe('notmyshopify.com')
  })
  it('every listed platform is recognised', () => {
    expect(PLATFORM_HOSTS.every(host => isPlatformHost(`tenant.${host}`))).toBe(true)
  })
})

describe('signals — syndication collapses to one row', () => {
  const a = signalId('acme.com', 'funding', 'https://news.example.com/acme-raises?utm_source=x')

  it('tracking params and www do not split a signal', () => {
    expect(signalId('acme.com', 'funding', 'https://www.news.example.com/acme-raises/#top')).toBe(a)
  })
  it('a different event is a different signal', () => {
    expect(signalId('acme.com', 'launch', 'https://news.example.com/acme-raises')).not.toBe(a)
  })
  it('canonical form is stable', () => {
    expect(canonicalizeSourceUrl('http://WWW.News.example.com/a/?utm_source=x&id=7')).toBe(
      'https://news.example.com/a?id=7',
    )
  })
})

describe('clustering — a merge needs a name AND a location', () => {
  it('same name, same place merges', () => {
    expect(sameCompany({ company: 'Acme SAS', location: 'Paris' }, { company: 'acme sas', location: 'paris' })).toBe(true)
  })
  it('same name, no location refuses', () => {
    expect(sameCompany({ company: 'Atlas', location: null }, { company: 'Atlas', location: 'Berlin' })).toBe(false)
  })
  it('same name, different place refuses', () => {
    expect(sameCompany({ company: 'Atlas', location: 'Lyon' }, { company: 'Atlas', location: 'Berlin' })).toBe(false)
  })
})
