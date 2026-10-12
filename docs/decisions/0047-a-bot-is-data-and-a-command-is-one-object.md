---
id: 0047
applies_to: ["src/bots/**", "src/services/telegram.ts", "src/mastra/registrar.ts", "src/mastra/chat-bots.ts", "src/mastra/chat-surface.ts", "src/mastra/quoted-message.ts", "src/mastra/agents/chat-agent.ts", "src/mastra/commands/**", "scripts/checks/c7-bot-agnostic.mjs"]
status: accepted
supersedes: []
verify: "pnpm verify"
---

# ADR-0047: A bot is data, built into an agent and a surface once; a command is one object

- **Status:** Accepted
- **Date:** 2026-10-12
- **Bears on:** [ADR-0023](0023-a-bot-per-agent-two-tokens-two-chats.md) (a bot per agent — its
  registry moves from `config/bots.ts` to `src/bots/`), [ADR-0002](0002-telegram-via-chat-sdk-adapter-in-polling-mode.md)
  and [ADR-0010](0010-ava-answers-only-in-the-chat-tab.md) (the polling adapter and the chat-tab
  routing are now built in one place), [04-BLUEPRINT](../audit/04-BLUEPRINT.md) Parts 1 and 2

## Context

The audit ([03 F3](../audit/03-FLAWS.md#-f3--a-bot-is-four-copied-files)) found each bot spread over
four copied files plus edits in three more: an agent file 65% the same as the other bot's after
normalising names, a registrar 53% the same, a one-line transport file, a topic file differing in
slugs. `welcome`, `unknown`, `commandMenu` and `commandList` were each written twice; the "every
branch ends in a message" try/catch four times; the slow-reply acknowledgement once, with a test that
tested a copy of it. A command was two files — text in `config/*-commands.ts`, handler in
`mastra/commands/*.ts` — joined by an `is*` predicate and a `run*` switch.

## Decision

**A bot is a data file in `src/bots/`** — id, env prefix, tabs, profile — and nothing else. It
imports only types, so the workflows and commands that send through a bot can import it without a
cycle. Everything else is built from it by code written once:

| Built once | From | Replaces |
| --- | --- | --- |
| `transportFor(bot)`, memoised per bot | `src/bots/index.ts` | `services/{newy,joob}-telegram.ts` |
| `createChatAgent(surface, spec)` — polling adapter, memory, chat-tab routing, provider options | `agents/chat-agent.ts` | the shared two thirds of `agents/{newy,joob}.ts` |
| `registerBot(mastra, surface, channels)` — catch-all, menu, `/start`, unknown reply, profile | `mastra/registrar.ts` | `mastra/channels.ts`, `mastra/joob-channels.ts` |
| `runCommand(command, ctx, failed)` — one try/catch, one deferred acknowledgement | `commands/command.ts` | four try/catches, one ack timer |

**A command is one `Command` object** — name, menu description, help, usage, tab, `working`, `run` —
beside its handler. A bot's surface (`commands/<bot>.ts`) groups its commands into sections and adds
its `/start` and its failure wording; the menu, the `/start` list and the unknown-command reply are
all derived from those objects, so they cannot disagree. A name offered twice throws at boot.

**Three places per bot, not the blueprint's one file.** The data file must stay a leaf (C2), and the
agent stays in `src/mastra/agents/` where slice 6's model boundary puts every `new Agent(`. A bot's
agent file is its prompt and tools; its command files are its handlers.

**C7 holds the shared half shared.** No bot name — identifier or string, any case — in the code of
`src/services/`, `src/db/`, `src/lib/`, `src/config/` or the shared files in `src/mastra/` (registrar,
runner, builder, routing, the quote wrapper). The names come from the files in `src/bots/`, so a new
bot is covered the moment it exists. What a bot owns — its workflows, commands, agent, tools — is out
of scope on purpose.

## Consequences

- **A third bot is:** `src/bots/<bot>.ts`, `agents/<bot>.ts`, `commands/<bot>.ts` and its command
  files, plus **two** registry lines — `BOTS` in `src/bots/index.ts` (transports, `telegram:check`) and
  `CHAT_BOTS` in `src/mastra/chat-bots.ts` (agent and surface). Two lists because the first is data
  the services read and the second imports agents, which the data layer must not.
- **Measured** against the same surface: 19 files and 3,966 lines (2,204 of code) before, 20 files and
  3,672 lines (2,067 of code) after. The line count barely moves — the comments moved with the code.
  What moved is that each mechanism exists once.
- **`/target` and `/retarget` gained the holding message** `/client` had, by setting `working`. One
  reader-visible change, agreed. Everything else each bot shows was pinned in
  `src/mastra/__tests__/bot-surface.test.ts` before anything moved, and passed unchanged.
- **Each bot keeps its own failure wording.** Newy says nothing was changed; Joob names the error.
  `failed` is on the surface rather than unified, because unifying would change what a reader sees.
- **Not built: a shared criteria helper for `/target` and `/client`.** Blueprint Part 2 proposed one.
  The two render different fields in different formats, so sharing would change rendered text or
  produce a parameterised helper as long as the two. What they shared — dispatch and the try/catch —
  is in `Command` and `runCommand`.
- **`Command.usage` is optional**, because the reading commands never had one; commands that read
  their own usage are typed with `satisfies` to keep it required where it is read.
- **C7 is a text check.** A bot name assembled at runtime (`'jo' + 'ob'`) passes it. Accepted for
  the reason every check here is text-based (`scripts/checks/_lib.mjs`).

## Verify

`pnpm verify` — C7 (`pnpm verify:bots`), C2, and `bot-surface.test.ts` and `command.test.ts` among
the tests.
