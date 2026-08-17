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

/**
 * The port Mastra will listen on, decided the way Mastra decides it.
 *
 * `PORT` is the knob for both surfaces — `mastra dev` reads it after loading
 * `.env`, and so does the built server behind `pnpm start` — so setting it once
 * moves the server, and this module follows rather than leaving every terminal
 * script pointed at a port nothing is on. That is also why `workflow:run`
 * carries `--env-file-if-exists=.env` where the other pure-HTTP scripts carry
 * nothing: `mastra dev` loads `.env` for itself, and a script that has to find
 * that server needs the same file to learn where it went. `if-exists` because
 * `--help` must keep working without a `.env`, and a shell `PORT=` still wins
 * over the file's, so a one-off run needs no edit.
 *
 * The fallback mirrors the CLI's own rule rather than guessing: an unset or
 * non-numeric `PORT` sends Mastra scanning 4111–4131 for the first free port,
 * and 4111 is where that scan starts. It is a *first* choice, not a promise — a
 * second dev server on this machine lands on 4112 and nothing in the
 * environment says so, which is the case `PORT` exists to settle.
 */
function mastraPort(): string {
  const port = process.env.PORT
  return port && !Number.isNaN(Number(port)) ? port : '4111'
}

export const devServer = {
  /**
   * Where `pnpm dev` listens. Derived from `PORT` above; `AVA_DEV_SERVER_URL`
   * overrides the whole URL for a server this process cannot reach on localhost
   * — a container, another host — and is read from the raw environment rather
   * than through `env.ts` for the reason above.
   */
  baseUrl: process.env.AVA_DEV_SERVER_URL ?? `http://localhost:${mastraPort()}`,

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
