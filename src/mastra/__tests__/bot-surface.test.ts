import { beforeAll, describe, expect, it } from 'vitest'

import { JOOB_BOT } from '../../bots/joob.js'
import { NEWY_BOT } from '../../bots/newy.js'
import { seedBeats } from '../../db/beats.js'
import { JOOB_SURFACE } from '../commands/joob.js'
import { NEWY_SURFACE } from '../commands/newy.js'
import { commandMenu, unknown } from '../registrar.js'

// What each bot shows a reader before any conversation: the `/` menu, `/start`, the reply to a
// command it does not know, and its identity — profile and tabs. Pinned byte for byte before
// slices 4+5 rebuilt all of it from one registrar and one bot definition (ADR-0047), and passed
// unchanged through that refactor.
//
// The menu, `/start` and the unknown reply are three renderings of one command list, derived from
// the same `Command` objects. A snapshot that moves is a change a reader will see: review the diff
// as a message, then update it deliberately.

beforeAll(async () => {
  // Newy's `/start` lists the live beats — the starter set a fresh volume boots with.
  await seedBeats()
})

describe('Newy', () => {
  it('identity: id, env prefix, tabs, profile', () => {
    expect(NEWY_BOT).toMatchSnapshot()
  })
  it('the / menu', () => {
    expect(commandMenu(NEWY_SURFACE)).toMatchSnapshot()
  })
  it('/start', async () => {
    expect(await NEWY_SURFACE.welcome(NEWY_SURFACE)).toMatchSnapshot()
  })
  it('an unknown command', () => {
    expect(unknown(NEWY_SURFACE, '/nope')).toMatchSnapshot()
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
