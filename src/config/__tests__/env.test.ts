import { afterEach, expect, it, vi } from 'vitest'

/**
 * The environment is validated at boot and the error names what is missing — a deployment that
 * forgot a variable must refuse to start and say which one, not run on a default.
 */

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
  vi.resetModules()
})

it('refuses to load without the model key, naming it', async () => {
  delete process.env.OPENROUTER_API_KEY
  vi.resetModules()
  await expect(import('../env.js')).rejects.toThrow(/Invalid core environment:[\s\S]*OPENROUTER_API_KEY/)
})

// `.env.example` ships keys with nothing after the `=`, so an empty value must count as missing.
it('treats an empty value as missing', async () => {
  process.env.OPENROUTER_API_KEY = ''
  vi.resetModules()
  await expect(import('../env.js')).rejects.toThrow(/OPENROUTER_API_KEY/)
})

it("refuses a bot with no token or reader, naming each variable by the bot's prefix", async () => {
  delete process.env.AVA_TELEGRAM_USER_ID
  const { telegramEnv } = await import('../env.js')
  expect(() => telegramEnv({ id: 'scribe', envPrefix: 'SCRIBE_' })).toThrow(
    /Invalid scribe Telegram environment:[\s\S]*SCRIBE_TELEGRAM_BOT_TOKEN[\s\S]*AVA_TELEGRAM_USER_ID/,
  )
})
