import { createClient, type Client } from '@libsql/client'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import { migrate as runMigrations } from 'drizzle-orm/libsql/migrator'
import { env } from '../config/env.js'
import { resolveDbUrl } from '../lib/libsql-url.js'
import { resolveFromRoot } from '../lib/project-root.js'
import * as schema from './schema.js'

/**
 * A single libsql connection is shared between Drizzle (the app's tables) and
 * Mastra's LibSQLStore (its `mastra_*` tables). One pool against one database
 * avoids the SQLITE_BUSY contention two independent pools would cause on a
 * local file.
 *
 * Traces live in a *separate* database — high-volume, disposable, and only ever
 * read locally in Studio.
 */

let client: Client | undefined
let database: LibSQLDatabase<typeof schema> | undefined
let migrated: Promise<void> | undefined

/** The raw libsql client, so Mastra's store can reuse this exact connection. */
export function rawClient(): Client {
  if (!client) {
    client = createClient({
      url: resolveDbUrl(env.AVA_DATA_DB_URL),
      ...(env.AVA_DATA_DB_AUTH_TOKEN ? { authToken: env.AVA_DATA_DB_AUTH_TOKEN } : {}),
    })
  }
  return client
}

export function db(): LibSQLDatabase<typeof schema> {
  database ??= drizzle(rawClient(), { schema })
  return database
}

/**
 * Applies pending Drizzle migrations, memoized so concurrent callers share one
 * run. Every repository awaits this, so there's no separate migrate step to
 * forget in development or in the container.
 *
 * The folder is anchored to the project root: Drizzle resolves a relative
 * `migrationsFolder` against cwd, and `mastra dev` runs the bundle from
 * `.mastra/.build` — which fails with "Can't find meta/_journal.json".
 */
export function migrate(): Promise<void> {
  migrated ??= runMigrations(db(), {
    migrationsFolder: resolveFromRoot(env.AVA_MIGRATIONS_DIR),
  })
  return migrated
}

type BatchStatement = Parameters<LibSQLDatabase<typeof schema>['batch']>[0][number]

/**
 * Sends many statements in one round trip.
 *
 * Drizzle types `batch()` as a non-empty tuple to infer per-statement results,
 * which a dynamically built array can't satisfy. We don't use the results, so
 * the cast is contained here rather than repeated at every call site.
 */
export async function batchAll(statements: BatchStatement[]): Promise<void> {
  if (statements.length === 0) return
  await db().batch(statements as [BatchStatement, ...BatchStatement[]])
}
