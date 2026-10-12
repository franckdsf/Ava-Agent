---
id: 0023
applies_to: ["src/bots/**", "src/services/telegram.ts", "src/mastra/channels.ts", "src/mastra/registrar.ts"]
status: amended
supersedes: []
verify: "pnpm telegram:check"
---

# ADR-0023: A bot per agent — two tokens, two chats, one process

- **Status:** Accepted — variables amended by [ADR-0041](0041-one-deployment-one-reader.md), which merges each bot's allowlist and chat id into one `AVA_TELEGRAM_USER_ID`. The decision here — a token per agent — is untouched; only the three-variables-per-bot shape is.
- **Date:** 2026-08-03
- **Answers:** the open question left by
  [ADR-0022](0022-ava-is-the-system-agents-have-names.md), which named this as its
  own revisit condition — *"revisit if a second bot token turns out to be the
  answer to the surface question, since that makes the bot profile an agent-level
  concern permanently and invariant 7 needs restating in terms of tokens rather
  than adapters."*

## Context

ADR-0022 split the name — Ava is the system, Newy is an agent — and deliberately
stopped short of deciding how a second agent reaches a reader. It listed the two
candidates and declined to choose:

> Either Joob gets its own token — which means a second poller and a direct
> collision with invariant 7 — or the two agents share one bot and the profile
> stops belonging to either.

Joob is now real enough to force it: a job agent, pulling postings that fit the
reader, delivering on its own schedule ([ADR-0024](0024-joob-a-job-pipeline-beside-the-news-one.md)).

**Sharing one token cannot work, and the reason is narrower than "the profile is
global".** Of the four profile methods, only one is scopeable. `setMyCommands`
takes a `scope`, so the menu genuinely could differ per chat. `setMyName`,
`setMyShortDescription` and `setMyDescription` take **`language_code` and nothing
else** — there is no per-chat variant and no way to add one. A shared token means
one name and one blurb for both agents, so the chat title above every message
Joob ever sends reads `Newy 🪶`, retroactively and permanently. The thing
ADR-0022 established — that the bot is the agent's face — would be false the day
the second agent shipped.

The second reason is [invariant 9](../../AGENTS.md#invariants), from the other
direction. *One tab, one kind of traffic* is enforced today within one chat.
Two agents on one token share one chat and therefore one tab strip: Chat, News,
Translations, a tab per beat, **and** Jobs — where the Chat tab would have to
serve two different agents with two different prompts and one Mastra thread. The
tab split exists so a reader always knows what a tab is for; a Chat tab answered
by whichever agent guessed it was addressed is the failure that rule was written
against.

**Invariant 7 is not the obstacle it looks like.** Its wording forbids a second
poller, but its stated *reason* is that "two pollers consume each other's
updates" — which is true of two adapters on **one token**, sharing one
`getUpdates` offset. Two tokens are two independent update queues, and neither
adapter can see the other's traffic. The invariant was written when one token was
the only case; it names the mechanism correctly and generalises wrongly.

**`telegram_topics` needed a third key column, and the first draft of this ADR
got that wrong.** It said the existing `(chatId, slug)` key already made two bots
safe, "so both bots can own a tab called `chat` with no collision, and no
migration". That is true of supergroups and false of private chats — which is the
deployment here. In a private chat Telegram's `chat.id` **is the user's id**, and
user ids are global rather than per-bot, so Newy and Joob talking to the same
person both see chat `8401775038` and both write a row keyed
`('8401775038', 'chat', …)`.

The consequence is destructive rather than merely confusing: the second bot finds
the first bot's row, adopts a thread id that does not exist in its own
conversation, fails to send, and `invalidateTopic` deletes the *other* bot's row
— which that bot then recreates, and `createForumTopic` is not idempotent, so a
duplicate tab appears. The two would fight indefinitely. `bot_id` is now part of
the primary key (`0013`).

## Decision

**Each agent gets its own bot token, its own chat, and its own tab set. One
process, one Mastra instance, one database.**

- **`src/config/bots.ts` is the registry.** One entry per bot: id, env prefix,
  topic set, profile, command list. It is what the transport is constructed
  against, replacing the module-level singletons in
  [`telegram.ts`](../../src/services/telegram.ts) and the
  `telegramEnv()` reads scattered through
  [`telegram-topics.ts`](../../src/services/telegram-topics.ts).
- **Topics become per-bot.** `src/config/topics.ts` keeps the shared vocabulary —
  `TopicDefinition`, `topicTabName`, `TAB_NAME_MAX_CHARS`, the beat namespace.
  Newy's three move to `newy-topics.ts` with **their slugs unchanged**, since
  renaming a slug orphans its row. Joob's live in `joob-topics.ts`.
- **Env is prefixed per bot, including the first.** `NEWY_TELEGRAM_*` and
  `JOOB_TELEGRAM_*`. Newy's were briefly left bare on the argument that renaming
  costs an edit on every deployment — there is one deployment, and
  `docker-compose.yml` uses `env_file`, so the whole cost was `.env` and
  `.env.example`. Set against a bare name that reads as "the default bot" beside
  an explicit `JOOB_`, symmetry won.
- **`telegram_topics` is keyed `(botId, chatId, slug)`**, for the reason above.
  Migration `0013` recreates the table and backfills `newy`; the generated
  `INSERT … SELECT` had to be hand-edited because it selected the new column from
  the old table.
- **The beat-tab machinery stays Newy's.** The fallback chain, `beatTopicCache`
  and `BEAT_TOPIC_PREFIX` exist because beats create tabs lazily and a
  `createForumTopic` can fail ([ADR-0021](0021-a-tab-per-beat.md)). Joob has a
  fixed tab set and no per-search tabs, so it needs none of it. The transport is
  generic over a bot; beat tabs are a layer above it, not inside it.
- **`AVA_MODEL_ORCHESTRATOR` stays shared**, exactly as ADR-0022 specified —
  Joob is a second agent on the same conversational surface, which is the case
  that rule was written for.
- **`memories` stays one table, shared.** This is the assumption ADR-0022 was
  built to protect, and Joob is the agent it was protecting it for. Both agents
  read and write the same notes; the reader is the same person. See ADR-0024 for
  the one thing deliberately kept *out* of it.

## Invariants this changes

**Invariant 7** — "exactly one adapter polls" becomes **exactly one adapter polls
per bot token**. The mechanism is unchanged and is the part worth keeping: two
adapters sharing a token share a `getUpdates` offset and consume each other's
updates. `mode: 'auto'` remains forbidden for the same reason as before — it
falls back to *webhook* when it cannot verify `getWebhookInfo`, which silently
breaks invariant 1 for whichever bot it happens to.

`src/services/telegram.ts` stays outbound-only for **every** bot, and no
outbound instance may ever be constructed with a `mode`.

**Invariant 9** — "one tab, one kind of traffic" gains a level above it: **one
bot, one agent, one chat.** The tab rule is unchanged inside a chat. What is new
is that the question "which tab does this belong in?" is only ever asked within
one bot's chat, and no message crosses between them.

**Invariant 6 is unchanged and now matters more.** A second replica would
double-poll *two* tokens and double-send two schedules.

## Consequences

**Good**

- Joob has its own name, its own profile page, its own empty-chat blurb and its
  own `/` menu, with no scope juggling and no field that has to lie.
- Two chats means two tab strips, so neither agent's traffic is diluted by the
  other's. A reader looking for a job is in a different conversation from one
  reading the news, which is what they would ask for if asked.
- Nothing structural is shared *wrongly*: one database, one migration set, one
  container, one Mastra instance, one set of `AVA_*` knobs. The split is at the
  surface, which is where the difference actually is.
- The transport refactor is mechanical — about eight call sites across two files
  plus `env.ts` and `newy.ts`.

**Costs**

- **Two long-poll loops in one process.** Idle network chatter doubles, and both
  surfaces die together when the process does. That was already true of one, and
  invariant 6 means it stays a single replica, so nothing is *recovered* by the
  split either.
- **`TopicSlug` was a closed union and now cannot be one for everybody.**
  `keyof typeof TOPICS` fed `SendTarget`, `TabSlug`, `Hop` and `invalidateTopic`.
  Each bot declaring its own union keeps the type safety and costs generic
  plumbing through the transport; widening to `string` is cheaper and loses the
  distinction between a system tab and a beat tab that `BEAT_TOPIC_PREFIX` exists
  to protect. The plumbing is the choice made here, and it is the least pleasant
  part of the change.
- **Threaded Mode is manual, per bot.** It is the one prerequisite no code can
  set ([ADR-0021](0021-a-tab-per-beat.md)), and there are now two of them to
  forget. A bot without it degrades to flat delivery silently, which is the
  correct behaviour and an unhelpful symptom.
- **Two flood-limit budgets on `setMyName`.** A container in a restart loop can
  now lock two bots out of renaming themselves for the day. `publishProfile()`
  diffs first, so this is latent rather than likely.
- **`pnpm telegram:check` becomes per-bot** and needs an argument. A check that
  silently reports on only one of two bots is worse than one that asks.
- **Shared memory crosses a chat boundary the reader can see.** Something told to
  Joob is known by Newy, and vice versa. That is the intended design and it will
  still be surprising the first time it happens in the other chat.
- **A second token is a second thing to provision.** Two BotFather bots, two
  chat ids, two allowlists, five new environment variables.

**Revisit if:** a third agent appears — three tokens and three chats is a
different proposition from two, and at that point the registry is doing enough
work that per-bot topic unions may be worth trading for a single generic slug
type. Also revisit if Telegram ever gives `setMyName` a scope, which would make
one token genuinely viable and this whole ADR a cost with no remaining benefit.
