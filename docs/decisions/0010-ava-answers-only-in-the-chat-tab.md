---
id: 0010
applies_to: ["src/mastra/agents/chat-agent.ts", "src/mastra/chat-surface.ts", "src/mastra/registrar.ts"]
status: accepted
supersedes: []
---

# ADR-0010: Ava answers only in the Chat tab

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

[ADR-0009](0009-telegram-topics-as-tabs.md) created the tabs and listed the gap
as a cost: *"Ava answers in whichever tab you message her in. Nothing scopes her
to the Chat tab."* Using it made the gap the point — the tabs only earn their
keep if each one holds one kind of traffic.

Two separate mechanisms turned out to be missing, because Telegram messages
reach the agent by two different paths.

**Ordinary messages answer where they were typed.** Mastra's default channel
handler keys the Mastra thread on the inbound thread id and posts the reply back
to it. Typing in News gets an answer in News, and — worse — a *second*
conversation memory rooted there.

**Anything starting with `/` never reached the agent at all.** Verified in the
compiled `@chat-adapter/telegram` 4.35: `handleSlashCommandUpdate` claims any
message whose first entity is a `bot_command`, routes it to
`chat.processSlashCommand`, and returns `true` — which makes `processUpdate` skip
`handleIncomingMessageUpdate` entirely. With no `onSlashCommand` handler
registered, the Chat SDK iterates an empty handler list and the message is
dropped. `/start` did nothing, silently, and so would any other `/word`.

That also explains the third symptom: tabs were only ever created by the
*outbound* digest path, so a reader who typed `/start` at a fresh bot saw
neither tabs nor an answer.

## Decision

**Ava speaks in the Chat tab and nowhere else. The pipeline speaks in News and
nowhere else.**

- A `ChannelHandler` (`routeToChatTab` in `src/mastra/channels.ts`) is wired to
  all three inbound events — `onDirectMessage`, `onMention`,
  `onSubscribedMessage`, because which one fires depends on the chat type. It
  swaps the inbound thread for the Chat tab's before calling the default
  handler, which the Chat SDK supports directly: `sdk.thread(id)` rebuilds a
  Thread from an id alone.
- Messages typed elsewhere are **moved, not refused**. Refusing needs a reply in
  the wrong tab to say so; moving keeps one thread id, and therefore one
  conversation memory, however the reader wanders.
- A catch-all `onSlashCommand` handler provisions the tabs and answers in Chat:
  `/start` gets a welcome built from `CATEGORIES`, `TOPICS` and
  `pipeline.digestHours`; anything else gets one line saying it isn't a command.
- **Provisioning stays lazy, and stays on the first event of any kind** —
  digest, message, or `/start`. Not at boot: Telegram rejects `createForumTopic`
  against a chat the reader has never started, so boot is the one moment it is
  guaranteed to fail.

## Consequences

**Good:** the two streams are now enforced, not just intended — News holds
digests and nothing else, and one Chat-tab memory follows the reader instead of
forking per tab. `/start` works, which is the first thing anyone types at a bot.
Every command is answered rather than swallowed, so the failure that hid this
one can't recur. Tabs get created by the first inbound message, not only by the
first digest.

**Costs:**

- **A message typed in News gets no visible reply there.** The answer appears in
  Chat with an unread badge. This is deliberate — a redirect notice in News is
  the exact noise the split exists to prevent — but it will read as "nothing
  happened" the first time.
- **`/start` is now Ava's, not the agent's.** Any future need to hand commands
  to the model has to go through this handler, since the adapter will never
  deliver them as messages.
- **Slash registration depends on init order.** `channels.sdk` is null until
  `AgentChannels.initialize()` resolves, and Mastra starts that itself while
  registering the agent, so `src/mastra/index.ts` awaits the same promise. A
  `/start` arriving in the sliver between polling starting and the handler
  landing is still dropped.
- **One indirection in the agent config.** The router needs
  `ava.getChannels()`, and reading that from inside `ava`'s own initializer
  makes the agent's type circular — TypeScript infers `any` for the whole
  agent. A module-level `avaChannels` assigned right after construction is the
  fix, and it is load-bearing rather than stylistic.
- **The chat id gained a non-throwing accessor.** `telegramChatId()` sits
  alongside `telegramEnv()` because the router runs on every message and must
  degrade rather than throw when `TELEGRAM_CHAT_ID` is unset.

**Revisit if:** the adapter starts delivering commands as ordinary messages
(drop the slash handler and let Ava read `/start` herself), or a third tab needs
its own agent — the router assumes exactly one conversational tab and would have
to become a per-tab table instead of a single target.
