import { defineConfig } from 'drizzle-kit'

/**
 * `turso` is the libSQL dialect — it drives both local `file:` databases and
 * hosted Turso URLs, which is why the same config serves dev and production.
 *
 * `generate` only reads the schema file, so it works without a live database.
 */
export default defineConfig({
  dialect: 'turso',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.AVA_DATA_DB_URL ?? 'file:./.data/ava.db',
    ...(process.env.AVA_DATA_DB_AUTH_TOKEN
      ? { authToken: process.env.AVA_DATA_DB_AUTH_TOKEN }
      : {}),
  },
})
