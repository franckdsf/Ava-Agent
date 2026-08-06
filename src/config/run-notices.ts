/**
 * Whether a scheduled pipeline says out loud that it is running.
 *
 * Both pipelines were silent until 2026-08-06 unless they had something to
 * deliver, which makes "quiet week" and "the container has been down since
 * Tuesday" the same observation from the outside. A run notice is the cheapest
 * fix: two lines a run in the agent's own Chat tab, one before the fetching and
 * one after the delivery, saying what it read and what came of it.
 *
 * **Chat, not the tab the output lands in.** A notice is a short status line
 * about the machinery, not a story or a job — News, a beat tab and Jobs each
 * carry exactly one kind of traffic ([invariant 9](../../AGENTS.md#invariants)),
 * and a run summary is the same kind of message as the weekly feed review and
 * Joob's "nothing worth sending", which already go to Chat.
 *
 * **A notice is never allowed to affect a run.** Every send here is fired with
 * its rejection swallowed: a pipeline that dies because Telegram is having a bad
 * minute would be a far worse bug than the silence this replaces.
 *
 * The two halves are separately switchable because they answer different
 * questions — `start` is "is it alive right now", which matters most while the
 * sonar leg of a job run takes minutes, and `finish` is "what did it come to",
 * which is the one worth keeping if the Chat tab gets noisy.
 */
export const runNotices = {
  /** Newy's news pipeline (`curateAll`), on each digest fire. */
  news: { start: true, finish: true },

  /**
   * Joob's job pipeline (`findJobs`), on each firing that clears the gate.
   *
   * A firing the interval gate turns away sends nothing at all — it did no work
   * and spent nothing, and a message for it would be a message most days.
   *
   * **Turning `finish` off also silences the "nothing worth sending" report**,
   * which used to be its own message and is now the zero-delivery wording of
   * this one. That is deliberate: a run that delivered nothing and a run that
   * delivered eight are the same event, and two mechanisms reporting it is how
   * a quiet run ends up announced twice.
   */
  jobs: { start: true, finish: true },

  /**
   * Feed and source failures named individually in a finish notice.
   *
   * The errors are already collected per run and, until this existed, were
   * visible only in a Studio run graph nobody opens. They are still not the
   * point of the message, and a run where thirty feeds time out must not push
   * the counters off the top of the screen — past this the rest are counted
   * rather than listed.
   */
  maxErrorsShown: 3,
} as const
