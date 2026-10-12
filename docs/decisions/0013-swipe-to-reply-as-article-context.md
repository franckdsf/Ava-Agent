---
id: 0013
applies_to: ["src/services/telegram-reply.ts", "src/services/quoted-article.ts", "src/mastra/commands/article-context.ts", "src/mastra/quoted-message.ts"]
status: accepted
supersedes: []
---

# ADR-0013: Swipe-to-reply resolves the article, with no table

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Asking Ava about a delivered article meant describing it. The digest was right
there on the phone — a message from that morning — but the only way to point at
it was to retype enough of it for `search-news` to find it again, and a reader
who half-remembers a headline writes a bad query. This is the failure that
already produced one bad session (*"the 500$ rl fine tune"*,
[ADR-0011](0011-fts5-for-article-search.md)); better search made the query work,
it did not remove the need to write one.

Telegram's own gesture for this is the reply: swipe a message, type a question.
The payload arrives — `reply_to_message` is on the update, and
`@chat-adapter/telegram` passes the untouched Telegram message through as
`Message.raw` (verified in `dist/index.js`, `parseTelegramMessage`). It just
never reaches the model: Mastra builds the turn from the reply's *own* text, so
"what is this about?" arrives with nothing attached.

The first design for resolving *which* article kept a `message_id → item id`
table, written at delivery. It was unnecessary. The item id **is** a hash of the
canonical link ([invariant 5](../../AGENTS.md#invariants), `itemId()` in
`src/services/rss.ts`), and every digest carries that link in its heading —
`renderMessage()` emits `## emoji [title](item.link)` with an already-canonical
URL. A link recovered from the quoted message is therefore a primary key, with
no bookkeeping at all.

## Decision

Read the quoted message off `Message.raw` on the inbound path and prepend it to
what the reader typed.

`src/services/telegram-reply.ts` flattens whichever shape the quoted message
arrives in — plain `text` with entities, or `rich_message` blocks, which is what
a digest comes back as — into text plus the URLs it carried. It is pure parsing;
`src/services/telegram.ts` stays outbound-only.

`withQuotedMessage` in `src/mastra/channels.ts` wraps the existing tab router. It
writes a hedged note ("may or may not be what they are asking about") followed by
the quoted text as a blockquote, and when one of the quoted links resolves to a
stored item, a line naming that item's id so Ava calls `read-article` instead of
searching. Read-only throughout — one primary-key lookup per link, nothing
written, so [invariant 8](../../AGENTS.md#invariants) holds.

Resolution itself is `itemForLink` in `src/services/rss.ts`, next to the `itemId`
it inverts, rather than in the channel module: how a URL becomes a row is the
same fact as how a row gets its id, and both belong in one place. `src/db/` was
not an option — nothing under it imports from `services/`, and the derivation
lives there.

Two details are load-bearing. The note goes into `message.formatted`, not
`message.text`: Mastra builds the model's input as
`stringifyMarkdown(formatted) || text`, so a note written only to `text` is
silently dropped. And the message is *copied* rather than edited, because the
adapter caches the object it parsed before handing it over.

## Consequences

**Good:** the gesture works on **every digest ever delivered**, not just those
sent after this shipped — nothing had to be recorded in advance. No schema
change, no migration, no rows to reconcile, and nothing to prune. When the link
resolves, Ava reads the exact article rather than guessing at a query; when it
doesn't, the quoted text is still in front of her, which is strictly more than
she had before.

**Costs:** every reply now spends tokens quoting a message the reader may not
have been asking about — capped at `pipeline.quotedMessageMaxChars` (1200), which
fits one digest and truncates anything longer mid-sentence. A reply to an article
older than `retentionDays` resolves to nothing, because the row is gone; the
quoted text carries the turn instead. The hedge is a prompt, not a mechanism, so
the model may still anchor on a quote that was incidental. The rich-message walk
matches on key names rather than the twenty-odd block `type` variants — it cannot
go stale as the Bot API grows, but it will read text out of a future block shape
nobody intended, or miss one that names its content something new. And it reaches
past the adapter's types: neither `reply_to_message` nor `quote` is declared on
`TelegramMessage` in 4.35, so both are casts against the documented Bot API
rather than against the package.

**Revisit if:** Telegram changes how a reply in a private-chat topic is
delivered — the topic-root discrimination (`reply_to_message.message_id ===
message_thread_id`) is the fragile part, and getting it wrong makes every message
in a tab look like a reply to its header. Or if the quoted block measurably
degrades answers where the reply was incidental, in which case the note should
shrink to the resolved article and drop the text.
