import { expect, it } from 'vitest'

import { hostOf } from '../url.js'

it('reads the host of a URL, without www. and lowercased', () => {
  expect(hostOf('https://WWW.Smashingmagazine.com/feed/')).toBe('smashingmagazine.com')
  expect(hostOf('http://blog.example.com:8080/a?b#c')).toBe('blog.example.com')
})

// Strict on purpose (slice 7, decision 1): a caller holding a bare domain adds the scheme itself,
// as feed-finder does, so the function means one thing everywhere.
it('returns null for a bare domain and for anything that is not a URL', () => {
  expect(hostOf('formula1.com')).toBeNull()
  expect(hostOf('not a url')).toBeNull()
})
