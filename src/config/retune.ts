/**
 * Bounds on what Newy may write into a beat when the reader asks her to retune
 * it — and on how much of that beat she reads back to diagnose it.
 *
 * **The rubric is still assembled by `buildRubric()`, not written freehand**, and
 * that restriction is the reason this file is small. `discovery.ts` fixes the
 * shape of a rubric on the grounds that a model writing one from scratch "can
 * produce something that reads well and scores badly, and there is no way to
 * tell the difference without a measurement the reader will never run". Nothing
 * about that changes when the author is Newy instead of the namer, so a retune
 * supplies the same three slots the namer supplies and the same template puts
 * them together. What is left to bound here is only how *much* goes in a slot.
 *
 * Both halves of the feature answer the same failure. The reader asked why a
 * beat was not sending anything and could be told only "I can't change a beat";
 * the true answer that night was that its feeds had never been fetched, which
 * no amount of rubric editing would have fixed. So the reading tool has to
 * surface enough to reach that conclusion, and the writing tool has to be
 * narrow enough that reaching for it is not the reflex.
 */

export const retune = {
  /**
   * Bullets allowed in each half of a rubric.
   *
   * The namer asks for 4–6 and both seed beats sit at 4–5. The floor is lower
   * than the namer's because a reader narrowing a beat may genuinely want fewer,
   * and the ceiling is higher because adding a criterion is the common request —
   * but not unbounded: every bullet is read by the ranker on every article of
   * every run, and a rubric that lists twenty things to like is a rubric that
   * likes everything.
   */
  bulletCount: { min: 3, max: 8 },

  /**
   * One bullet. The longest in either seed beat is ~155 characters — "A model,
   * framework, or tool actually shipped — with a version number, release post,
   * or public availability" — so this leaves room to be more specific without
   * letting a bullet become a paragraph.
   */
  bulletMaxChars: 240,

  /**
   * The "You are curating for …" line. The first thing the ranking model reads,
   * and one sentence by construction; the seeds run 80–110 characters.
   */
  readerLineMaxChars: 300,

  /** What the reader asked for, stored verbatim on the superseded revision. */
  reasonMaxChars: 500,

  /**
   * How far back `inspect-beat` counts when reporting what a beat has done.
   *
   * Longer than the 7 days `/beats` reports, deliberately. A week is the right
   * window for "how is it going", but this is the window for "why is nothing
   * arriving" — and a quiet week is exactly the case that needs a second week
   * beside it to tell a broken beat from a slow subject. Retention is 30 days,
   * so nothing here asks for rows that have been pruned.
   */
  statsDays: 14,

  /** Feeds listed per beat. Above `discovery.maxFeedsPerBeat`, so none is hidden. */
  feedsShown: 12,

  /**
   * Scored articles returned, best score first.
   *
   * The single most diagnostic thing in the tool. A beat whose best score in two
   * weeks is 45 against a threshold of 60 has a rubric or a feed problem and the
   * reasons say which; a beat with no scored articles at all has neither, and is
   * simply not being fed. Those two look identical from outside and want
   * opposite fixes.
   */
  verdictsShown: 8,

  /** Past rubrics shown, newest first. Enough to see the last few changes. */
  historyShown: 5,
} as const
