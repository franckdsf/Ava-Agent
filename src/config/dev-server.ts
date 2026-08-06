/**
 * How a terminal reaches the running Mastra server.
 *
 * A workflow cannot be started from a plain script — `run.start()` hangs on
 * "unsettled top-level await", because the evented engine needs the pubsub loop
 * the server owns. The way in is HTTP against a server that is already up, which
 * is what `pnpm workflow:run` does.
 *
 * Deliberately free of `env.ts`: nothing here is a secret, and importing the
 * validated core schema would make a script that only speaks HTTP demand an
 * `OPENROUTER_API_KEY` to print a usage line.
 */
export const devServer = {
  /**
   * Where `pnpm dev` listens. `AVA_DEV_SERVER_URL` overrides it for a container
   * or a non-default port — read from the raw environment rather than through
   * `env.ts` for the reason above.
   */
  baseUrl: process.env.AVA_DEV_SERVER_URL ?? 'http://localhost:4111',

  /**
   * How often a triggered run is polled for progress.
   *
   * Every tick is a database read on the same process that is doing the work, so
   * this is a courtesy interval rather than a latency target: the runs worth
   * watching take minutes, and the steps are what the reader is waiting for.
   */
  pollMs: 3_000,

  /**
   * How long the poller watches before printing the run id and standing down.
   *
   * Not a timeout on the *run* — nothing here can cancel one, and standing down
   * leaves it running exactly as a scheduled fire would. It bounds the terminal
   * session only. A jobs run with the `sonar` source active is the long pole:
   * a model call plus a page fetch per lead, minutes at a time.
   */
  maxWatchMs: 1_800_000,
} as const
