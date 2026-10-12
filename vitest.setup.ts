import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The environment every test file starts with — runs before the file is imported.
 *
 * `src/config/env.ts` is parsed at import time and requires a model key, so a test of anything
 * that transitively imports it would otherwise need a `.env`. A test runs offline, so the key is a
 * placeholder: a test that reaches the gateway with it fails loudly, which is the point.
 *
 * Both databases point at a fresh file per test file. A test that touches `src/db/` gets an empty
 * schema migrated on first query, exactly as a fresh volume does at boot — and no test can reach
 * `.data/ava.db`, whatever it imports. Absolute paths, so `resolveDbUrl` passes them through.
 */
const run = join(tmpdir(), `ava-test-${randomUUID()}`)

process.env.OPENROUTER_API_KEY = 'offline-test-placeholder'
process.env.AVA_DATA_DB_URL = `file:${join(run, 'ava.db')}`
process.env.AVA_TRACES_DB_URL = `file:${join(run, 'traces.db')}`

// No bot is configured, so nothing imported can reach Telegram.
delete process.env.NEWY_TELEGRAM_BOT_TOKEN
delete process.env.JOOB_TELEGRAM_BOT_TOKEN
