# ADR-0009: Telegram topics as tabs, splitting chat from news

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

Everything the bot sent went into one flat private chat. Scheduled digests and
any future conversation would interleave in the same stream, which makes both
worse: a digest buries a reply, and a reply buries a digest.

Bot API 9.3 (2025-12-31) extended forum topics into private chats with a bot, and
9.4 (2026-02-09) let bots create them via `createForumTopic`. Telegram renders
the topic list as a sidebar of tabs, so one DM can hold several independent
conversations. This is what makes a bot DM look like Perplexity's.

Three things were true when this was decided, all verified rather than assumed:

- **The adapter already routes to topics.** `@chat-adapter/telegram` 4.35 folds
  `messageThreadId` into its thread id and writes `message_thread_id` on every
  outbound path, reading it back on inbound. Confirmed in the compiled package.
  No adapter change and no second Telegram library were needed for routing.
- **The adapter wraps no topic lifecycle method,** and exposes no raw-API escape
  hatch — `botToken` and `apiBaseUrl` are `protected`. Creating a topic means
  calling the Bot API directly.
- **Threaded Mode is a manual BotFather toggle** with no API to set it. Probing
  the live bot on 2026-07-27 returned `has_topics_enabled: false`.

The conversational agent did not exist. ADR-0002 left the inbound half unbuilt,
so "a Chat tab" and "an agent to talk to" were the same piece of work.

## Decision

Two topics, defined in `src/config/topics.ts` as data: **Chat** and **News**.

- Scheduled digests target the News tab. `sendArticle` defaults to it.
- A new agent, `Ava` (`src/mastra/agents/ava.ts`), owns the Chat tab and the only
  inbound path in the process — a Telegram adapter on `channels.adapters` with
  `mode: 'polling'`. `src/services/telegram.ts` stays outbound-only.
- Ava gets four **read-only** tools over the news tables (recent, search, stats,
  feedback). Nothing in the conversational surface writes, triggers a run, or
  marks anything delivered.
- Topic ids are persisted in `telegram_topics`, keyed by `(chat_id, slug)`,
  because Telegram assigns them and `createForumTopic` is not idempotent —
  calling it twice makes two identically-named tabs.
- **Topics are optional at runtime.** `resolveTopics()` feature-detects via
  `getMe.has_topics_enabled` and returns an empty map when Threaded Mode is off;
  delivery then goes to the flat chat exactly as before.

`mode: 'polling'` is explicit rather than `'auto'`. Verified in the compiled
adapter: `'auto'` probes `getWebhookInfo` and falls back to *webhook* mode when
it cannot verify, which would silently require a public URL and break ADR-0001.

## Consequences

**Good:** the two streams stop competing for one timeline. Each tab is a separate
thread id, so conversation memory is partitioned by tab for free — the Chat tab
never sees what was pushed into News. Adding a third tab is a config entry. The
inbound path that ADR-0002 deferred now exists, which is also the prerequisite
for the 👍/👎 loop.

**Costs:**

- **A manual prerequisite outside the repo.** Threaded Mode must be enabled in
  BotFather or there are no tabs. `pnpm telegram:check` reports it, and the
  fallback keeps digests flowing, but no code change can fix it.
- **A new dependency, `@mastra/memory`.** `@mastra/core` ships only the abstract
  `MastraMemory`; the concrete `Memory` class is a separate first-party package.
  A chat agent without memory is not a chat.
- **State Telegram can invalidate.** Deleting a tab on the phone orphans its row.
  Handled — the first failed send drops the row and re-sends flat, recreating on
  the next run — but it is real state that can drift, which the flat chat never
  had.
- **Ava answers in whichever tab you message her in.** Nothing scopes her to the
  Chat tab; typing in News gets a reply in News. Enforcing the split needs an
  input processor on the agent, which was not built.
- **A second model on the hot path.** `AVA_MODEL_ORCHESTRATOR` now bills per
  conversation, not just per digest.
- **`createForumTopic` is unverified end to end.** Threaded Mode was still off
  when this shipped, so the provisioning path has never run against Telegram.

**Revisit if:** the adapter starts wrapping topic lifecycle methods (drop the
direct Bot API call), or one tab per *category* becomes wanted (this ADR assumes
one News tab for all beats, and per-category tabs change the delivery step's
grouping, not just its target).
