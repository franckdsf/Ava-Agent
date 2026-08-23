---
id: 0014
applies_to: ["src/db/memories.ts", "src/mastra/tools/memory.ts", "src/config/memory.ts"]
status: accepted
supersedes: []
---

# ADR-0014: Two-tier memory, dated and never rewritten

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Ava forgot everything between conversations. `lastMessages: 30` gives her the
recent turns of one thread and nothing else, so telling her something about
yourself bought you thirty messages of it. The only durable signal the reader
could send was a 👍/👎 on an article — which shapes the *ranker's* taste, not
what Ava knows about the person she is talking to, and which still isn't wired.

Two properties were wanted that a conversation log cannot express:

- **Facts have different lifespans.** A name is true for years; what you ate on
  Tuesday is true for about a week. One store treats them alike — either the name
  ages out or the lunches accumulate forever.
- **Facts change, and the change is information.** "Dark hair (2025-01)" followed
  by "blond hair (2026-01)" is not a contradiction to resolve, it is a history to
  read. An assistant that only knows the current value cannot say *"blond, since
  January — dark before that"*.

Mastra ships two memory features and neither fits. **Working memory** is a single
markdown blob with replace semantics: the model rewrites the whole document on
every update, which loses per-fact dates, silently drops facts on rewrite, and
offers nothing to prune or promote *rows* with. **Observational memory** compresses
message history into an observation log on token thresholds — it is a context-window
optimisation, not a fact store, and its tiers are token-driven where these are
time-driven. Both also live in `mastra_*`, which Mastra owns
([invariant 4](../../AGENTS.md#invariants)): a cron that deleted and promoted rows
there would be reaching into another system's tables.

## Decision

A `memories` table under Drizzle, one row per fact, with two tiers and two dates.

**Tier is chosen at write time by Ava**, not derived later. `long` is biography —
name, city, family, allergies, standing preferences. `short` is episodic — meals,
outings, what they are working on this week. The instructions tell her to prefer
`short` when unsure, because promotion is recoverable and a wrong `long` is not.

**Two dates, and they mean different things.** `happenedAt` is when the fact was
true, supplied by Ava when the reader dates it themselves ("I ate there on
Saturday"); it orders the rendered block. `createdAt` is when the row was written
and is what the short-term window measures — so a fact learned today about
something six months ago survives its first month rather than being invisible on
arrival.

**Nothing is ever rewritten.** A fact that stops being true is not corrected; the
new one is recorded with its own date, both are rendered oldest-first, and the
prompt says a later line supersedes an earlier one. Deletion (`forget-memory`)
exists only for a fact that was never true, or that the reader asks to erase.

**The id is a hash of the normalized fact**, the same device `items` uses on the
canonical link ([invariant 5](../../AGENTS.md#invariants)): re-stating something
verbatim collides instead of accumulating a duplicate line in a prompt that is
re-sent every turn. It catches only verbatim repeats — the real guard is that Ava
is shown everything she already knows before she decides to write anything.

**Retrieval is injection, not a tool call.** `instructions` is now an async
function returning two system messages: the static prompt, then today's date and
the notes. Two messages rather than one concatenated string so the long static
half stays byte-identical between turns and remains a cacheable prefix. A tool
would have made recall optional, and a model that has to *decide* to look
something up mostly doesn't.

**Writing is a tool, called mid-turn.** `remember` is called before she answers,
without asking permission and without announcing it. The alternative — a second
extraction model pass after each turn — is a second bill on every message and one
more thing to go wrong on the inbound path.

**No reader column.** The bot has one reader by construction: an allowlist of
user ids, one chat id, a single replica. A `resource` column would be a constant
in every row. Adding one is the migration to run the day a second reader exists.

### What is deliberately not built yet

The cron. Short-term expiry is enforced **in the prompt** — notes past
`memoryConfig.shortTermDays` stop being shown — but nothing deletes them.

A sweep that deleted at 30 days without a promotion step would throw away the one
short-term note that turned out to be biography, with no way to notice it had
gone. Promotion needs a judgement ("is this still worth keeping?"), which means a
model on a schedule, which is the shape [invariant 2](../../AGENTS.md#invariants)
exists to be careful about — a classifier over a fixed row set is fine, an LLM
choosing its own control flow is not. That is a decision worth making on its own
rather than smuggling in here. Until then nothing is lost, and the prompt cost is
already bounded by the window and the caps.

## Consequences

**Good:** memory survives restarts, threads and months, because it is a table
rather than a context window. The reader can now tell Ava things and have them
stick, which is the "real feedback system" the 👍/👎 loop never was. The
supersession reading works — verified against the live model, *"Blonds, depuis
janvier 2026. Auparavant, vous les aviez foncés."* Facts are inspectable and
editable in `pnpm db:studio`, which no prompt-embedded blob is. And the whole
history is queryable later: the promotion job, an "on this day", or a profile
export are all reads against rows that already exist.

**Costs:** every turn now carries the notes block — up to 100 lines by
configuration, a standing per-message cost that grows with how much she knows,
where before it was zero. Every turn also risks a `remember` call the reader
didn't ask for; a model that over-records fills the block with noise, and the
only brake is prompt wording. The block is rebuilt per request, so two indexed
queries sit in front of every reply. Verbatim-hash dedupe misses paraphrase, so
"Their name is Franck" and "The reader is called Franck" are two rows. Short-term
memories accumulate in the database indefinitely until the cron exists — bounded
in the prompt, unbounded on disk, which is the same trade `feedback` already
makes and for the same reason: a human types these, one at a time. And the
conversational surface can now write, which is a genuine loosening of
[invariant 8](../../AGENTS.md#invariants) — narrowed to "writes `memories`,
nothing else" rather than removed.

**Revisit if:** the notes block measurably degrades answers by crowding the
prompt — in which case retrieval becomes selective (embed the facts, inject the
relevant ones) rather than wholesale, and the caps stop being the mechanism. Or
if Ava proves unreliable at deciding *when* to record, in which case extraction
moves to a background pass over the turn instead of a tool she must remember to
call. Or on the day there is a second reader, which is a column and a migration.
