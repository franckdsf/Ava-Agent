import { describe, expect, it } from 'vitest'

import { leadPipeline } from '../../config/leads.js'
import { imageUrlsFrom, isNotACompanyHost } from '../lead-signals.js'

describe('hosts — a posting URL is usually not an employer', () => {
  it('a job board is not a company', () => {
    expect(isNotACompanyHost('weworkremotely.com')).toBe(true)
  })
  it('an ATS host is not a company', () => {
    expect(isNotACompanyHost('boards.greenhouse.io')).toBe(true)
  })
  it('HN is not a company — 211 postings had collapsed into one lead', () => {
    expect(isNotACompanyHost('ycombinator.com')).toBe(true)
  })
  it('a store platform is not a company', () => {
    expect(isNotACompanyHost('myshopify.com')).toBe(true)
  })
  it('a real employer is a company', () => {
    expect(isNotACompanyHost('stripe.com')).toBe(false)
  })
})

describe('images — what reaches the expensive model', () => {
  const html = `
    <meta property="og:image" content="/hero.jpg">
    <img src="https://cdn.example.com/logo.svg">
    <img src="/img/icon-cart.png">
    <img src="/img/product-1.jpg">
    <img src="data:image/png;base64,AAA">
    <img src="/img/product-2.jpg">`
  const images = imageUrlsFrom(html, 'https://acme.com/shop')

  it('og:image comes first', () => {
    expect(images[0]).toBe('https://acme.com/hero.jpg')
  })
  it('svg, icons and data URIs are dropped', () => {
    expect(images).toEqual([
      'https://acme.com/hero.jpg',
      'https://acme.com/img/product-1.jpg',
      'https://acme.com/img/product-2.jpg',
    ])
  })
  it('never exceeds the cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => `<img src="/p${i}.jpg">`).join('')
    expect(imageUrlsFrom(many, 'https://acme.com').length).toBeLessThanOrEqual(leadPipeline.maxImagesPerLead)
  })
})
