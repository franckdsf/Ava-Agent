import { telegramEnv } from '../src/config/env.js'
import { TOPIC_LIST, topicTabName } from '../src/config/topics.js'
import { topicIds } from '../src/db/topics.js'
import { topicRoute } from '../src/services/telegram-topics.js'

/**
 * Reports whether the target chat can hold tabs, and which are provisioned.
 *
 * Read-only — `getChat`, `getMe` and one table read. Sends nothing and creates
 * nothing, so it is safe against the live bot at any time.
 *
 * Exists because the prerequisite is a manual toggle no API can set, it differs
 * by chat type, and its absence otherwise surfaces as an opaque
 * `createForumTopic` failure at digest time.
 */

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = telegramEnv()

interface ChatInfo {
  type: string
  title?: string
  username?: string
  is_forum?: boolean
}

const response = await fetch(
  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChat?chat_id=${TELEGRAM_CHAT_ID}`,
)
const body = (await response.json()) as { ok: boolean; result?: ChatInfo; description?: string }

if (!body.ok || !body.result) {
  console.error(`getChat failed: ${body.description ?? 'unknown error'}`)
  process.exit(1)
}

const chat = body.result
const route = await topicRoute()

console.log(`chat    ${TELEGRAM_CHAT_ID} (${chat.type})`)
console.log(`name    ${chat.title ?? chat.username ?? '—'}`)
console.log(`tabs    ${route === 'unavailable' ? 'UNAVAILABLE' : `on, via ${route}`}`)

if (route === 'unavailable') {
  console.log('\nDigests fall back to one flat stream. Two ways to get tabs:\n')
  if (chat.type === 'private') {
    console.log('  A. Private chat — needs Bot API 9.4 Threaded Mode, set in BotFather:')
    console.log('       @BotFather → Bot Settings → Threads Settings → Threaded Mode')
    console.log('     If no Threads row exists, your client or account may not have it yet.\n')
    console.log('  B. Group — the 2022 feature, available to everyone today:')
    console.log('       create a group → Edit → toggle Topics on')
    console.log('       add this bot as admin WITH the "Manage Topics" right')
    console.log('       then point TELEGRAM_CHAT_ID at that group (id starts with -100)')
  } else {
    console.log('  This is a group but Topics is off. Enable it in the group itself:')
    console.log('       ⋮ → Edit → toggle Topics on')
    console.log('  Then make sure this bot is an admin with the "Manage Topics" right.')
  }
  process.exit(0)
}

const provisioned = await topicIds(TELEGRAM_CHAT_ID)
console.log('\ntabs')
for (const topic of TOPIC_LIST) {
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
