/**
 * The data database's connection numbers.
 */
export const dataDb = {
  /**
   * How long a write on a local `file:` database waits for another writer's lock
   * before failing with `SQLITE_BUSY`. Passed to `createClient` as `timeout`, which
   * applies it to every connection the client opens — not the `PRAGMA busy_timeout`
   * Mastra sets at boot, which only reaches the first one (see `src/db/client.ts`).
   *
   * 5000 is Mastra's own default for a local client it builds itself. Without it,
   * the 2026-09-28 `review-memories` catch-up failed its step write five times in a
   * row and was left `running` for good.
   *
   * **The wait blocks the event loop**: the local driver is synchronous, so it can
   * only ever be won by a writer in another process — never by one in this one.
   */
  busyTimeoutMs: 5_000,
}
