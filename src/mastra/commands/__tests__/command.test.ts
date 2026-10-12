import type { Mastra } from '@mastra/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JOOB_BOT, type JoobTopicSlug } from '../../../bots/joob.js'
import { commands } from '../../../config/commands.js'
import type { TelegramTransport } from '../../../services/telegram.js'
import { runCommand, type Command, type CommandContext } from '../command.js'

// What the reader sees from one slash command, whatever it does: a reply, a promise then a reply,
// or a failure message — never silence. The transport is a recorder; the timer is faked, so the
// race between the acknowledgement and the reply is decided by the test, not by the machine.

const NOTIFY_MS = 50

type Sent = { via: 'send' | 'notify'; text: string; tab: string | undefined }

let sent: Sent[]
let ctx: CommandContext<JoobTopicSlug>

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  const transport = {
    sendToTelegram: async (text: string, tab?: string) => {
      sent.push({ via: 'send', text, tab })
      return 1
    },
    // Slower than the reply on purpose: a runner that stopped awaiting the ack would let the
    // answer overtake the promise to answer, and the ordering cases below would see it.
    notify: async (text: string, tab?: string) => {
      await new Promise(resolve => setTimeout(resolve, NOTIFY_MS))
      sent.push({ via: 'notify', text, tab })
      return true
    },
  } as unknown as TelegramTransport<JoobTopicSlug>
  ctx = {
    mastra: { getLogger: () => undefined } as unknown as Mastra,
    event: { command: '/client', text: ' dtc skincare ', raw: {} },
    bot: JOOB_BOT,
    transport,
    chatTab: 'chat',
    args: 'dtc skincare',
  }
})
afterEach(() => {
  vi.useRealTimers()
})

const failed = (command: string, error: unknown) => `${command} failed: ${(error as Error).message}`

/** A command whose reply arrives after `ms` of fake time. */
function slow(ms: number, overrides: Partial<Command<JoobTopicSlug>> = {}): Command<JoobTopicSlug> {
  return {
    name: '/client',
    description: 'd',
    help: 'h',
    usage: 'u',
    working: 'WORKING…',
    run: () => new Promise(resolve => setTimeout(() => resolve('RESULT'), ms)),
    ...overrides,
  }
}

async function run(command: Command<JoobTopicSlug>, ms: number) {
  const done = runCommand(command, ctx, failed)
  // Room for two notices — an ack and a failure — each taking NOTIFY_MS.
  await vi.advanceTimersByTimeAsync(ms + 2 * NOTIFY_MS)
  await done
  return sent.map(entry => entry.text)
}

describe('acknowledgement — silence is what makes a reader retype the command', () => {
  it('a fast reply stays one message', async () => {
    expect(await run(slow(commands.ackAfterMs - 1), commands.ackAfterMs - 1)).toEqual(['RESULT'])
  })
  it('a slow reply promises, then answers — in that order', async () => {
    expect(await run(slow(commands.ackAfterMs + 1), commands.ackAfterMs + 1)).toEqual(['WORKING…', 'RESULT'])
  })
  it('a command with no working message is never acknowledged, however slow', async () => {
    expect(await run(slow(commands.ackAfterMs * 3, { working: undefined }), commands.ackAfterMs * 3)).toEqual([
      'RESULT',
    ])
  })
})

describe('every branch ends in a message', () => {
  it('a throw is answered with the bot’s failure wording, in the same tab', async () => {
    const boom = slow(0, { tab: 'leads', run: async () => Promise.reject(new Error('parse broke')) })
    await run(boom, 0)
    expect(sent).toEqual([{ via: 'notify', text: '/client failed: parse broke', tab: 'leads' }])
  })
  it('a slow throw still promises first, then fails', async () => {
    const late = slow(0, {
      run: () => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), commands.ackAfterMs + 1)),
    })
    expect(await run(late, commands.ackAfterMs + 1)).toEqual(['WORKING…', '/client failed: timeout'])
  })
  it('a command that sends its own messages gets nothing more from the runner', async () => {
    expect(await run(slow(0, { run: async () => undefined }), 0)).toEqual([])
  })
  it('a reply goes to the chat tab unless the command names another', async () => {
    await run(slow(0), 0)
    await run(slow(0, { tab: 'jobs' }), 0)
    expect(sent.map(entry => entry.tab)).toEqual(['chat', 'jobs'])
  })
})
