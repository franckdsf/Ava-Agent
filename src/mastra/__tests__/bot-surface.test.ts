import { beforeAll, describe, expect, it } from 'vitest'

import { JOOB_BOT } from '../../bots/joob.js'
import { NEWY_BOT } from '../../bots/newy.js'
import { seedBeats } from '../../db/beats.js'
import * as newy from '../channels.js'
import { JOOB_SURFACE } from '../commands/joob.js'
import { commandMenu, unknown } from '../registrar.js'

// What each bot shows a reader before any conversation: the `/` menu, `/start`, the reply to a
// command it does not know, and its identity — profile and tabs. Pinned byte for byte ahead of
// slices 4+5 (docs/plans/bots-as-definitions.md), which rebuild all of it from one registrar and
// one bot definition: the call sites below change with that refactor, the snapshot does not.
//
// The menu, `/start` and the unknown reply are three renderings of one command list. Before the
// refactor they agree by convention (`channels.ts` says so in comments); after it, by construction.
// The snapshot is what proves the construction reproduces what the convention produced.

beforeAll(async () => {
  // Newy's `/start` lists the live beats — the starter set a fresh volume boots with.
  await seedBeats()
})

describe('Newy', () => {
  it('identity: id, env prefix, tabs, profile', () => {
    expect(NEWY_BOT).toMatchSnapshot()
  })
  it('the / menu', () => {
    expect(newy.commandMenu()).toMatchSnapshot()
  })
  it('/start', async () => {
    expect(await newy.welcome()).toMatchSnapshot()
  })
  it('an unknown command', () => {
    expect(newy.unknown('/nope')).toMatchSnapshot()
  })
})

describe('Joob', () => {
  it('identity: id, env prefix, tabs, profile', () => {
    expect(JOOB_BOT).toMatchSnapshot()
  })
  it('the / menu', () => {
    expect(commandMenu(JOOB_SURFACE)).toMatchSnapshot()
  })
  it('/start', () => {
    expect(JOOB_SURFACE.welcome(JOOB_SURFACE)).toMatchSnapshot()
  })
  it('an unknown command', () => {
    expect(unknown(JOOB_SURFACE, '/nope')).toMatchSnapshot()
  })
})
