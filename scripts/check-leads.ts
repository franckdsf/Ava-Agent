import { PLATFORM_HOSTS, leadPipeline, leadScout } from '../src/config/leads.js'
import { jobScout } from '../src/config/jobs.js'
import { cleanCompanyName, cleanScoutText, parseEventDate } from '../src/services/lead-scout.js'
import { filterLead } from '../src/services/lead-filter.js'
import {
  canonicalizeSourceUrl,
  isPlatformHost,
  normalizeHost,
  sameCompany,
  signalId,
} from '../src/services/lead-identity.js'
import { imageUrlsFrom, isNotACompanyHost } from '../src/services/lead-signals.js'
import { renderLeadMessage } from '../src/mastra/workflows/find-leads.js'
import type { ClientProfile, Lead, LeadSignal } from '../src/db/schema.js'

/**
 * Exercises the leads pipeline's deterministic parts, offline
 * ([ADR-0038](../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
 *
 * No network, no model, no database. What it checks is the half of the pipeline
 * that decides what a lead *is* — and every case below is one the ADR argues
 * about, so a regression here is a regression against a recorded decision rather
 * than against a guess.
 *
 * `pnpm leads:check`
 */

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  const mark = ok ? '✓' : '✗'
  const detail = ok ? '' : `\n     expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  console.log(`  ${mark} ${label}${detail}`)
}

console.log('\nIdentity — one company, one row')
check('strips scheme, www, path and query', normalizeHost('https://www.acme.com/blog/x?utm=1'), 'acme.com')
check('a subdomain is the same company', normalizeHost('https://shop.acme.com'), 'acme.com')
check('keeps a multi-part suffix intact', normalizeHost('https://shop.acme.co.uk/a'), 'acme.co.uk')
check('an unparseable url is not a lead', normalizeHost('not a url'), null)
check('a bare IP is a server, not a company', normalizeHost('http://192.168.1.4/'), null)
check('a single-label host is not a company', normalizeHost('http://localhost/'), null)

console.log('\nIdentity — the platform-host trap (the one that fails silently)')
check('a Shopify tenant keeps its subdomain', normalizeHost('https://acme.myshopify.com/products/x'), 'acme.myshopify.com')
check('two tenants stay two leads', [
  normalizeHost('https://acme.myshopify.com'),
  normalizeHost('https://other.myshopify.com'),
], ['acme.myshopify.com', 'other.myshopify.com'])
check('a bare platform domain is dropped, not stored', normalizeHost('https://myshopify.com'), null)
check('a lookalike host is not a tenant', normalizeHost('https://notmyshopify.com/x'), 'notmyshopify.com')
check('every listed platform is recognised', PLATFORM_HOSTS.every(host => isPlatformHost(`tenant.${host}`)), true)

console.log('\nHosts — a posting URL is usually not an employer')
check('a job board is not a company', isNotACompanyHost('weworkremotely.com'), true)
check('an ATS host is not a company', isNotACompanyHost('boards.greenhouse.io'), true)
check('HN is not a company — 211 postings had collapsed into one lead', isNotACompanyHost('ycombinator.com'), true)
check('a store platform is not a company', isNotACompanyHost('myshopify.com'), true)
check('a real employer is a company', isNotACompanyHost('stripe.com'), false)

console.log('\nSignals — syndication collapses to one row')
const a = signalId('acme.com', 'funding', 'https://news.example.com/acme-raises?utm_source=x')
const b = signalId('acme.com', 'funding', 'https://www.news.example.com/acme-raises/#top')
check('tracking params and www do not split a signal', a, b)
check('a different event is a different signal', signalId('acme.com', 'launch', 'https://news.example.com/acme-raises') !== a, true)
check('canonical form is stable', canonicalizeSourceUrl('http://WWW.News.example.com/a/?utm_source=x&id=7'), 'https://news.example.com/a?id=7')

console.log('\nClustering — a merge needs a name AND a location')
check('same name, same place merges', sameCompany({ company: 'Acme SAS', location: 'Paris' }, { company: 'acme sas', location: 'paris' }), true)
check('same name, no location refuses', sameCompany({ company: 'Atlas', location: null }, { company: 'Atlas', location: 'Berlin' }), false)
check('same name, different place refuses', sameCompany({ company: 'Atlas', location: 'Lyon' }, { company: 'Atlas', location: 'Berlin' }), false)

console.log('\nFilter — two rules, and a missing fact is not a rejection')
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
check('a clean lead passes', filterLead(lead(), profile()).keep, true)
check('a dealbreaker in the page rejects', filterLead(lead({ pageText: 'We are a crypto exchange.' }), profile({ dealbreakers: ['crypto'] })).keep, false)
check('a dealbreaker in the name rejects', filterLead(lead({ company: 'Acme Agency' }), profile({ dealbreakers: ['agency'] })).keep, false)
check('no location stated is KEPT, not rejected', filterLead(lead({ location: null }), profile({ locations: ['Paris'] })).keep, true)
check('a stated wrong location rejects', filterLead(lead({ location: 'Berlin' }), profile({ locations: ['Paris'] })).keep, false)
check('a stated right location passes', filterLead(lead({ location: 'Paris' }), profile({ locations: ['Paris'] })).keep, true)

console.log('\nImages — what reaches the expensive model')
const html = `
  <meta property="og:image" content="/hero.jpg">
  <img src="https://cdn.example.com/logo.svg">
  <img src="/img/icon-cart.png">
  <img src="/img/product-1.jpg">
  <img src="data:image/png;base64,AAA">
  <img src="/img/product-2.jpg">`
const images = imageUrlsFrom(html, 'https://acme.com/shop')
check('og:image comes first', images[0], 'https://acme.com/hero.jpg')
check('svg, icons and data URIs are dropped', images, [
  'https://acme.com/hero.jpg',
  'https://acme.com/img/product-1.jpg',
  'https://acme.com/img/product-2.jpg',
])
check('never exceeds the cap', imageUrlsFrom(
  Array.from({ length: 40 }, (_, i) => `<img src="/p${i}.jpg">`).join(''),
  'https://acme.com',
).length <= leadPipeline.maxImagesPerLead, true)

console.log('\nScout — the budget is its own, and dates are read strictly')
// Not a comparison of the two numbers — they may coincide. What must hold is
// that the leads pipeline reads a cap of its **own**, so tuning one cannot move
// the other. ADR-0039 exists because that was not true.
check('the scout has a bound at all (invariant 2)', Number.isInteger(leadScout.maxProfilesPerRun) && leadScout.maxProfilesPerRun > 0, true)
check('it is a different knob from the job scout\'s', Object.hasOwn(leadScout, 'maxProfilesPerRun') && !Object.hasOwn(jobScout, 'maxProfilesPerRun'), true)
// Both of these are defects the FIRST live run produced, not hypotheticals.
check(
  'citation markers are stripped — they reached the message on run 1',
  cleanScoutText('Raised $4M to expand its DTC range.[24][23][29]', 220),
  'Raised $4M to expand its DTC range.',
)
check('grouped citations too', cleanScoutText('Launched a store.[24, 25]', 220), 'Launched a store.')
check('a bracketed year is not a citation', cleanScoutText('Founded [2019] in Lyon', 220), 'Founded [2019] in Lyon')
check('a long summary is cut on a word boundary, visibly', cleanScoutText('a'.repeat(20) + ' ' + 'b'.repeat(300), 50).endsWith('…'), true)
check('a parent company is dropped from the name', cleanCompanyName('Tome Skincare (Dermata Therapeutics)'), 'Tome Skincare')
check('a name that is only a parenthetical survives', cleanCompanyName('(Stealth)'), '(Stealth)')

check('a full date parses', parseEventDate('2026-08-01') !== null, true)
check('a bare year is refused, not read as January 1st', parseEventDate('2026'), null)
check('prose is refused', parseEventDate('last week'), null)
check('a malformed date is refused', parseEventDate('2026-8-1'), null)

console.log('\nAcknowledgement — silence is what makes a reader retype the command')
{
  // The ack is a race between a timer and the parse, and both orderings matter:
  // a fast parse must stay ONE message, a slow one must promise before it answers.
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
    const text = await new Promise<string>(resolve =>
      setTimeout(() => resolve('RESULT'), parseMs),
    )
    clearTimeout(timer)
    if (acked) await acked
    await send(text)
    return [...sent]
  }
  check('a fast parse stays one message', await run(5, 60), ['RESULT'])
  check('a slow parse promises, then answers — in that order', await run(60, 5), ['WORKING…', 'RESULT'])
}

console.log('\nMessage — structure from the template, prose from the model')
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
check('links the company, not the signal, in the heading', message.startsWith('## 🎯 [Acme](https://acme.com)'), true)
check('the angle is a blockquote the reader can copy', message.includes('> Your three product shots'), true)
check('the footer names the signal and the profile', message.includes('Paris · just raised · DTC brands · fit 82'), true)
check('no single-newline soft wraps between blocks', /[^\n]\n[^\n>\-_*#]/.test(message.replace(/^- .*$/gm, '')), false)

console.log(
  failures === 0
    ? '\n✓ All checks passed.\n'
    : `\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.\n`,
)
process.exit(failures === 0 ? 0 : 1)
