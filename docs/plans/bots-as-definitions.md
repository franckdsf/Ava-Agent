---
slice: bots-as-definitions
branch: main
status: active
---

> **Intent before implementation.** This file describes what we agreed to build, not what exists.
> If it disagrees with the repo, **the repo is right and this file should already be gone** —
> see [README.md](./README.md).

# Slices 4 + 5 — Bots and commands as definitions

After this lands a third agent is a bot file, an agent file, its command files and one registry line —
not four copied files and three edits — and a command is one object, so the menu, `/start` and the
unknown-command reply cannot disagree about it.

[04-BLUEPRINT Parts 1 and 2](../audit/04-BLUEPRINT.md#part-1--a-bot-is-a-definition-f3-f12), fixing
[03 F3 and F12](../audit/03-FLAWS.md#-f3--a-bot-is-four-copied-files). Done as one slice (agreed
2026-10-12): a shared registrar needs a command shape, and building a temporary one for slice 5 to
replace was the alternative.

---

## 1. Problem

**What is broken.** Nothing the reader sees. Each bot is a parallel set of files that differ in data —
two one-line transport files, two topic files, two registrars (53% overlap: `welcome`, `unknown`,
`commandMenu`, `commandList` each written twice), two agents (65%: the adapter block, memory, routing
and provider options are the same code). A command is two files joined by an `is*` predicate and a
`run*` switch, and the "every branch ends in a message" try/catch is written four times. The ack timer
in `clients.ts` has a test that tests a copy of it (`find-leads.test.ts`, `@limitation`).

**How we would know it worked.**

| Measure | Before (`3a12894`) | After |
| --- | --- | --- |
| Files a bot is spread over | 4 own + edits in `bots.ts`, `bot-profile.ts`, `index.ts` | its file in `src/bots/`, its agent, its command files, and 1 registry line |
| Lines in the replaced set² (19 files) | 3,966 | reported at landing |
| Registrars · chat-agent constructions · command try/catches | 2 · 2 · 4 | 1 · 1 · 1 |
| `is*Command` predicates · `run*` switches · `config/*-commands.ts` | 5 · 5 · 3 | 0 · 0 · 0 |
| `/start`, unknown reply, menu, profile — both bots | — | **byte-identical**, pinned by a test written first |
| Ack race tested | a copy | the real one |

² `services/{newy,joob}-telegram.ts`, `mastra/{channels,joob-channels}.ts`, `agents/{newy,joob}.ts`,
`config/{bots,bot-profile,newy-topics,joob-topics,beat-commands,job-commands,lead-commands}.ts`,
`mastra/commands/*.ts`.

**Invariants it sits closest to.** **7** — one adapter per token, `mode: 'polling'` never `'auto'`:
the adapter block moves into one builder, the only `createTelegramAdapter` call. **8** — what a
conversation may write: commands keep writing exactly what they write today (`beats`, `beat_feeds`,
`job_searches`, `client_profiles`); no handler gains a write. **9** — answers only in the Chat tab:
`routeToChatTab` is unchanged, and each command keeps the tab it answers in today.

---

## 2. Architecture

**Schema** — none. `telegram_topics` is keyed `(chatId, slug)`; bot ids and slugs are unchanged.

**Surface** — no new command, tab, workflow or tool. Where things land:

```
src/bots/newy.ts                 data   id · envPrefix · topics · profile          (leaf module)
src/bots/joob.ts                 data   the same for Joob
src/bots/index.ts                data   BotDefinition, BOTS, transportFor(bot)
src/mastra/agents/chat-agent.ts  code   createChatAgent(bot, spec) — adapter, memory, routing, options
src/mastra/agents/newy.ts        Newy   prompt + tools + inbound wrapper → createChatAgent
src/mastra/agents/joob.ts        Joob   prompt + tools → createChatAgent
src/mastra/commands/command.ts   code   Command, CommandContext, runCommand (the one try/catch + ack)
src/mastra/commands/beats.ts     Newy   one Command per beat command, text beside its handler
src/mastra/commands/translate.ts Newy   /translearn, /translate
src/mastra/commands/summarize.ts Newy   /summarize
src/mastra/commands/targets.ts   Joob   /target /targets /retarget /untarget
src/mastra/commands/clients.ts   Joob   /client /clients /reclient /unclient
src/mastra/commands/criteria.ts  code   the criteria echo targets and clients share (reply, describeChanges, renderCriteria)
src/mastra/commands/newy.ts      Newy   her sections and her /start text
src/mastra/commands/joob.ts      Joob   its sections and its /start text
src/mastra/registrar.ts          code   registerBot — catch-all, menu, list, unknown, profile
src/mastra/chat-bots.ts          data   CHAT_BOTS, one line per bot; index.ts registers from it
src/mastra/quoted-message.ts     code   withQuotedMessage, moved verbatim out of channels.ts
```

**Deleted:** `services/{newy,joob}-telegram.ts`, `mastra/{channels,joob-channels}.ts`,
`config/{bots,newy-topics,joob-topics,beat-commands,job-commands,lead-commands}.ts`.
`config/bot-profile.ts` keeps `BotProfile`, `PROFILE_LIMITS`, `profileOverflows`. The **tunables** in
the command configs stay in `src/config/` (AGENTS: tunables there, no magic numbers): `beatCommands` →
`config/pipeline.ts`, `jobCommands` → `config/jobs.ts`, names unchanged so their readers in
`agents/` and `tools/` only change an import path. `TRANSLATIONS` and `summary` lose `help` and
`menuDescription` and keep everything the translator, summarizer and bench read.

**Why three places per bot, not the blueprint's one file.** C2 refuses an import cycle: workflows and
commands need a bot's transport, so they import its definition — which therefore cannot import its
commands or agent. `src/bots/<bot>.ts` stays a leaf. And slice 6's C5 puts `new Agent(` in
`src/mastra/agents/`, so the prompt, tools and builder live there. Each part is in the layer it
belongs to and none is a copy — P6 is about copies, not file count.

**Telegram surface** — unchanged, by construction and by test. **One deliberate exception, below:**
the failure message after a command throws.

**Flow** — unchanged. **State a scheduled call may write** — none; no schedule, model call or write
changes.

---

## 3. Program design

```ts
// src/bots/index.ts
export interface BotDefinition<Slug extends string = string> {
  id: string; envPrefix: string; topics: TopicList<Slug>; profile: BotProfile
}
export const BOTS: readonly BotDefinition[]                                        // [NEWY, JOOB]
export function transportFor<Slug extends string>(bot: BotDefinition<Slug>): TelegramTransport<Slug>
//   memoised per bot.id — the transport's caches are why newyTelegram was a singleton

// src/mastra/commands/command.ts
export interface CommandContext<Slug extends string = string> {
  mastra: Mastra; event: SlashCommandEvent; bot: BotDefinition<Slug>; transport: TelegramTransport<Slug>
  args: string                                   // event.args ?? event.text, trimmed
}
export interface Command<Slug extends string = string> {
  name: `/${string}`
  description: string                            // menu: ≤256 chars, no markdown
  help: string                                   // /start and unknown: markdown
  usage: string                                  // when arguments don't parse
  tab?: Slug                                     // where a returned reply goes; default the chat tab
  /** Set on a command that calls a model: the holding message after ackAfterMs. */
  working?: string
  /** A string is sent to `tab`; void means it sent its own messages (translate, summarize). */
  run(ctx: CommandContext<Slug>): Promise<string | void>
}
/** The one try/catch and the one ack race — what find-leads.test.ts's copy becomes a test of. */
export function runCommand<Slug extends string>(command: Command<Slug>, ctx: CommandContext<Slug>,
  failed: (command: string, error: unknown) => string): Promise<void>

// src/mastra/agents/chat-agent.ts
export interface ChatAgentSpec {
  name: string; tools: ToolsInput
  instructions: () => Promise<SystemMessage[]>   // static prefix + volatile block, as today
  inbound?: (handler: ChannelHandler) => ChannelHandler   // Newy: withQuotedMessage
}
export function createChatAgent<Slug extends string>(bot: BotDefinition<Slug>, spec: ChatAgentSpec): Agent

// src/mastra/registrar.ts
export interface BotSurface<Slug extends string = string> {
  bot: BotDefinition<Slug>; agent: Agent
  sections: { heading?: string; commands: Command<Slug>[] }[]   // Newy: Reading, Beats; Joob: one, unheaded
  welcome(surface: BotSurface<Slug>): Promise<string> | string
  failed(command: string, error: unknown): string
}
export function registerBot(mastra: Mastra, surface: BotSurface): Promise<void>
export function commandMenu(surface: BotSurface): { command: string; description: string }[]
export function commandList(surface: BotSurface): string
export function unknown(surface: BotSurface, command: string): string
```

`/start` is the registrar's: first in the menu, first line of the list. A command's `name` is its key,
so a duplicate across sections is a boot-time throw rather than one silently shadowing the other.

**Tunables** — none new. `leadPipeline.ackAfterMs` becomes the ack bar for every command with
`working`; today only `/client` and `/reclient` have one, and `/target`·`/retarget` — which call the
same kind of model — gain it. See decision 2.

**Checks:**

```
src/mastra/__tests__/bot-surface.test.ts      written FIRST, green on 3a12894: per bot — the menu,
                                              /start, unknown('/nope'), profile. Newy's /start on a
                                              seeded test database (it lists beats).
src/mastra/commands/__tests__/command.test.ts runCommand: fast reply → one message; slow → ack then
                                              reply, in that order; throw → failed() sent; void → nothing
                                              sent by the runner. Replaces the copy in find-leads.test.ts
                                              and removes its @limitation.
scripts/checks/c7-bot-agnostic.mjs + test     see decision 3
pnpm verify                                   typecheck · C1–C4, C7, C8 · tests
pnpm telegram:check                           both bots: profile current, six tabs found — no send
```

**Decisions I am least confident about.**

1. **The failure message stays per bot.** Newy says "`/x` failed and nothing was changed. Try again in
   a moment."; Joob says "`/x` failed: <error>". Unifying them would change what a reader sees, so
   `failed` is on the surface and both texts are kept. Unify later if you want one.
2. **`/target` and `/retarget` gain the slow-reply ack** `/client` has. They call the same kind of
   model and leave the reader in the same silence; with one `runCommand` it is a `working` string,
   not code. This **is** a visible change (a "reading that…" message on a slow parse) — say no and
   they keep none.
3. **C7 is scoped to the bot-agnostic layers**, correcting the blueprint's Part 7 row. "No bot name
   outside `src/bots/`" would forbid `find-jobs` sending through Joob's transport, but a workflow is a
   bot's — Part 1 says so of a third agent ("its commands and its workflows"). C7 forbids a bot name
   in *code* (comments exempt) in `src/services/`, `src/db/`, `src/lib/`, `src/config/`,
   `mastra/registrar.ts`, `mastra/chat-surface.ts`, `mastra/quoted-message.ts`,
   `commands/command.ts`, `commands/criteria.ts`, `agents/chat-agent.ts`. Names come from `BOTS`, not
   a list in the check. Those layers name a bot in code today only in files this slice moves, so C7
   lands with no baseline.

---

## 4. Slices

Joob first: no async welcome, no inbound wrapper, two command files — the shared code is proven on it
before Newy moves. Each step ends with `pnpm verify` green and is its own `(clean)` commit.

```
1. bot-surface.test.ts on 3a12894, green; measure the before  → the surface is pinned before anything moves
2. src/bots/ + transportFor; every importer switched          → bots, *-topics, *-telegram configs deleted
3. command.ts + runCommand + its test; @limitation removed    → the ack race tested on the real code
4. Joob's commands as Command objects + criteria.ts;
   registrar.ts + commands/joob.ts; joob-channels.ts deleted  → Joob from the shared registrar, test green
5. chat-agent.ts; agents/joob.ts on it                        → Joob built by the builder
6. Newy's commands as Command objects; quoted-message.ts;
   commands/newy.ts; agents/newy.ts; channels.ts deleted      → Newy the same way
7. chat-bots.ts; index.ts registers from it                   → one line per bot
8. C7 + its test; CONVENTIONS row; AGENTS "Current state";
   blueprint Part 7 C7 row corrected                          → the rule is held by a machine
```

---

## Landing

- [ ] `pnpm verify` green
- [ ] `pnpm telegram:check` run and read — both profiles current, all tabs found
- [ ] Before/after measured: files, lines of the replaced set, overlap
- [ ] `invariant-reviewer` spawned and clean, or its findings approved
- [ ] Live check, after your go: `/start`, an unknown command, `/targets`, `/beats` in both chats
- [ ] ADR: a bot is data in `src/bots/`; its agent and surface are built from it; a command is one
      object. AGENTS.md "Current state" names `src/bots/` instead of `config/bots.ts`
- [ ] Memory note updated
- [ ] **This file deleted**
