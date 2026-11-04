import { beforeAll, describe, expect, it } from 'vitest'

import { forgetMemory, rememberFact, searchMemories } from '../memories.js'

/**
 * What `recall-memories` finds. Each test asks in a case other than the one the note was written
 * in, because a note it cannot find is also a note `forget-memory` can never reach — that tool only
 * takes an id, and this search is where the id comes from.
 */

const DAY = 86_400_000
const now = Date.now()

/** A note as a macOS keyboard or a pasted PDF can deliver it: `e` + U+0300, not `è`. */
const decomposed = 'Their aunt Hélène runs a bakery'.normalize('NFD')

const facts = async (query: string, limit = 10) =>
  (await searchMemories({ query, limit })).map(memory => memory.fact)

beforeAll(async () => {
  await rememberFact({ fact: 'Their friend Émile lives in Lyon', tier: 'long' })
  await rememberFact({ fact: 'ÇA is the tea shop they like in Paris', tier: 'short' })
  await rememberFact({ fact: 'They grew up in Москва', tier: 'long' })
  await rememberFact({ fact: 'They ate a lot of sushi in Osaka', tier: 'short' })
  await rememberFact({ fact: 'They visited Noemie in Nimes', tier: 'long' })
  await rememberFact({ fact: decomposed, tier: 'long' })
  await rememberFact({ fact: 'They borrowed a किताब from the library', tier: 'long' })
  // Holds `e` and `mile` but not `emile`: the decoy for a query split at its combining mark.
  await rememberFact({ fact: 'They ran a mile every day', tier: 'short' })
  await rememberFact({ fact: 'They drive a Citroën', tier: 'long' })
  await rememberFact({ fact: 'Their sœur Claire lives in Nantes', tier: 'long' })
  await rememberFact({ fact: 'They learnt it par coeur at school', tier: 'long' })
  await rememberFact({ fact: 'They flew to Łódź in May', tier: 'long' })
  await rememberFact({ fact: 'They live on the Hauptstraße', tier: 'long' })
  await rememberFact({ fact: 'Their ferry stopped at Ærø', tier: 'short' })
})

describe('searchMemories', () => {
  it.each([
    ['a lowercase query for a capitalised accent', 'émile', 'Their friend Émile lives in Lyon'],
    ['an uppercase query for a capitalised accent', 'ÉMILE', 'Their friend Émile lives in Lyon'],
    ['a lowercase query for a leading capital', 'ça', 'ÇA is the tea shop they like in Paris'],
    ['a lowercase query in another script', 'москва', 'They grew up in Москва'],
    ['an uppercase query in another script', 'МОСКВА', 'They grew up in Москва'],
    ['a plain ASCII query', 'SUSHI', 'They ate a lot of sushi in Osaka'],
  ])('finds a note from %s', async (_case, query, fact) => {
    expect(await facts(query)).toEqual([fact])
  })

  it.each([
    ['no accent for an accented note', 'emile', 'Their friend Émile lives in Lyon'],
    ['no accent and all capitals for an accented note', 'EMILE', 'Their friend Émile lives in Lyon'],
    ['an accent for a note written without one', 'noémie', 'They visited Noemie in Nimes'],
    ['a different accent than the note has', 'nîmes', 'They visited Noemie in Nimes'],
    ['a composed query for a decomposed note', 'hélène', decomposed],
    ['no accent for a decomposed note', 'helene', decomposed],
    [
      'a decomposed query, which must stay one word',
      'émile'.normalize('NFD'),
      'Their friend Émile lives in Lyon',
    ],
  ])('ignores accents: finds a note from %s', async (_case, query, fact) => {
    expect(await facts(query)).toEqual([fact])
  })

  it.each([
    ['a dieresis', 'citroen', 'They drive a Citroën'],
    ['œ typed as two letters', 'soeur', 'Their sœur Claire lives in Nantes'],
    ['two letters typed as œ', 'cœur', 'They learnt it par coeur at school'],
    ['ł and an accent in one word', 'lodz', 'They flew to Łódź in May'],
    ['ß typed as two letters', 'strasse', 'They live on the Hauptstraße'],
    ['ß asked for in capitals', 'STRASSE', 'They live on the Hauptstraße'],
    ['a capital Æ and ø', 'aero', 'Their ferry stopped at Ærø'],
  ])('ignores how a letter was typed: finds a note past %s', async (_case, query, fact) => {
    expect(await facts(query)).toEqual([fact])
  })

  it('keeps the marks that spell a word in another script', async () => {
    expect(await facts('किताब')).toEqual(['They borrowed a किताब from the library'])
    expect(await facts('कताब')).toEqual([])
  })

  it('requires every word, in any order, across the note', async () => {
    expect(await facts('lyon émile')).toEqual(['Their friend Émile lives in Lyon'])
    expect(await facts('émile osaka')).toEqual([])
  })

  it('finds a note older than the newest `limit` rows that do not match', async () => {
    const old = 'Their cousin Zoé moved to Québec'
    await rememberFact({ fact: old, tier: 'long', happenedAt: now - 400 * DAY })
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        rememberFact({ fact: `A recent note, number ${i}`, tier: 'short' }),
      ),
    )

    expect(await facts('zoé', 2)).toEqual([old])
  })

  it('caps what it returns at the limit, newest first', async () => {
    const happened = (days: number) => now - days * DAY
    await rememberFact({ fact: 'Théo plays chess', tier: 'long', happenedAt: happened(30) })
    await rememberFact({ fact: 'Théo plays go', tier: 'long', happenedAt: happened(20) })
    await rememberFact({ fact: 'Théo plays poker', tier: 'long', happenedAt: happened(10) })

    expect(await facts('théo', 2)).toEqual(['Théo plays poker', 'Théo plays go'])
  })

  it('restricts to one tier', async () => {
    const found = await searchMemories({ query: 'émile', tier: 'short', limit: 10 })
    expect(found).toEqual([])
  })

  it('lists every note when no word is asked for', async () => {
    const found = await searchMemories({ tier: 'long', limit: 100 })
    expect(found.map(memory => memory.fact)).toContain('Their friend Émile lives in Lyon')
  })

  it('hands back the id `forget-memory` needs for a note it can only reach by search', async () => {
    const fact = 'Their sister Élodie is a nurse'
    await rememberFact({ fact, tier: 'long' })

    const [found] = await searchMemories({ query: 'élodie', limit: 1 })
    expect(found?.fact).toBe(fact)
    expect((await forgetMemory(found?.id ?? 'not found'))?.fact).toBe(fact)
    expect(await facts('élodie')).toEqual([])
  })
})
