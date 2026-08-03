/**
 * What Newy remembers about the reader, and how much of it she is shown.
 *
 * Separate from `pipeline.ts` on purpose: that file is the news pipeline's knob
 * drawer, and none of these numbers affect ingest, ranking or delivery. They
 * govern the conversational surface only.
 */
export const memoryConfig = {
  /**
   * How long a short-term memory stays in Newy's instructions, measured from when
   * it was recorded.
   *
   * It is now also when the row becomes *deletable*: the weekly review promotes
   * what is worth keeping and deletes the rest
   * ([ADR-0015](../../docs/decisions/0015-weekly-memory-review.md)). Raising it
   * lengthens both the window and the grace period before deletion, which is the
   * right coupling — a note should never be deleted while it is still being
   * shown.
   */
  shortTermDays: 30,

  /**
   * Lines of each tier injected into the instructions, newest kept when there
   * are more.
   *
   * This block is rebuilt and re-sent on *every* turn, so it is a standing cost
   * per message, not a one-off. Long-term is given the larger share because it
   * never expires and is what makes her useful across months; short-term already
   * has the window above bounding it. `recall-memories` reaches everything past
   * both caps, so a low number costs recall depth, never data.
   */
  promptLongTermLimit: 60,
  promptShortTermLimit: 40,

  /**
   * Lines of each tier handed to the ranker on a curation run
   * ([ADR-0016](../../docs/decisions/0016-reader-notes-in-the-ranker.md)).
   *
   * Lower than the prompt caps above, and not for cost — this block is sent once
   * per run (six runs a day) against a batch of a hundred items, so it is noise
   * next to the items themselves. It is lower because of *signal*: the ranker is
   * scoring against a rubric, and every extra irrelevant fact is one more thing
   * competing with it. Newy needs the whole person; the ranker needs the shape of
   * their interests.
   */
  curationLongTermLimit: 40,
  curationShortTermLimit: 20,

  /**
   * Ceiling on one fact. A note is a sentence — anything longer is a summary of
   * a conversation, which is what the thread history is for.
   */
  factMaxChars: 300,

  /** Ceiling on what one `recall-memories` call can pull back into context. */
  recallLimit: 25,

  /**
   * Local-time hour and weekday (0 = Sunday) of the weekly memory review.
   *
   * Monday 05:00: after the 04:00 prune has released its write lock, and well
   * before the 08:00 digest. Weekly rather than daily because the decision it
   * makes is "with a month of hindsight, was this biography?" — asking that
   * every day is six extra model calls to re-confirm the same answer.
   */
  reviewHour: 5,
  reviewWeekday: 1,

  /**
   * Rows handed to the reviewer in one run.
   *
   * Both are ceilings on a *prompt*, not on the work: short-term notes are taken
   * oldest first, so whatever is closest to deletion is always what gets judged.
   * Long-term notes are context only — the reviewer needs them to recognise a
   * fact it already knows, and it is never allowed to touch them.
   */
  reviewShortTermLimit: 200,
  reviewLongTermLimit: 200,
} as const
