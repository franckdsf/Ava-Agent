# ADR-0022: Ava is the system, and agents have their own names

- **Status:** Accepted
- **Date:** 2026-08-03

## Context

"Ava" meant two things at once and nobody had noticed, because for as long as
there was one agent the two readings picked out the same object.

It was the **system**: the repo (`ava-agent`), the database (`ava.db`), the
Docker volume (`ava-data`), the storage id (`ava-storage`), the compose service,
the thirteen `AVA_*` environment variables, the user agent every feed fetch
sends. And it was the **agent**: `src/mastra/agents/ava.ts`, `id: 'ava'`,
`name: 'Ava'`, the bot's Telegram profile, and the first line of a 170-line
prompt — *"You are Ava, a personal assistant living in a Telegram chat with one
reader."*

The collision became a problem the moment a second agent was planned. A job
agent — **Joob**, pulling interesting job postings — is meant to sit beside the
conversational one and **share the same memory and the same tables**: the
`memories` table, the two-tier promotion of [ADR-0014](0014-two-tier-memory-for-ava.md),
the beats, the articles. That is the whole reason for putting it in this repo
rather than a second one.

With one name for both layers there is no way to say where it goes. "Ava's
memory" would mean the system's `memories` table on one reading and one agent's
private notes on the other, and the two answers imply different schemas. Every
sentence in `AGENTS.md` and in twenty-one ADRs carried the same ambiguity
unresolved.

## Decision

**Ava is the system. Agents that live inside it have their own names, and the
conversational agent is now Newy.**

- **The system keeps every `ava` it has.** `ava.db`, `ava-data`, `ava-storage`,
  `ava-agent`, the compose service, the `AVA_*` variables, the feed user agent.
  None of it was renamed. All of it was already correct under the new reading,
  and renaming it is a migration — a new volume, a re-seeded database, a rewrite
  of `.env` on every deployment — bought with nothing.
- **The agent is renamed throughout.** `src/mastra/agents/ava.ts` →
  `newy.ts`, `avaId`/`avaChannels` → `newyId`/`newyChannels`, `id: 'ava'` →
  `id: 'newy'`, `name: 'Newy'`, and the prompt's first line. Sixty-one prose
  references across `src/` and `scripts/` moved with it, plus twenty-nine in the
  living documents.
- **The bot's Telegram profile becomes `Newy 🪶`.** The bot is the agent's face,
  not the system's — a reader talks to Newy, and a reader who later talks to Joob
  should see Joob. This is the part of the decision with a real cost; see below.
- **Newy stays she/her.** The pronoun was not the ambiguity, and rewriting forty
  comments to they/them would have buried the rename in noise.
- **A knob shared by every conversational agent keeps its role name.**
  `AVA_MODEL_ORCHESTRATOR` is *not* renamed to `AVA_MODEL_NEWY`. It names the
  model a reader talks to, and Joob will read the same variable — so retuning
  the conversational surface is one edit that moves every agent on it, which is
  the intent rather than an accident of naming. An agent that needs its own model
  for a reason of its own earns its own variable then.
- **ADRs 0001–0021 are frozen, not rewritten.** This repo's own rule is that an
  accepted ADR is never rewritten, and a rename is a poor first exception. Where
  they say "Ava" of the chat agent — most visibly
  [ADR-0010](0010-ava-answers-only-in-the-chat-tab.md) and
  [ADR-0014](0014-two-tier-memory-for-ava.md), both of which carry it in their
  filenames — read "Newy". This ADR is the mapping, and `AGENTS.md` says so under
  **Names**.

Nothing structural changed. This is a rename plus a rule, and the rule is the
part worth keeping: *lowercase `ava` in a path or an identifier is the system; a
capitalised name in a prompt or a tab is an agent.*

## Consequences

**Good:** the question "where does Joob's memory live?" now has an answer that
can be stated — in Ava's `memories` table, shared, because memory is a system
facility and not one agent's property. Adding an agent no longer requires
deciding what to do about a name that was already taken by the thing it lives
inside. The `AVA_*` surface is untouched, so no deployment, volume, `.env` or
database moves for this.

Verified: `pnpm typecheck` clean after the rename. The agent id is safe to change
because nothing persists it — `mastra_threads` keys on
`resourceId: telegram:<chatId>`, `mastra_schedules` on `wf_*` workflow ids, and
`mastra_channel_installations`, `mastra_channel_config` and `mastra_agents` are
all empty. Conversation history survives the rename.

**Costs:**

- **The bot renames itself on the next boot, and `setMyName` is flood-limited.**
  `publishProfile()` reads each field back and pushes only what drifted, so this
  is one write — but it is a *visible* one: the chat title changes on every
  message the bot has ever sent, retroactively, in the reader's client. There is
  no undo that isn't a second flood-limited write.
- **The repo and the docs now disagree with the ADRs on purpose.** Someone
  reading `0010-ava-answers-only-in-the-chat-tab.md` cold will not find `ava.ts`.
  That is the cost of the freeze rule, paid deliberately, and mitigated only by a
  pointer in `AGENTS.md` and by this file.
- **One bot, two agents, is not yet solved.** The profile is now Newy's, and
  Joob has no surface. Either Joob gets its own token — which means a second
  poller and a direct collision with [invariant 7](../../AGENTS.md#invariants),
  since exactly one adapter may poll — or the two agents share one bot and the
  profile stops belonging to either. This ADR does not decide it; it only makes
  the choice visible, where before the naming hid it.
- **`AVA_MODEL_ORCHESTRATOR` now reads oddly against `newy.ts`.** A variable
  prefixed for the system, named for a role, read by an agent named neither. The
  comment on it explains this, and an explanation is weaker than a name that
  needs none.

**Revisit if:** Joob needs a model, a memory scope or a prompt that Newy must not
share — the first of those reopens `AVA_MODEL_ORCHESTRATOR`, the second reopens
whether `memories` is one table or one per agent, which is the assumption this
whole ADR is built to protect. Also revisit if a second bot token turns out to be
the answer to the surface question above, since that makes the bot profile an
agent-level concern permanently and invariant 7 needs restating in terms of
tokens rather than adapters.
