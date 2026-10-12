/**
 * Knobs for slash commands as a whole — every bot's, run by `runCommand` in
 * `src/mastra/commands/command.ts`.
 */
export const commands = {
  /**
   * How long a command that calls a model may work in silence before it says it
   * is working. Only a command with a `working` message is timed at all.
   *
   * **A deferred acknowledgement, not an eager one**, and the delay is the whole
   * design. Telegram's typing indicator lasts about five seconds; a `/client`
   * parse measured at 9s on one run and 232.8s on the next then leaves the reader
   * watching nothing at all, with `leadPipeline.modelAttempts` able to double it.
   * What people do at that point is type the command again in different words —
   * and because `/client` upserts on the slug the *model* produces, a second
   * wording can produce a second row competing for the same companies. The
   * silence does not just look broken; it manufactures the exact duplicate
   * `/reclient` exists to repair.
   *
   * Firing on a timer rather than immediately keeps the common case to **one**
   * message. A parse that finishes in three seconds should not cost the reader
   * two notifications to say one thing.
   *
   * Four seconds, so it lands just as the typing indicator gives up. Measured on
   * `/client`; moved here from `leadPipeline` when every command became run by
   * one runner.
   */
  ackAfterMs: 4_000,
} as const
