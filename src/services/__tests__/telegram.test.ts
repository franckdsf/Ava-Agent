import { ConsoleLogger } from '@mastra/core/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { JOOB_BOT } from '../../config/bots.js'
import { createTelegramTransport } from '../telegram.js'

// Audit F5: a notice must never affect the run sending it, and must never fail without a word.
// vitest.setup.ts configures no bot token, so every send here rejects before reaching Telegram —
// the failure `notify` exists to absorb, produced offline.

afterEach(() => {
  vi.restoreAllMocks()
})

describe('notify', () => {
  it('a notice that cannot be sent resolves false rather than throwing', async () => {
    vi.spyOn(ConsoleLogger.prototype, 'warn').mockImplementation(() => {})
    await expect(createTelegramTransport(JOOB_BOT).notify('Looking for jobs now.', 'chat')).resolves.toBe(false)
  })

  it('and leaves a log line naming the bot and the tab', async () => {
    const warn = vi.spyOn(ConsoleLogger.prototype, 'warn').mockImplementation(() => {})
    await createTelegramTransport(JOOB_BOT).notify('I couldn’t read your CV.', 'chat')
    expect(warn).toHaveBeenCalledWith(
      "Notice to joob's chat tab not sent",
      expect.objectContaining({ error: expect.any(String), text: 'I couldn’t read your CV.' }),
    )
  })

  it('the send it wraps still throws — a delivery is not a notice', async () => {
    await expect(createTelegramTransport(JOOB_BOT).sendToTelegram('A brief.', 'jobs')).rejects.toThrow()
  })
})
