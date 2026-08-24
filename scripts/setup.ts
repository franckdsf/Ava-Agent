import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

/**
 * Interactive `.env` wizard — the manual half of getting a deployment running.
 *
 * Telegram has no API to create a bot or look up a user id: both go through a
 * human chatting with `@BotFather` and `@userinfobot`. This script can't remove
 * that step, so it does the part that *is* scriptable — asking for the result of
 * each one, validating it live against the Bot API, and writing `.env` — so a
 * typo surfaces here instead of as an opaque failure at `docker compose up`.
 *
 * Reads `.env.example` as the template and only ever fills in `KEY=` lines,
 * so every comment explaining a variable ships to the file that keeps it.
 * Rerunning is safe: an existing `.env`'s values are offered back as defaults.
 */

const root = new URL('..', import.meta.url)
const examplePath = new URL('.env.example', root)
const envPath = new URL('.env', root)

const template = readFileSync(examplePath, 'utf8')
const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''

function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (match) values.set(match[1]!, match[2]!)
  }
  return values
}

const current = parseEnv(existing)
const answers = new Map<string, string>()

const rl = createInterface({ input: process.stdin, output: process.stdout })

/** Masks a secret back to its last 4 characters, so a rerun can show it was set. */
function mask(value: string): string {
  return value.length <= 4 ? '*'.repeat(value.length) : `${'*'.repeat(value.length - 4)}${value.slice(-4)}`
}

async function ask(
  key: string,
  prompt: string,
  { secret = false, required = false, validate }: {
    secret?: boolean
    required?: boolean
    validate?: (value: string) => string | undefined
  } = {},
): Promise<string> {
  const existingValue = current.get(key) ?? ''
  const shown = existingValue ? ` [${secret ? mask(existingValue) : existingValue}]` : ''
  for (;;) {
    const raw = (await rl.question(`${prompt}${shown}: `)).trim()
    const value = raw === '' ? existingValue : raw
    if (value === '' && required) {
      console.log('  required — try again.')
      continue
    }
    if (value !== '' && validate) {
      const error = validate(value)
      if (error) {
        console.log(`  ${error}`)
        continue
      }
    }
    return value
  }
}

/** Calls `getMe` against a bot token so a pasted-wrong-value fails here, not at boot. */
async function checkBotToken(token: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const body = (await response.json()) as { ok: boolean; result?: { username: string } }
    if (!body.ok || !body.result) return 'Telegram rejected that token — check it against @BotFather.'
    console.log(`  ✓ @${body.result.username}`)
    return undefined
  } catch {
    return 'Could not reach Telegram — check your network and try again.'
  }
}

console.log("Setting up Ava — Enter keeps the value shown in brackets, if any.\n")

console.log('── Keys ──')
answers.set(
  'OPENROUTER_API_KEY',
  await ask('OPENROUTER_API_KEY', 'OpenRouter API key (openrouter.ai/keys)', {
    secret: true,
    required: true,
  }),
)
answers.set(
  'REPLICATE_API_KEY',
  await ask('REPLICATE_API_KEY', 'Replicate API key, optional — enables Newy\'s image tool', {
    secret: true,
  }),
)

console.log('\n── Telegram ──')
const wantsTelegram = current.get('AVA_TELEGRAM_USER_ID')
  ? true
  : (await rl.question('Set up the Telegram bots now? [Y/n]: ')).trim().toLowerCase() !== 'n'

if (wantsTelegram) {
  answers.set(
    'AVA_TELEGRAM_USER_ID',
    await ask('AVA_TELEGRAM_USER_ID', 'Your numeric Telegram id (message @userinfobot)', {
      required: true,
      validate: value => (/^\d+$/.test(value) ? undefined : 'Must be numbers only — not an @username.'),
    }),
  )

  const newyToken = await ask('NEWY_TELEGRAM_BOT_TOKEN', 'Newy\'s bot token (from @BotFather)', {
    secret: true,
    required: true,
    validate: value => (/^\d+:\S+$/.test(value) ? undefined : 'Does not look like a bot token.'),
  })
  const newyError = await checkBotToken(newyToken)
  if (newyError) console.log(`  warning: ${newyError}`)
  answers.set('NEWY_TELEGRAM_BOT_TOKEN', newyToken)

  const joobToken = await ask(
    'JOOB_TELEGRAM_BOT_TOKEN',
    "Joob's bot token, optional — leave empty to run news only",
    {
      secret: true,
      validate: value => (/^\d+:\S+$/.test(value) ? undefined : 'Does not look like a bot token.'),
    },
  )
  if (joobToken) {
    const joobError = await checkBotToken(joobToken)
    if (joobError) console.log(`  warning: ${joobError}`)
  }
  answers.set('JOOB_TELEGRAM_BOT_TOKEN', joobToken)

  if (joobToken) {
    answers.set(
      'PORTFOLIO_FEED_URL',
      await ask(
        'PORTFOLIO_FEED_URL',
        'URL Joob fetches your CV from (markdown or plain text), optional for now',
      ),
    )
  }
}

console.log('\n── Scheduling ──')
answers.set(
  'AGENT_TIMEZONE',
  await ask('AGENT_TIMEZONE', 'IANA timezone for digest fire times', {
    required: true,
  }) || 'Europe/Paris',
)

rl.close()

const written = template
  .split('\n')
  .map(line => {
    const match = /^([A-Z0-9_]+)=/.exec(line)
    if (!match) return line
    const key = match[1]!
    const value = answers.get(key) ?? current.get(key) ?? ''
    return `${key}=${value}`
  })
  .join('\n')

writeFileSync(envPath, written)
console.log(`\nWrote ${envPath.pathname.replace(/^\/(?=[A-Za-z]:)/, '')}`)

console.log(`
Next:
  pnpm dev                    # Mastra Studio, no Telegram needed
  docker compose up -d --build   # the real thing`)

if (wantsTelegram) {
  console.log(`
Two BotFather toggles no API can set — do these now for each bot you configured:
  @BotFather → your bot → Open mini app → Bot Settings
    → Threaded Mode: on
    → Disallow users to create new threads: on

Then verify everything is wired up:
  pnpm telegram:check`)
}
