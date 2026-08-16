# ADR-0033: A delivery is claimed before it is sent, not stamped after

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

`deliverBeat` sent a story to Telegram and *then* wrote `delivered_at`, guarded
on `delivered_at is null`. The guard's own docstring claimed it stopped a
concurrent beat double-sending a story arbitration had awarded elsewhere. It
stopped the double *write*. It never stopped the double *send*: by the time the
guard was evaluated the message was already on the reader's phone, and the
guarded update simply matched no rows and reported nothing.

Nothing exercised that gap while one digest ran at a time. On 2026-08-16 two ran
at once.

Ava was down from roughly 13:00 Paris on 14 August. It came back at 13:21 on the
16th, and the scheduler replayed every overdue occurrence in the same tick —
`prune-articles`, `find-jobs`, and **both** digest schedules: `digest-2000`'s
missed fire from the 14th and `digest-1000`'s missed fire from the 15th, started
146 ms apart. Two `curate-all` runs then walked the same pipeline over the same
article pool and reached delivery within seconds of each other. Seventeen stories
carry a single `delivered_at` stamp between 13:31:32 and 13:33:01; the second run
ran its full eleven minutes and stamped none of them.

**This corrects a premise in [ADR-0025](0025-a-boot-catch-up-for-a-stale-pipeline.md),
not its decision.** That ADR rejected "fire the missed occurrences" as an
approach and stated Mastra deliberately does not do cron catch-up on resume. It
does — one missed occurrence per schedule row, replayed at boot. ADR-0025's own
boot catch-up behaved correctly here and fired nothing: news was 1.7 days stale
against a seven-day bar, and `decideCatchup` declined. The two runs came entirely
from the scheduler's replay. ADR-0025 stands as written; what was wrong was the
belief that the platform would never put two scheduled runs in flight at once,
and that belief is exactly what made "send, then stamp" look safe.

Three ways not to fix it:

- **Gate `curate-all` on its own last run**, the way `findJobs` gates on
  `job_runs.startedAt` — the obvious symmetry, and the weaker half. It stops two
  runs *starting* and does nothing about two that overlap for any other reason: a
  hand-fired `pnpm workflow:run`, the 504 that does not stop a run, a second
  process against the same volume. It also needs somewhere to record "when did
  news last run", which the claim does not.
- **A lock table.** The same coverage as a claim, plus a lease and an expiry,
  because a lock held by a crashed run has to time out. The rows being locked
  already have a column that means "spent".
- **Dedupe in the transport.** Remember recent message texts in
  `newy-telegram.ts`. That puts pipeline state in the transport and answers "have
  I sent this?" with a heuristic, when the database holds the fact.

## Decision

**A story is claimed before it is sent, and the claim is handed back if the send
fails.**

`claimForDelivery(ids, beatSlug, kind)` replaces `markDelivered`. It is the same
guarded update with `.returning()` on the end: it stamps `delivered_at`,
`delivered_beat` and `delivery_kind` where `delivered_at is null`, and returns
the ids it actually won. SQLite serialises writers, so of two runs holding the
same story exactly one update matches a row. **The returned ids are the
permission to send.** A claim that comes back empty means another run owns the
story; this one logs a line and skips it, which is not an error and is the first
time that condition has been visible at all.

`releaseDelivery(ids)` clears the three columns when the send throws, putting the
story back in play for a later run.

**The claim is taken per message, immediately before the send — not before
composition.** Claiming the whole batch up front would save a second run the
writer calls it spends on stories it will not send, at the price of a much wider
window in which a crash strands them stamped-but-unsent; composition is the slow,
model-calling part of the step. Paying twice for prose nobody reads is the
cheaper mistake.

## Consequences

**Good:** two overlapping runs cannot deliver the same story, and the fix does
not depend on knowing how they came to overlap — boot replay, a terminal-fired
run, a 504 that left the first one going. It sits at the point of delivery, which
is the one place every path passes through. The guard that was documented as
preventing a double send now actually prevents one, and "another run holds this"
is a log line instead of a duplicate on a phone.

**Costs:**

- **The failure direction is inverted: a story lost rather than repeated.** A
  process killed between the claim and the send leaves a story stamped delivered
  and never sent, and nothing retries it. The window is one statement wide and
  only a hard kill reaches it — a send that throws is released — but it is a
  change in kind, and a story that silently never arrives is harder to notice
  than one that arrives twice.
- **A send that throws *after* Telegram accepted the message now duplicates.**
  The release puts the story back and a later run sends it again. This was
  equally true of the old shape, but it is now the only remaining duplicate path,
  which is worth naming rather than leaving as a known-unknown.
- **The duplicate work is still paid for.** A second overlapping run fetches,
  ranks and composes over the same pool and throws it away at the claim. This
  protects the reader, not the bill; a run-level gate is what would protect the
  bill and it is deliberately not written here.
- **It leans on there being one writer.** Two processes against one libsql file
  serialise and this holds; two replicas against separate files would not.
  [Invariant 6](../../AGENTS.md#invariants) already assumes a single replica, and
  this leans on it slightly harder.

**Revisit if:** a second delivery path appears. `delivery_kind` already admits
`'breaking'` and nothing writes it; the moment something does, two send sites
will each need the claim and it should move into one helper rather than be
repeated. Also revisit if boot replays become routine rather than exceptional —
at that point the run-level gate is worth having *as well*, to stop paying for
runs whose output is discarded.
