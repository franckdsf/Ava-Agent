---
id: 0002
applies_to: ["src/mastra/channels.ts", "src/mastra/registrar.ts", "src/services/telegram.ts"]
status: accepted
supersedes: []
verify: "pnpm telegram:check"
---

# ADR-0002: Telegram via Chat SDK adapter in polling mode

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

Three options for the Telegram surface:

1. **grammy** — hand-rolled. Full control, guaranteed long polling, but the
   mapping from chat to Mastra thread/resource, memory wiring, inline keyboards,
   and streaming all become ours to write and maintain.
2. **`@chat-adapter/telegram`** via Mastra's `channels.adapters` — the framework
   wires the agent, threads, memory, inline keyboards, tool-approval cards, and
   streaming. Documented primarily around webhooks, which appeared to conflict
   with [ADR-0001](0001-mastra-in-a-container-with-no-inbound-ports.md).
3. Both — adapter inbound, something else outbound.

The adapter's documentation mentioned polling only in passing, as a
local-development convenience. That ambiguity was the deciding fact, so it was
checked rather than assumed.

## Decision

Use `@chat-adapter/telegram` with `mode: "polling"`.

The Chat SDK documents polling as supported in **production**, not just locally:
`mode: "auto"` inspects `getWebhookInfo` and falls back to polling on
long-running runtimes, and `mode: "polling"` forces it, deleting any registered
webhook first. The adapter also exposes `postMessage`, `editMessage`,
`addReaction`, `startTyping`, and `stream`, so proactive digest pushes need no
second library.

`TELEGRAM_ALLOWED_USER_IDS` is a built-in allowlist. It is not optional — an open
orchestrator agent is someone else's free compute.

## Consequences

**Good:** framework-managed agent wiring and inline keyboards (which the 👍/👎
feedback loop depends on) *and* the zero-inbound-ports property. grammy was
installed and then removed rather than carrying two Telegram libraries.

**Costs:**
- Polling and webhooks are mutually exclusive in Telegram; `mode: "polling"`
  deletes any webhook on start. Nothing else may register one for this bot.
- Long polling holds an open connection and has marginally higher latency than a
  webhook. Irrelevant at personal scale.

**Revisit if:** `postMessage` turns out to require a full `ChatInstance`
lifecycle that doesn't fit cron-driven push — there is no incoming message to
reply to. The fallback is a direct Bot API call for outbound only, which must be
a deliberate, documented split rather than accidental duplication.
