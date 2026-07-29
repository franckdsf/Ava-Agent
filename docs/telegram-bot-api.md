# Working with the Telegram Bot API

*Last verified against the live changelog: 2026-07-27. Latest release then: **Bot
API 10.2**, 2026-07-14.*

Read this before writing anything that talks to Telegram. It is the Telegram
counterpart to [AGENTS.md](../AGENTS.md#writing-mastra-code)'s rule about Mastra:
the API moves faster than model training data, so **what you remember about it is
probably a year stale and quietly wrong**.

Scale of the drift: Bot API shipped 10.2 → 10.1 → 10.0 → 9.6 → 9.5 → 9.4 → 9.3 in
roughly eight months. Anything you "know" that isn't in the changelog you just
read is a guess.

---

## Where to look

In this order. The first two are authoritative; the rest are context.

| Source | Use it for |
| --- | --- |
| [core.telegram.org/bots/api](https://core.telegram.org/bots/api) | The reference. Every method, every field, exact types. Always describes the *current* version — there is no versioned archive. |
| [core.telegram.org/bots/api-changelog](https://core.telegram.org/bots/api-changelog) | **What actually changed and when.** Newest first, each entry dated. This is the file that tells you whether a thing exists yet. |
| [core.telegram.org/bots/features](https://core.telegram.org/bots/features) | Prose explanation of concepts — topics, keyboards, business mode, payments. Good for "what is this for". |
| [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps) | Mini Apps only. Irrelevant here — see *Constraints* below. |
| [@BotNews](https://t.me/BotNews) | Telegram's announcement channel. Fastest signal that something shipped. |
| [telegram.org/blog](https://telegram.org/blog) | Client-side feature launches. The Bot API entry often lands here first with screenshots. |

**How to search the web for it.** Don't search for the feature by the name a
blog gave it — search the changelog for the *method or field name*. Queries that
work:

- `site:core.telegram.org/bots/api-changelog <methodName>`
- `Telegram Bot API <version> changelog`
- `core.telegram.org/bots/api#<lowercased-method-name>` fetches the exact anchor

**Fetching it is lossy.** Summarizing fetches of the changelog mis-bucketed
features between 9.3, 9.4 and 9.5 three times while this file was written, in
both directions. When the version boundary matters, ask for the *complete
unfiltered bullet list under one heading* and read it yourself. Don't accept a
summary as the answer to "which release added X".

---

## What's already in the box

Everything Telegram goes through **`@chat-adapter/telegram`** (4.35.0 — Vercel's
Chat SDK, [docs](https://chat-sdk.dev/adapters/official/telegram),
[source](https://github.com/vercel/chat/tree/main/packages/adapter-telegram)).
See [ADR-0002](decisions/0002-telegram-via-chat-sdk-adapter-in-polling-mode.md).

The adapter is a *wrapper*, not the Bot API. It lags. Before assuming a feature
is unreachable, check what it already does — and check by reading the compiled
package, not the README:

```bash
node_modules/@chat-adapter/telegram/dist/index.d.ts   # the surface
node_modules/@chat-adapter/telegram/dist/index.js     # what actually goes on the wire
```

That is how ADR-0002's open question was settled and how the findings below were
verified. It is faster and more reliable than sending test messages.

### Threads are `telegram:<chatId>[:<messageThreadId>]`

`encodeThreadId()` and `decodeThreadId()` are **public**:

```ts
adapter.encodeThreadId({ chatId: '123', messageThreadId: 7 })  // 'telegram:123:7'
adapter.encodeThreadId({ chatId: '123' })                      // 'telegram:123'
```

**Topic routing therefore already works, in both directions, with no adapter
change.** Verified in `dist/index.js`: `messageThreadId` is written to
`message_thread_id` on every outbound path — plain messages, media, documents,
media groups — and read back off inbound updates into the encoded thread id. The
adapter is topic-transparent because it folds the topic into thread *identity*.

The type comment says "for supergroup topics", but it's the same wire field that
Bot API 9.3 extended to private chats. The comment is stale, not the code.

### A leading `/` diverts the message away from the agent

`processUpdate` checks for a slash command *first*. `handleSlashCommandUpdate`
claims any message whose first entity is a `bot_command`, hands it to
`chat.processSlashCommand`, and returns `true` — which makes `processUpdate`
skip `handleIncomingMessageUpdate` entirely. The message never becomes a
message.

There is no fallback: with no `onSlashCommand` handler registered, the Chat SDK
iterates an empty handler list and the update is dropped without a trace. That
is how `/start` did nothing for a while ([ADR-0010](decisions/0010-ava-answers-only-in-the-chat-tab.md)).

Register a **catch-all** rather than one command at a time — `onSlashCommand(fn)`
with no filter runs for every command, so nothing can be swallowed again:

```ts
const sdk = agent.getChannels()?.sdk   // null until AgentChannels.initialize() resolves
sdk?.onSlashCommand(async event => { /* event.command, event.text, event.channel */ })
```

The event carries no `Message`, so there is nothing to hand to an agent run —
answer it directly.

### What the adapter does *not* wrap

No public escape hatch: `botToken` and `apiBaseUrl` are `protected`. Anything the
adapter doesn't expose — topic lifecycle (`createForumTopic`, `editForumTopic`,
`deleteForumTopic`), `sendMessageDraft`, and everything added after 4.35.0 — you
call yourself.

---

## Adding a feature the adapter doesn't cover

Call the Bot API directly. Don't add a second Telegram library — grammy was
installed and removed once already for exactly this
([AGENTS.md](../AGENTS.md#working-agreement)).

```ts
import { telegramEnv } from '../config/env.js'

async function callBotApi<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch(
    `https://api.telegram.org/bot${telegramEnv().TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    },
  )
  const body = (await response.json()) as { ok: boolean; result?: T; description?: string }
  // Telegram answers 200 with ok:false. Checking response.ok alone silently
  // returns undefined and the failure surfaces somewhere unrelated.
  if (!body.ok) throw new Error(`${method}: ${body.description ?? 'unknown error'}`)
  return body.result as T
}
```

Rules for anything built this way:

- **Token from `src/config/env.ts`.** Never re-read `process.env` at a call site.
- **Tunables to `src/config/pipeline.ts`.** Retry counts, limits, poll intervals.
- **Check `ok`, not the HTTP status.** Telegram returns 200 with `{ok: false}`.
- **Feature-detect, don't version-detect.** There is no "what version is this
  server" call worth relying on. Where Telegram gives you a capability field, read
  it — **`getMe` returns `has_topics_enabled` and `allows_users_to_create_topics`
  on the bot's own `User`**, which is the check for topic support. (Verified by
  probe, 2026-07-27. `getChat` on a private chat returns neither field — don't
  look for them there.) Otherwise call the method and handle `ok: false`.
  Hardcoding a version assumption breaks silently.

---

## Constraints that rule features out

Check these before designing anything. Two are repo invariants
([AGENTS.md](../AGENTS.md#invariants)).

- **No inbound ports — polling only.** Rules out webhooks entirely, and with them
  Mini Apps, Web App buttons, login widgets, and anything needing a public URL.
  Don't propose a Mini App. ([ADR-0001](decisions/0001-mastra-in-a-container-with-no-inbound-ports.md),
  [ADR-0002](decisions/0002-telegram-via-chat-sdk-adapter-in-polling-mode.md))
- **Single replica.** Two would double-poll `getUpdates` and double-send.
  Anything stateful across restarts belongs in the database, not in memory.
- **`src/services/telegram.ts` is outbound only.** It never touches
  `ChatInstance`. Inbound belongs to the orchestrator's own registered adapter,
  and only that one polls.
- **Messages cap at 4096 characters and the adapter *truncates*.** Everything
  outbound goes through `splitForTelegram()` first.
- **Rich markdown, not `parse_mode`.** Pass `{ markdown: text }` to
  `postMessage`. A bare string or `{ raw }` sends unformatted. A single newline
  is a soft wrap — separate blocks with a blank line.

---

## Worked example: topics in private chats

The feature that prompted this file, and the one most likely to be wanted next.
It's what makes a bot DM look like it has tabs — a sidebar of named
conversations, one per topic. Verified verbatim from the changelog on 2026-07-27:

**Bot API 9.3** (2025-12-31) — *Topics in private chats*
- `has_topics_enabled` on `User` — whether topic mode is on for the bot
- `message_thread_id` and `is_topic_message` on `Message` in private chats
- `message_thread_id` accepted by every `send*` method, `sendChatAction`,
  `editForumTopic`, `deleteForumTopic`, `unpinAllForumTopicMessages`
- `is_name_implicit` on `ForumTopic` / `ForumTopicCreated`
- `sendMessageDraft` — stream a partial message while it's still generating

**Bot API 9.4** (2026-02-09)
- Bots may **create** topics in private chats via `createForumTopic`
- BotFather setting to stop users creating/deleting topics
- `allows_users_to_create_topics` on `User`
- `icon_custom_emoji_id` and `style` on `KeyboardButton` / `InlineKeyboardButton`

**The BotFather step is manual and it isn't called "topics".** No API can set it:

```
@BotFather → /mybots → <your bot> → Bot Settings → Threads Settings → Threaded Mode
```

Turning that on flips `has_topics_enabled`. The adjacent "Disallow users to create
new threads" toggle controls `allows_users_to_create_topics`.

**The flag is a trustworthy predictor — verified 2026-07-27.** With
`has_topics_enabled: false`, `createForumTopic` against the private chat returns:

```
400  Bad Request: the chat is not a forum
```

So `getMe` and the API agree, and gating on the flag never skips a call that
would have worked. That also means a `false` flag is *not* a stale-cache
symptom — if you suspect caching, call `createForumTopic` and compare. Both
saying no means the BotFather toggle genuinely is not set.

Shape of an implementation here: enable Threaded Mode; call `createForumTopic`
directly (not wrapped); route with `encodeThreadId({ chatId, messageThreadId })`;
key conversation memory on the thread id rather than the chat id.

The obvious fit is one topic per beat, replacing today's single flat stream into
`TELEGRAM_CHAT_ID`. That is a real design change with a real cost — topic ids must
be persisted and reconciled, and delivery stops being idempotent in the same way.
**It needs an ADR** ([how](decisions/README.md)), not a quiet commit.

Since [ADR-0019](decisions/0019-beats-as-reader-owned-data.md) the beats are rows
rather than a config array, so the tab set is no longer knowable at boot and
`TopicSlug` cannot stay a compile-time union covering both kinds.
`telegram_topics` is keyed `(chatId, slug)` with no reference to `TOPICS`, so it
already holds whatever slugs it is given. Two things that will need answering and
have not been probed: how many topics a private chat may hold, and the rate limit
on creating them.

---

## Before claiming it works

1. `pnpm typecheck`.
2. Confirm the method exists **in the changelog**, with its release date. Not
   from memory, not from a blog post.
3. If the adapter is involved, confirm the field reaches the wire in
   `dist/index.js`.
4. Run it. Both real bugs in this codebase were found by executing against live
   input, not by reading code.
