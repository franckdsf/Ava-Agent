import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, like, lt, type SQL } from 'drizzle-orm'
import { memoryConfig } from '../config/memory.js'
import { db, migrate } from './client.js'
import { memories } from './schema.js'
import type { MemoryRow, MemoryTier } from './schema.js'

/**
 * Ava's notes about the reader — the read and write side of the `memories`
 * table.
 *
 * This is the one part of the conversational surface that writes, and the
 * boundary is the point: it writes *here* and nowhere else. The news tables stay
 * read-only from a conversation ([invariant 8](../../AGENTS.md#invariants)), so
 * nothing a model decides mid-chat can re-send a digest or change a ranking.
 * See [ADR-0014](../../docs/decisions/0014-two-tier-memory-for-ava.md).
 */

/** A fact as it is handed to the prompt or a tool — dates already resolved. */
export interface Memory {
  id: string
  tier: MemoryTier
  fact: string
  /** When it was true, `YYYY-MM-DD`. */
  happenedOn: string
  /** When it was written down, `YYYY-MM-DD`. */
  recordedOn: string
}

export interface NewMemory {
  fact: string
  tier: MemoryTier
  /** When the fact was true. Defaults to now when the reader didn't date it. */
  happenedAt?: number
}

/**
 * The id of a fact: a hash of its normalized text.
 *
 * Normalizing before hashing is what makes the collision worth having — case,
 * runs of whitespace and a trailing full stop are all ways to write the same
 * sentence twice, and each would otherwise be its own row in the block Ava reads
 * back every turn.
 */
export function memoryId(fact: string): string {
  const normalized = fact.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/** Epoch ms → `YYYY-MM-DD`, which is the only form a date reaches the model in. */
function toDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    tier: row.tier,
    fact: row.fact,
    happenedOn: toDay(row.happenedAt),
    recordedOn: toDay(row.createdAt),
  }
}

/** Epoch ms before which a short-term memory drops out of the prompt. */
export function shortTermCutoff(now = Date.now()): number {
  return now - memoryConfig.shortTermDays * 24 * 60 * 60 * 1000
}

/**
 * Writes a fact down, or leaves the existing one alone if it is already known
 * verbatim.
 *
 * `onConflictDoNothing` rather than an update, because the conflicting row *is*
 * this fact — same text, already dated. Refreshing its timestamps would restate
 * an old memory as a new one and quietly reset its short-term window every time
 * the reader mentioned it, which is exactly the fact that should be promoted,
 * not renewed.
 *
 * Returns whether a row was actually written, so the tool can tell Ava she
 * already knew this and stop her recording it a third way.
 */
export async function rememberFact(entry: NewMemory): Promise<{ memory: Memory; stored: boolean }> {
  await migrate()
  const now = Date.now()
  const fact = entry.fact.trim().slice(0, memoryConfig.factMaxChars)
  const row = {
    id: memoryId(fact),
    tier: entry.tier,
    fact,
    happenedAt: entry.happenedAt ?? now,
    createdAt: now,
  }

  const inserted = await db().insert(memories).values(row).onConflictDoNothing().returning()
  const existing = inserted[0] ?? (await getMemory(row.id))
  // The fallback read cannot miss: the insert only declines on a primary-key
  // conflict, so the row it conflicted with is there. Falling back to `row`
  // keeps the return type honest without a non-null assertion.
  return { memory: toMemory(existing ?? row), stored: inserted.length > 0 }
}

export async function getMemory(id: string): Promise<MemoryRow | undefined> {
  await migrate()
  const rows = await db().select().from(memories).where(eq(memories.id, id)).limit(1)
  return rows[0]
}

/**
 * What goes into the instructions: every lasting fact, plus the recent episodic
 * ones, oldest first within each tier.
 *
 * **Oldest first is load-bearing.** The block is read as a timeline, so the last
 * line about a subject is the current one — that ordering plus the date on each
 * line is the entire mechanism by which "blond hair (2026-01)" supersedes "dark
 * hair (2025-01)" without either row being touched.
 *
 * The caps apply to the *newest* rows and the result is then re-sorted, so
 * overflowing long-term memory drops the oldest fact rather than truncating the
 * timeline at the wrong end.
 */
export async function memoriesForPrompt(
  now = Date.now(),
): Promise<{ long: Memory[]; short: Memory[] }> {
  await migrate()
  const [long, short] = await Promise.all([
    newestFirst(eq(memories.tier, 'long'), memoryConfig.promptLongTermLimit),
    newestFirst(
      and(eq(memories.tier, 'short'), gte(memories.createdAt, shortTermCutoff(now))),
      memoryConfig.promptShortTermLimit,
    ),
  ])
  return { long: oldestFirst(long), short: oldestFirst(short) }
}

function newestFirst(where: SQL | undefined, limit: number): Promise<MemoryRow[]> {
  return db()
    .select()
    .from(memories)
    .where(where)
    .orderBy(desc(memories.happenedAt))
    .limit(limit)
}

function oldestFirst(rows: MemoryRow[]): Memory[] {
  return [...rows].sort((a, b) => a.happenedAt - b.happenedAt).map(toMemory)
}

/**
 * Searches the notes, including short-term ones too old for the prompt.
 *
 * Every term must appear somewhere in the fact, rather than the whole phrase
 * appearing contiguously. That distinction is what broke article search badly
 * enough to need FTS5 ([ADR-0011](../../docs/decisions/0011-fts5-for-article-search.md)):
 * a single `like '%<phrase>%'` cannot match "ate sushi" against "They ate a lot
 * of sushi". FTS5 is not warranted for the same fix here — this table holds
 * hundreds of one-line rows rather than hundreds of 8k bodies, so a scan is
 * cheap, and it needs no virtual table or triggers to stay in step.
 */
export async function searchMemories(options: {
  query?: string
  tier?: MemoryTier
  limit: number
}): Promise<Memory[]> {
  await migrate()
  const terms = (options.query ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(term => like(memories.fact, `%${term.toLowerCase()}%`))

  const rows = await db()
    .select()
    .from(memories)
    .where(
      and(
        ...(options.tier ? [eq(memories.tier, options.tier)] : []),
        // `like` is case-insensitive for ASCII in SQLite by default; lowercasing
        // the needle covers the mixed-case side of an accented term too.
        ...(terms.length > 0 ? [and(...terms)] : []),
      ),
    )
    .orderBy(desc(memories.happenedAt))
    .limit(options.limit)
  return rows.map(toMemory)
}

/**
 * Everything the weekly review looks at: the short-term notes it may promote or
 * delete, and the long-term ones it may only read.
 *
 * Short-term comes back **oldest first** so the cap always keeps whatever is
 * closest to deletion — a run that has to truncate must truncate the notes that
 * can wait, never the ones about to be swept.
 */
export async function memoriesForReview(): Promise<{ long: Memory[]; short: Memory[] }> {
  await migrate()
  const [long, short] = await Promise.all([
    db()
      .select()
      .from(memories)
      .where(eq(memories.tier, 'long'))
      .orderBy(asc(memories.happenedAt))
      .limit(memoryConfig.reviewLongTermLimit),
    db()
      .select()
      .from(memories)
      .where(eq(memories.tier, 'short'))
      .orderBy(asc(memories.createdAt))
      .limit(memoryConfig.reviewShortTermLimit),
  ])
  return { long: long.map(toMemory), short: short.map(toMemory) }
}

/**
 * Moves notes to the long tier, keeping both dates.
 *
 * `happenedAt` in particular is never touched: the fact was true when it was
 * true, and rewriting it to the promotion date would file a June dinner under
 * July and break the ordering the whole block is read by.
 *
 * Scoped to `tier = 'short'` so this can only ever move notes in one direction.
 * A demotion would silently put a long-term fact on a deletion clock.
 */
export async function promoteMemories(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  await migrate()
  const promoted = await db()
    .update(memories)
    .set({ tier: 'long' })
    .where(and(eq(memories.tier, 'short'), inArray(memories.id, ids)))
    .returning({ id: memories.id })
  return promoted.length
}

/**
 * Deletes short-term notes past the window. The one destructive operation in the
 * memory system that isn't a reader asking for it.
 *
 * `tier = 'short'` is doing real work in that where clause, not just narrowing:
 * it is what makes "promote, then delete" safe to run in that order, since a
 * note promoted a moment earlier is no longer short and cannot be caught by the
 * sweep that follows. Nothing long-term is deletable by any scheduled job.
 *
 * Unbatched, unlike `deleteItemsOlderThan`: a week's worth of notes is tens of
 * rows with no FTS triggers behind them, so there is no write lock worth
 * chunking.
 */
export async function deleteExpiredShortTerm(now = Date.now()): Promise<Memory[]> {
  await migrate()
  const gone = await db()
    .delete(memories)
    .where(and(eq(memories.tier, 'short'), lt(memories.createdAt, shortTermCutoff(now))))
    .returning()
  return gone.map(toMemory)
}

/**
 * Deletes one note. For a fact that was never true — not for one that has
 * changed, which is a second note with a later date.
 *
 * Returns what was deleted so the caller can confirm the right thing went, and
 * null when the id matched nothing.
 */
export async function forgetMemory(id: string): Promise<Memory | null> {
  await migrate()
  const gone = await db().delete(memories).where(eq(memories.id, id)).returning()
  const row = gone[0]
  return row ? toMemory(row) : null
}

