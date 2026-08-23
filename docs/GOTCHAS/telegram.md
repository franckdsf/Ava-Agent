---
applies_to: ["src/services/**", "src/mastra/commands/**", "src/config/**"]
---

# Telegram

Gotchas. The routing table is [README.md](README.md).

- **A single newline is a soft wrap, not a line break.** Telegram messages are
  parsed as markdown, so `heading\nbullet` renders as one run-on line — this
  shipped once and looked like an adapter bug. Separate blocks with a blank
  line. Verify format changes against the converter offline rather than by
  eyeballing the phone: `adapter.formatConverter.toAst(text)` returns the block
  structure without sending anything.

- **A leading `/` never reaches the agent.** The adapter routes any message
  whose first entity is a `bot_command` to `processSlashCommand` and skips the
  message path entirely — and with no handler registered, the Chat SDK drops it
  without a trace. `/start` did nothing for a while. `src/mastra/channels.ts`
  registers a *catch-all* so no command can be swallowed again.

- **On an inbound message, `formatted` beats `text`.** Mastra builds the model's
  input as `stringifyMarkdown(message.formatted) || message.text`, and the
  adapter always sets `formatted` — so anything injected into `text` alone is
  silently dropped. That is the whole trick to `withQuotedMessage`
  ([0013](../decisions/0013-swipe-to-reply-as-article-context.md)): the note
  goes into the AST, and `text` is kept in step only so the two don't disagree.
  Copy the message rather than editing it — `handleIncomingMessageUpdate` calls
  `cacheMessage` on the object *before* handing it to the handler.

- **Escape only what opens inline markup.** MarkdownV2's escape set is wider
  than what Telegram's rich markdown needs. Escaping `.` and `-` inline shipped
  `kotlinx\.atomicfu`, `50\.7` and `platform\-ui` into real messages. Those
  characters are only meaningful at the start of a block.

- **Tab order is Telegram's, not ours.** The client sorts tabs by most recent
  message, so the order of `TOPICS` only decides creation order and no Bot API
  method reorders them. Chat was created first and still sat under News until a
  reply landed in it (verified 2026-07-28). A request to "put that tab first" has
  no code answer — the only thing that moves a tab up is traffic in it.

- **The reply is invisible until it's finished, unless streaming is on.**
  `streaming` defaults to false for every adapter except Slack, and the
  orchestrator takes ~25s over three round trips on a question that hits a tool.
  The typing indicator does not cover the gap: the adapter sends
  `sendChatAction` once, Telegram expires it after ~5s, and Mastra only re-sends
  when the status *string* changes — which it doesn't while the model thinks.
  `streaming: true` on the adapter entry streams through Telegram's draft API
  and posts one real message at the end. It is a no-op in a supergroup:
  `stream()` returns null unless `isDM`, i.e. a positive chat id.

- **A slash command still carries the swipe.** `handleSlashCommandUpdate` passes
  the untouched Telegram payload through as `event.raw` (verified in
  `@chat-adapter/telegram` 4.35), so a reply the reader typed `/translate` into
  reaches the handler with `reply_to_message` intact. That is the whole reason
  the translation commands work on a swipe without a second inbound path —
  `quotedSource()` is the same parser and the same link-to-item lookup the
  message path uses. Don't add a message-path special case for a command.

- **A bot's own profile is three fields and three *different* nouns.**
  `setMyName` is the chat title, `setMyShortDescription` is the profile page and
  share previews, `setMyDescription` is the empty-chat screen above Start. The
  wire names are not the config names (`short_description`), and each has its own
  getter — so unlike `setMyCommands`, `publishProfile()` reads all three back and
  pushes only what drifted. That is not a micro-optimisation: `setMyName` is
  flood-limited, and a container in a restart loop pushing it every boot would
  lock the bot out of renaming itself for the day. All six methods verified
  against the live bot 2026-07-30, including the writes — probe them with
  `language_code: 'eo'`, which exercises the real method against a locale nothing
  will ever request and leaves the default profile untouched.

- **A private chat's `chat_id` is the user's id, so two bots see the same one.**
  Telegram user ids are global, not per-bot, and for a private chat `chat.id`
  *is* that user id — so both bots push to the **same value** (`8401775038`
  here), which is also the reader's entry in both allowlists. The conversations
  are still distinct in the client because the token differs; nothing else
  distinguishes them. This was asserted the wrong way round in the first draft of
  ADR-0023 and in `.env.example`, both of which said the two chat ids must differ.
  **Since [ADR-0041](../decisions/0041-one-deployment-one-reader.md) it is one
  variable**, `AVA_TELEGRAM_USER_ID` — four fields holding one number was four
  chances to typo it, three of them silent.
  Two consequences, and the second one bites:
  - `telegram_topics` is keyed `(botId, chatId, slug)`. Keyed on chat and slug
    alone — which is correct for supergroups, where two groups are two ids —
    both bots write `('8401775038', 'chat', …)`. The second bot then adopts the
    first's thread id, fails to send into a thread that isn't in its
    conversation, and `invalidateTopic` deletes the *other* bot's row; that bot
    recreates it, `createForumTopic` is not idempotent, and a duplicate tab
    appears. Never query that table without a bot id.
  - **The allowlist and the chat id are one variable now, and the argument that
    kept them apart is the one worth reading.** It said: the allowlist says who
    may *talk*, the chat id says where a cron fire — which has no message to
    reply to — should *send*, and they diverge the moment there are two allowed
    users. Correct as a distinction between two **concepts**, and wrong as a
    reason for two **fields**: they had never diverged, the second allowed user
    was a shape this system does not support anywhere else (one CV, one
    `memories` table, one `/client` profile), and the price of holding the option
    open was asking four times for one number in the variable that gates access.
    ADR-0041 collapsed them and kept the one case that genuinely cannot be
    derived — the supergroup route, where the chat id is a `-100…` group that is
    nobody's user id — as the optional `<PREFIX>TELEGRAM_CHAT_ID` override.
    **The general lesson: a distinction that is real in the domain still has to
    earn its second field in the config.**
