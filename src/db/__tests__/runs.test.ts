import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { describe, expect, it } from 'vitest'

import { resolveFromRoot } from '../../lib/project-root.js'

// Audit D2: `job_runs` and `lead_runs` fold into `pipeline_runs`, and the stats are kept. Every run
// a deployment ever logged survives only if 0028 copies it before 0029 drops the tables — so this
// migrates a scratch database to just before the copy, writes old-shape rows, and runs the rest.

const COPY = '0028_copy_run_logs'

/** A migrations folder that stops just before `tag`, beside the full one. */
function foldersAround(tag: string) {
  const full = resolveFromRoot('drizzle')
  const before = mkdtempSync(join(tmpdir(), 'ava-migrations-'))
  cpSync(full, before, { recursive: true })
  const journalPath = join(before, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> }
  const cut = journal.entries.findIndex(entry => entry.tag === tag)
  if (cut < 0) throw new Error(`no migration tagged ${tag}`)
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) }))
  return { before, full }
}

describe('the run-log migration', () => {
  it('carries every job_runs and lead_runs row into pipeline_runs, vision_calls into detail', async () => {
    const { before, full } = foldersAround(COPY)
    const client = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), 'ava-db-')), 'ava.db')}` })
    const database = drizzle(client)

    await migrate(database, { migrationsFolder: before })
    await client.batch([
      `INSERT INTO job_runs (id, started_at, finished_at, fetched, stored, considered, scored, delivered, note)
       VALUES ('run-m1', 1000, 2000, 412, 37, 49, 49, 6, NULL), ('run-m2', 3000, NULL, 0, 0, 0, 0, 0, 'portfolio: 404')`,
      `INSERT INTO lead_runs (id, started_at, finished_at, fetched, stored, considered, scored, vision_calls, delivered, note)
       VALUES ('lead-1', 1500, 2500, 120, 14, 10, 10, 4, 3, NULL)`,
    ])

    await migrate(database, { migrationsFolder: full })
    const { rows } = await client.execute(
      'SELECT id, pipeline, started_at, finished_at, fetched, stored, considered, scored, delivered, note, detail FROM pipeline_runs ORDER BY started_at',
    )
    expect(rows.map(row => ({ ...row }))).toEqual([
      { id: 'run-m1', pipeline: 'jobs', started_at: 1000, finished_at: 2000, fetched: 412, stored: 37, considered: 49, scored: 49, delivered: 6, note: null, detail: null },
      { id: 'lead-1', pipeline: 'leads', started_at: 1500, finished_at: 2500, fetched: 120, stored: 14, considered: 10, scored: 10, delivered: 3, note: null, detail: '{"visionCalls":4}' },
      { id: 'run-m2', pipeline: 'jobs', started_at: 3000, finished_at: null, fetched: 0, stored: 0, considered: 0, scored: 0, delivered: 0, note: 'portfolio: 404', detail: null },
    ])

    const { rows: left } = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('job_runs', 'lead_runs')",
    )
    expect(left).toHaveLength(0)
    client.close()
  })
})
