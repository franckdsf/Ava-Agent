# AGENTS.md

Operating contract for anyone — human or agent — working in this repo.

- **What it is and how to run it:** [README.md](README.md)
- **Why it looks like this:** [docs/decisions/](docs/decisions/README.md)
- **This file:** the rules that aren't obvious from the code, and where work stopped.

---

## Working agreement

- **pnpm only.** Never npm. This was corrected explicitly.
- **Verify by running, not by asserting.** Both real bugs in this codebase were
  found by executing against live feeds, not by reading code. Before reporting
  something works: `pnpm typecheck`, and run the thing.
- **Don't add a dependency without checking what's installed.** `@mastra/libsql`
  already pulls `@libsql/client`; `mastra` already pulls `esbuild`. grammy was
  installed and removed once the Chat SDK adapter turned out to cover both
  directions.
- **Tunables belong in `src/config/`, secrets in `.env`.** No magic numbers in
  logic. `src/config/pipeline.ts` is the knob drawer.
- **If a decision's justification erodes mid-task, say so and re-open it** rather
  than carrying it forward. Convex was adopted and then dropped this way, and
  that was the right outcome.

## Commands with rules attached

The full list is in the [README](README.md#commands). These three carry obligations:

| Command | Rule |
| --- | --- |
| `pnpm typecheck` | Run before claiming any change works. |
| `pnpm db:generate` | **Required** after editing `src/db/schema.ts`, or the migration silently lags the code. |
| `pnpm feeds:check` | Run after touching feeds in `src/config/categories.ts`. |
| `pnpm telegram:check` | Run before debugging a missing tab. Reports whether BotFather's Threaded Mode is on — the one prerequisite no code can set. |

## Invariants

Breaking one of these is a regression, not a refactor. Read the linked ADR before
changing any of them.

1. **No inbound ports.** Telegram is long-polled; models are called outbound.
   Nothing may require a public URL, tunnel, or webhook.
   ([0001](docs/decisions/0001-mastra-in-a-container-with-no-inbound-ports.md), [0002](docs/decisions/0002-telegram-via-chat-sdk-adapter-in-polling-mode.md))
2. **Only ranking and composing call a model.** Ingest, dedupe, cluster and
   delivery are deterministic. A scheduled job that lets an LLM choose its own
   control flow produces surprise bills and duplicate messages.
3. **Categories are config, not code.** Adding a beat means adding an entry to
   `CATEGORIES`. Needing to touch agent or workflow code means the abstraction is
   wrong. ([0008](docs/decisions/0008-categories-as-configuration.md))
4. **Drizzle owns app tables; Mastra owns `mastra_*`.** One database, one shared
   connection, neither aware of the other.
   ([0005](docs/decisions/0005-two-libsql-databases-instead-of-convex.md), [0006](docs/decisions/0006-drizzle-orm-for-application-tables.md))
5. **Dedupe is global, not per-category.** Keyed on a hash of the canonical link.
6. **Single replica.** Two would double-send digests and double-poll Telegram.
7. **Exactly one adapter polls.** Ava's adapter (`mode: 'polling'`) owns the only
   inbound path; `src/services/telegram.ts` is outbound-only and never
   initializes a `ChatInstance`. Two pollers consume each other's updates.
   Never use `mode: 'auto'` — it falls back to *webhook* when it can't verify
   `getWebhookInfo`, which silently breaks invariant 1.
   ([0009](docs/decisions/0009-telegram-topics-as-tabs.md))
8. **The conversational surface is read-only over the pipeline.** Ava's tools
   query the news tables; none of them write, trigger a run, or mark anything
   delivered. This is what keeps invariant 2 true now that an LLM sits on an
   inbound path. ([0009](docs/decisions/0009-telegram-topics-as-tabs.md))
9. **One tab, one kind of traffic.** Ava answers in Chat and nowhere else —
   messages typed in News are *moved* there, not answered in place. Digests go
   to News. Breaking this means the tabs stop meaning anything.
   ([0010](docs/decisions/0010-ava-answers-only-in-the-chat-tab.md))

## Writing Mastra code

Mastra's API moves fast and model training data is stale on it. **Verify against
the embedded docs before writing Mastra code** — they match the installed version
exactly, unlike anything remembered or fetched from the web:

```
node_modules/@mastra/core/dist/docs/references/
node_modules/@mastra/libsql/dist/docs/references/
```

Model IDs route through the OpenRouter gateway as `openrouter/<provider>/<model>`.
Verify names before use:

```bash
node .agents/skills/mastra/scripts/provider-registry.mjs --provider openrouter
```

## Writing Telegram code

Same problem, same rule: the Bot API ships roughly monthly and training data is
stale on it. **Read [docs/telegram-bot-api.md](docs/telegram-bot-api.md) before
writing anything that talks to Telegram** — where the authoritative sources are,
what `@chat-adapter/telegram` already covers, and how to call a Bot API method it
doesn't wrap without adding a second Telegram library.

## Gotchas

- **No relative path may be resolved against cwd.** `mastra dev` runs the bundle
  from `.mastra/.build`, `mastra build` from `.mastra/output` — neither is the
  project root. This has bitten twice: stray databases under
  `src/mastra/public/`, then `AVA_MIGRATIONS_DIR=drizzle` failing with "Can't
  find meta/_journal.json". Anchor every path with `resolveFromRoot()` in
  `src/lib/project-root.ts` (database URLs go through `resolveDbUrl()`, which
  wraps it). Absolute paths pass through untouched, which is what Docker sets.
- **Feeds serve their entire history.** Figma returns 437 entries, OpenAI 1051.
  `pipeline.maxItemAgeDays` exists for this reason; removing it means paying to
  rank years-old news.
- **A single newline is a soft wrap, not a line break.** Telegram messages are
  parsed as markdown, so `heading\nbullet` renders as one run-on line — this
  shipped once and looked like an adapter bug. Separate blocks with a blank
  line. Verify format changes against the converter offline rather than by
  eyeballing the phone: `adapter.formatConverter.toAst(text)` returns the block
  structure without sending anything.
- **`content:encoded` needs declaring.** rss-parser silently drops unknown
  fields, so the full article body is invisible unless it is listed in
  `customFields.item`. Without it the summarizer sees a 400-char excerpt and
  writes a summary that just restates the headline.
- **Conditional GET hides schema changes.** Items ingested before a new column
  existed keep it null until their feed actually changes, because a 304 skips
  re-ingest entirely — and `insertDiscovered` ignores conflicts, so even a
  re-fetch won't backfill an existing row. `content` and `imageUrl` were null
  for every pre-existing item long after their migrations ran. New items fill
  in normally; a backfill is a deliberate one-off, not something ingest does.
- **A leading `/` never reaches the agent.** The adapter routes any message
  whose first entity is a `bot_command` to `processSlashCommand` and skips the
  message path entirely — and with no handler registered, the Chat SDK drops it
  without a trace. `/start` did nothing for a while. `src/mastra/channels.ts`
  registers a *catch-all* so no command can be swallowed again.
- **Escape only what opens inline markup.** MarkdownV2's escape set is wider
  than what Telegram's rich markdown needs. Escaping `.` and `-` inline shipped
  `kotlinx\.atomicfu`, `50\.7` and `platform\-ui` into real messages. Those
  characters are only meaningful at the start of a block.
- **og:image is as often the site banner as the post's art.** WebKit serves
  `/wp-content/themes/webkit/images/preview-card.jpg` on every post. Two guards
  in `resolveImage()`: reject paths that look like site chrome, and reject any
  URL already on a sibling item from the same feed. The repeat check alone can't
  catch the first occurrence, which is exactly the one that shipped.
- **Only 3 of 16 feeds publish images.** DeepMind (`media:content`), Smashing
  (`enclosure`) and Android Developers (`media:thumbnail`); WebKit has them
  inline in about half of posts. arXiv, Hacker News, Willison, OpenAI, Figma,
  CSS-Tricks and NNG have none. An image is the exception — never lay out a
  message assuming one is there.
- **Clustering is empirically tuned.** Before changing
  `clusterSimilarityThreshold` or the token filter, re-run ingest and inspect the
  actual merges. ([0007](docs/decisions/0007-lexical-clustering-instead-of-embeddings.md))
- **Model IDs need the `openrouter/` prefix.** Mastra's registry lists `deepseek`
  and `minimax` as *direct* providers too, so a bare `deepseek/deepseek-v4-flash`
  is valid — it just bills DeepSeek and demands a `DEEPSEEK_API_KEY`. `env.ts`
  rejects unprefixed IDs at startup; don't weaken that guard to "make it work".
- **`.history/` must stay gitignored.** An IDE extension snapshots `.env`
  verbatim into it.

## Where work stopped

*Last updated: 2026-07-28.*

**Working and verified:** ingest with conditional GET, global dedupe, clustering,
ranking, per-article summarization, six registered schedules (2 categories ×
08:00 / 13:00 / 19:00 Europe/Paris), and Telegram delivery. Verified by a real
scheduled fire on 2026-07-27: both 19:00 schedules fired, 272 items ingested,
257 with article bodies, 8 articles delivered, no errors.

**Delivery is one message per article, not a grouped digest.** Telegram parses
`rich_message.markdown` server-side into real blocks, so each message is a
heading (the linked title), a lede paragraph, an optional bullet list of
specifics, and an italic `source · subtopic` footer, with the feed image on top
when there is one.

The model returns **structured output only** — `{ lede, points[] }` — and the
layout is templated in `renderMessage()`. A summarizer asked to emit its own
markdown eventually emits a broken link, and the URL is the one part that must
be exactly right. Each article is marked delivered as it lands, so a failure
partway through a batch doesn't re-send what already arrived.

Verified against markdown by sending: `#`/`##` headings, `>` blockquote, `-`
list, `---` divider, fenced code (syntax-highlighted), `![](url)` photo, and
pipe tables all become native blocks. `adapter.formatConverter.toAst(text)`
inspects structure offline, but only a real send shows what *Telegram's* parser
does — the local converter is not authoritative.

**Tabs and the conversational surface — built, not yet verified end to end.**
Two Telegram topics (`src/config/topics.ts`): **Chat** and **News**. Digests
target News; `Ava` (`src/mastra/agents/ava.ts`) answers in Chat and owns the only
inbound path — a polling adapter on `channels.adapters`. She has four read-only
tools over the news tables. See
[ADR-0009](docs/decisions/0009-telegram-topics-as-tabs.md).

**Provisioning verified 2026-07-28.** Threaded Mode is on for `@ava_404_bot`, and
`resolveTopics()` created both tabs against the live chat — Chat `#103658`, News
`#103659`. Calling it a second time returned the same two ids and created no
duplicates, which is the property `telegram_topics` exists to guarantee
(`createForumTopic` is not idempotent on Telegram's side).

**Two chat types reach tabs, and they use different flags.** A private chat needs
BotFather's Threaded Mode (`getMe.has_topics_enabled`); a supergroup needs Topics
in its own settings (`getChat.is_forum`). `topicRoute()` checks whichever applies
— an earlier version tested only the private flag and would have silently
disabled tabs in a group. `pnpm telegram:check` reports the route and the fix for
whichever chat type it finds.

**Still unverified:** that a digest actually lands in the News tab, and that Ava
answers in Chat. Both need a real send, which has not been done. Typecheck
passes, the instance boots with all five agents and Ava's four tools resolving,
and provisioning ran for real; nothing beyond that was exercised.

**Still not wired:** the 👍/👎 loop. The inbound path now exists, so
`recentFeedback()` could finally be fed, but nothing handles a reaction yet and
it still always returns empty.

**Ava is scoped to the Chat tab — 2026-07-28.** `src/mastra/channels.ts` swaps
the inbound thread for the Chat tab's before the default handler runs, on all
three inbound events, so a message typed in News is *answered in Chat* rather
than in place. One thread id means one conversation memory.

The same file fixes the reason `/start` appeared to do nothing: the adapter
diverts every `/command` away from the message path, and an unregistered command
is dropped silently. A catch-all handler now provisions the tabs and answers in
Chat — a config-built welcome for `/start`, one line for anything else.

Verified offline: the welcome renders as seven blocks through
`formatConverter.toAst()` with no run-on lines; the graph boots with Telegram
unconfigured (no adapter, no polling); and against the live chat the router's
decision table is flat → moved, Chat → in place, News → moved, other chat →
untouched, with the tabs resolving to two distinct `telegram:<chat>:<thread>` ids.
**Not verified: an actual inbound message.** That needs the bot running and a
phone.

**Resolved — the ADR-0002 open question.** `postMessage` does *not* require an
initialized `ChatInstance`. Only the inbound paths (`handleWebhook`,
`startPolling`, and the `process*` handlers) guard on one; `postMessage` builds
its payload and calls the Bot API directly. Verified in the compiled adapter and
by sending. So the documented fallback to a second Telegram library is not
needed and ADR-0002 stands as written — `src/services/telegram.ts` is outbound
only, and the orchestrator will register its own adapter for inbound. Only that
one polls.

Two things learned while wiring it, both by sending rather than reading:

- The adapter has **no HTML parse mode** — only `MarkdownV2` or `plain` — which
  looks like it should break the digest writer's Telegram HTML. It doesn't. The
  format converter parses inline HTML as well as markdown and the adapter sends
  structured rich text via `sendRichMessage`, so `parse_mode` never applies.
  Pass `{ markdown: text }`; a bare string or `{ raw }` sends unformatted.
- The adapter **truncates** at Telegram's 4096-character cap rather than
  splitting, so a long digest loses its tail silently. `splitForTelegram()`
  chunks at `pipeline.telegramMaxMessageChars` before handing anything over.

## Recording decisions

Non-obvious choices go in [`docs/decisions/`](docs/decisions/README.md) as a new
numbered ADR, including the cost — an ADR with no downside listed is marketing.
**Never rewrite an accepted ADR**; supersede it, so the reversal and its reasoning
survive.
