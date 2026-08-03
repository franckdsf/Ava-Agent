import { profileOverflows } from '../src/config/bot-profile.js'
import { BOTS, type BotDefinition } from '../src/config/bots.js'
import { telegramEnv } from '../src/config/env.js'
import { topicTabName } from '../src/config/topics.js'
import { topicIds } from '../src/db/topics.js'
import { profileDrift, topicRoute } from '../src/services/telegram-topics.js'

/**
 * Reports, for each bot, whether its chat can hold tabs, which are provisioned,
 * and whether its own profile matches config.
 *
 * Read-only — `getChat`, `getMe`, the three profile getters and one table read
 * per bot. Sends nothing and creates nothing, so it is safe against a live bot at
 * any time. The profile section in particular shows what the *next boot* would
 * push without pushing it.
 *
 * Exists because the prerequisite is a manual toggle no API can set, it differs
 * by chat type, and its absence otherwise surfaces as an opaque
 * `createForumTopic` failure at digest time. Threaded Mode is decided per *token*
 * — enabling it on one bot says nothing about the other — which is why this
 * covers every bot by default rather than taking a required argument: a check
 * that silently reported on one of two would be worse than no check
 * ([ADR-0023](../docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)).
 *
 * `pnpm telegram:check` reports on all of them; `pnpm telegram:check newy`
 * narrows to one.
 */

const requested = process.argv[2]
const targets = requested ? BOTS.filter(bot => bot.id === requested) : BOTS

if (targets.length === 0) {
  console.error(
    `No bot called "${requested}". Known: ${BOTS.map(bot => bot.id).join(', ')}.`,
  )
  process.exit(1)
}

interface ChatInfo {
  type: string
  title?: string
  username?: string
  is_forum?: boolean
}

/** True when this bot has a token at all — an unconfigured one is skipped, not failed. */
function isConfigured(bot: BotDefinition<string>): boolean {
  return Boolean(process.env[`${bot.envPrefix}TELEGRAM_BOT_TOKEN`])
}

let failed = false

for (const bot of targets) {
  console.log(`\n${'='.repeat(60)}\n${bot.id}\n${'='.repeat(60)}`)

  if (!isConfigured(bot)) {
    console.log(`not configured — ${bot.envPrefix}TELEGRAM_BOT_TOKEN is unset, skipped`)
    continue
  }

  // A bot with a token but no chat id or no allowlist is a real misconfiguration
  // and must fail the run — but it must not take the *other* bot's report with
  // it. Letting this throw crashed the process mid-report, which is exactly the
  // "silently covers one of two" failure this script is shaped to avoid; the
  // thrown message already names the exact variable, so it is worth printing.
  let resolved: ReturnType<typeof telegramEnv>
  try {
    resolved = telegramEnv(bot)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    failed = true
    continue
  }
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = resolved

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChat?chat_id=${TELEGRAM_CHAT_ID}`,
  )
  const body = (await response.json()) as { ok: boolean; result?: ChatInfo; description?: string }

  if (!body.ok || !body.result) {
    console.error(`getChat failed: ${body.description ?? 'unknown error'}`)
    failed = true
    continue
  }

  const chat = body.result
  const route = await topicRoute(bot)

  console.log(`chat    ${TELEGRAM_CHAT_ID} (${chat.type})`)
  console.log(`name    ${chat.title ?? chat.username ?? '—'}`)
  console.log(`tabs    ${route === 'unavailable' ? 'UNAVAILABLE' : `on, via ${route}`}`)

  // Before the tabs branch below, because the profile is independent of them — an
  // unavailable chat still has a name and a description worth reporting on.
  console.log('\nprofile')
  const overflows = profileOverflows(bot.profile)
  if (overflows.length > 0) {
    // Boot throws on this rather than pushing a partial profile, so it is the one
    // thing here that is a failure and not a pending change.
    for (const overflow of overflows) console.log(`  TOO LONG  ${overflow}`)
    failed = true
  } else {
    const drifted = await profileDrift(bot)
    if (drifted.length === 0) {
      console.log('  up to date — the next boot pushes nothing')
    } else {
      for (const entry of drifted) {
        // An empty `have` is a field never set, which is what a fresh bot looks
        // like. Worth distinguishing from a value that has simply moved on.
        console.log(`  ${entry.field.padEnd(17)} ${entry.have === '' ? 'unset' : 'differs'}`)
        console.log(`    now  ${entry.have === '' ? '—' : entry.have}`)
        console.log(`    next ${entry.want}`)
      }
      console.log(`\n  ${drifted.length} field(s) pushed on the next boot.`)
    }
  }

  if (route === 'unavailable') {
    console.log('\nDigests fall back to one flat stream. Two ways to get tabs:\n')
    if (chat.type === 'private') {
      console.log('  A. Private chat — needs Bot API 9.4 Threaded Mode, set in BotFather:')
      console.log('       @BotFather → Bot Settings → Threads Settings → Threaded Mode')
      console.log('     If no Threads row exists, your client or account may not have it yet.\n')
      console.log('  B. Group — the 2022 feature, available to everyone today:')
      console.log('       create a group → Edit → toggle Topics on')
      console.log('       add this bot as admin WITH the "Manage Topics" right')
      console.log(
        `       then point ${bot.envPrefix}TELEGRAM_CHAT_ID at that group (id starts with -100)`,
      )
    } else {
      console.log('  This is a group but Topics is off. Enable it in the group itself:')
      console.log('       ⋮ → Edit → toggle Topics on')
      console.log('  Then make sure this bot is an admin with the "Manage Topics" right.')
    }
    continue
  }

  const provisioned = await topicIds(bot.id, TELEGRAM_CHAT_ID)
  console.log('\ntabs')
  for (const topic of bot.topics) {
    const row = provisioned[topic.slug]
    const want = topicTabName(topic)
    if (row === undefined) {
      console.log(`  ${want.padEnd(14)} not created yet`)
      continue
    }
    // A name that doesn't match config is a pending `editForumTopic`, not an
    // error: the next resolve pushes it. Worth showing, since nothing else does.
    const pending = row.name === want ? '' : `  (named ${row.name ?? 'unknown'}, rename pending)`
    console.log(`  ${want.padEnd(14)} #${row.messageThreadId}${pending}`)
  }
}

if (failed) process.exit(1)
