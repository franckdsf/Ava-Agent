# AGENTS.md

Operating contract for anyone — human or agent — working in this repo.

- **What it is and how to run it:** [README.md](README.md)
- **Why it looks like this:** [docs/decisions/](docs/decisions/README.md)
- **This file:** the rules that aren't obvious from the code, and where work stopped.

---

## Working agreement

- **pnpm only.** Never npm. This was corrected explicitly.
- **Say what you're doing while you're doing it.** Minutes of silent work is the
  failure mode here — from the outside it is indistinguishable from being stuck.
  Before a long stretch, say what you're about to do; as each step lands, say
  what it showed. A short line per step beats a perfect summary at the end.
- **Verify by running, not by asserting.** Both real bugs in this codebase were
  found by executing against live feeds, not by reading code. Before reporting
  something works: `pnpm typecheck`, and run the thing.
- **Before testing against the live bot, report the change and the output you
  expect** — the message shape, which tab it lands in, what a reply should say —
  and wait for the go. This is not a permissions gate on `pnpm dev`; it puts the
  same expectation on the table before the test runs, instead of whatever
  arrived being judged acceptable after the fact.
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
2. **On a schedule, only ranking, composing and the weekly memory review call a
   model.** Ingest, dedupe, cluster and delivery are deterministic. The rule is
   not "no models on a schedule" — it is that a scheduled model call must be a
   *classifier over a fixed row set*: fixed control flow, a set handed to it, and
   the answer validated against that set on the way back. A scheduled job that
   lets an LLM choose its own control flow produces surprise bills and duplicate
   messages. Inbound, human-triggered calls are a separate category and are
   governed by invariant 8 instead — Ava, the translator behind `/translearn` /
   `/translate`, and the summarizer behind `/summarize`. The distinction is who
   decides to spend: a cron fire nobody watches, or a person typing.
   ([0015](docs/decisions/0015-weekly-memory-review.md), [0017](docs/decisions/0017-translation-commands.md), [0018](docs/decisions/0018-summarize-command.md))
3. **Categories are config, not code.** Adding a beat means adding an entry to
   `CATEGORIES`. Needing to touch agent or workflow code means the abstraction is
   wrong. ([0008](docs/decisions/0008-categories-as-configuration.md))
4. **Drizzle owns app tables; Mastra owns `mastra_*`.** One database, one shared
   connection, neither aware of the other. **One exception, and only one:**
   `items_fts` and its three triggers are hand-written in
   `drizzle/0005_items_fts.sql` because drizzle-kit cannot express a virtual
   table. Anything else belongs in `src/db/schema.ts`.
   ([0005](docs/decisions/0005-two-libsql-databases-instead-of-convex.md), [0006](docs/decisions/0006-drizzle-orm-for-application-tables.md), [0011](docs/decisions/0011-fts5-for-article-search.md))
5. **Dedupe is global, not per-category.** Keyed on a hash of the canonical link.
6. **Single replica.** Two would double-send digests and double-poll Telegram.
7. **Exactly one adapter polls.** Ava's adapter (`mode: 'polling'`) owns the only
   inbound path; `src/services/telegram.ts` is outbound-only and never
   initializes a `ChatInstance`. Two pollers consume each other's updates.
   Never use `mode: 'auto'` — it falls back to *webhook* when it can't verify
   `getWebhookInfo`, which silently breaks invariant 1.
   ([0009](docs/decisions/0009-telegram-topics-as-tabs.md))
8. **The conversational surface is read-only over the pipeline.** Ava's news
   tools query the news tables; none of them write, trigger a run, or mark
   anything delivered. This is what keeps invariant 2 true now that an LLM sits
   on an inbound path. `read-article` may fetch a page the feed shipped no body
   for — an outbound GET is not a write — but it must not store what it gets
   back. **One exception, and only one:** `remember` and `forget-memory` write to
   `memories`. The boundary is the table, not the direction — a conversational
   tool that wrote to `items` or `feedback` would break this.
   **`memories` is no longer a dead end**, and that is deliberate: the ranker
   reads it ([0016](docs/decisions/0016-reader-notes-in-the-ranker.md)), so a
   note Ava writes mid-conversation changes what the *next* run scores. That is
   the only path from a conversation into the pipeline, it is one-way and
   asynchronous, and it must stay the only one — nothing conversational may reach
   a run in progress, mark anything delivered, or write a score.
   ([0009](docs/decisions/0009-telegram-topics-as-tabs.md), [0014](docs/decisions/0014-two-tier-memory-for-ava.md), [0016](docs/decisions/0016-reader-notes-in-the-ranker.md))
9. **One tab, one kind of traffic.** Ava answers in Chat and nowhere else —
   messages typed in any other tab are *moved* there, not answered in place.
   Digests go to News. Translations go to Translations. Breaking this means the
   tabs stop meaning anything. **The criterion is length, not "is it a
   command"** — `/summarize` answers in Chat alongside `/start` and the
   unknown-command reply, because one short message is what Chat is for, while a
   translation is several thousand characters over several messages and would
   bury the conversation. A new tab per command is the misreading to avoid.
   ([0010](docs/decisions/0010-ava-answers-only-in-the-chat-tab.md), [0017](docs/decisions/0017-translation-commands.md), [0018](docs/decisions/0018-summarize-command.md))

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
- **drizzle-kit generates a `NOT NULL` add that only works on an empty table.**
  `ALTER TABLE … ADD COLUMN … NOT NULL` with no default is rejected by SQLite the
  moment the table has one row — "Cannot add a NOT NULL column with default value
  NULL". This is exactly what it emitted for `feedback.title`/`source`, and it
  passed only because that table has never had a row. `0006` is hand-edited into
  a table recreate for that reason (the end state matches drizzle's snapshot, so
  `db:generate` stays quiet — check that after any hand-edit). Always apply a
  generated migration to a *populated* copy before trusting it: every repository
  function awaits `migrate()`, so a migration that throws takes down the whole
  app, not just the table it touches.
- **`retentionDays` and `maxItemAgeDays` may not be tuned independently.**
  Deleting an item frees its id, and the id *is* the dedupe — so a pruned story
  its feed still serves would be re-ingested with a null `deliveredAt` and
  **re-sent**. The only thing preventing that is the ingest window rejecting it
  on age first, which needs retention (30d) to stay well above the window (7d).
  Moving either number toward the other re-sends old news.
  ([0012](docs/decisions/0012-thirty-day-retention-on-items.md))
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
- **On an inbound message, `formatted` beats `text`.** Mastra builds the model's
  input as `stringifyMarkdown(message.formatted) || message.text`, and the
  adapter always sets `formatted` — so anything injected into `text` alone is
  silently dropped. That is the whole trick to `withQuotedMessage`
  ([0013](docs/decisions/0013-swipe-to-reply-as-article-context.md)): the note
  goes into the AST, and `text` is kept in step only so the two don't disagree.
  Copy the message rather than editing it — `handleIncomingMessageUpdate` calls
  `cacheMessage` on the object *before* handing it to the handler.
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
- **Tab order is Telegram's, not ours.** The client sorts tabs by most recent
  message, so the order of `TOPICS` only decides creation order and no Bot API
  method reorders them. Chat was created first and still sat under News until a
  reply landed in it (verified 2026-07-28). A request to "put that tab first" has
  no code answer — the only thing that moves a tab up is traffic in it.
- **A search index is not a `LIKE`.** `search-news` matched the reader's entire
  phrase as one contiguous substring, so `fine tune` could not find `fine-tune`
  and every multi-word question missed. It now goes through `items_fts`
  ([0011](docs/decisions/0011-fts5-for-article-search.md)). Two things bite when
  touching it: punctuation is FTS5 *match syntax*, so terms must be quoted or
  `fine-tune` throws `no such column: tune`; and the `AFTER UPDATE` trigger is
  scoped `OF title, excerpt, content` because the pipeline writes `score` and
  `deliveredAt` on every run and would otherwise reindex the table each time.
  Verify the index against `items` with
  `INSERT INTO items_fts(items_fts) VALUES('integrity-check')`.
- **A tool that returns only headlines produces a model that hedges.** The
  original `search-news` returned title/source/link/score and nothing else, so
  even a *successful* search left Ava unable to say anything about an article —
  she hedged, and it read as a search failure. It returns `excerpt` and `reason`
  now, and `read-article` returns the body for one item at a time.
- **Listing and reading are separate tools on purpose.** `search-news` matches
  on the full body but returns excerpts; `read-article` returns one body in full.
  Putting bodies in the search result is the obvious-looking change and is the
  wrong one twice over: at the 8k cap fifteen results is ~30k tokens a search,
  and it buries the article the reader asked about under fourteen others. Both
  tools return `id` so the model can go from one to the other — if that field
  is ever dropped from `articleShape`, reading breaks silently and Ava goes back
  to answering from excerpts.
- **Telegram feeds carry no body worth having, so `read-article` fetches.**
  Hacker News items store the HN boilerplate as their excerpt — `Article URL: …
  Points: 180 # Comments: 48` — and 15 of 288 items had no `content` at all.
  `read-article` falls back to `fetchArticleText` for exactly those, and
  deliberately does **not** write the result back: that would make it the one
  tool on the conversational surface that writes to the pipeline's tables, and
  invariant 8 is worth more than a free cache. Verified against Android
  Developers, which ships no `content:encoded`: 7999 chars fetched live, 568 of
  them nav chrome before the article starts.
- **The reply is invisible until it's finished, unless streaming is on.**
  `streaming` defaults to false for every adapter except Slack, and the
  orchestrator takes ~25s over three round trips on a question that hits a tool.
  The typing indicator does not cover the gap: the adapter sends
  `sendChatAction` once, Telegram expires it after ~5s, and Mastra only re-sends
  when the status *string* changes — which it doesn't while the model thinks.
  `streaming: true` on the adapter entry streams through Telegram's draft API
  and posts one real message at the end. It is a no-op in a supergroup:
  `stream()` returns null unless `isDM`, i.e. a positive chat id.
- **A reply that starts mid-word is the model, not the transport.** minimax-m3
  intermittently closes its `</think>` tag *inside* the answer it has already
  started writing, so OpenRouter routes the opening of the reply into the
  reasoning channel and only the tail reaches Telegram. Seen twice in one real
  session: the reader got `'as d'autres questions !` and a bare `✨`. It looks
  exactly like broken streaming, and it isn't — check
  `mastra_messages` before touching the adapter:

  ```
  reasoning: "…No tools needed.De rien 😄 N'hésite pas si t"
  text:      "\n\n'as d'autres questions !"    ← all Telegram is given
  ```

  `reasoning: { enabled: false }` does not suppress it — verified against the
  live API, m3 emits the think block regardless. The only real fix is a
  different orchestrator model; measured alternatives, same conversation, three
  runs each: `anthropic/claude-haiku-4.5` ($1/$5 per M) 1.0–1.8s and no think
  block at all, `google/gemini-3.6-flash` ($1.50/$7.50) 1.3–1.6s cleanly split,
  `deepseek/deepseek-v4-flash` ($0.14/$0.28) cleanly split but one run in three
  took 12s. Staying on m3 ($0.30/$1.20) is a deliberate cost call — the
  truncation is the price.
- **A workflow can't be run from a plain script.** `createRun()` resolves fine
  and `run.start()` then hangs forever with "unsettled top-level await" —
  schedules are "only supported on the evented engine", and the evented engine
  needs the pubsub loop the Mastra server owns. Nothing is wrong with the
  workflow when this happens. Test a *step's* logic by calling the functions it
  calls (that is how retention was verified, against a copy of the database), and
  test the *workflow* from Studio. `mastra.listWorkflows()` and
  `workflow.getScheduleConfigs()` do work in a script, which is enough to prove
  registration and fire times.
- **Clustering is empirically tuned.** Before changing
  `clusterSimilarityThreshold` or the token filter, re-run ingest and inspect the
  actual merges. ([0007](docs/decisions/0007-lexical-clustering-instead-of-embeddings.md))
- **Model IDs need the `openrouter/` prefix.** Mastra's registry lists `deepseek`
  and `minimax` as *direct* providers too, so a bare `deepseek/deepseek-v4-flash`
  is valid — it just bills DeepSeek and demands a `DEEPSEEK_API_KEY`. `env.ts`
  rejects unprefixed IDs at startup; don't weaken that guard to "make it work".
- **A memory is never rewritten, and that is not an oversight.** The obvious
  change to `memories` is to update a fact in place when it stops being true.
  Doing it deletes the only thing that makes the table more than a key-value
  store: "dark hair (2025-01)" followed by "blond hair (2026-01)" is what lets
  Ava answer *"blond, since January — dark before that"*. Verified against the
  live model, which said exactly that. `forget-memory` is for a fact that was
  never true, not for one that changed.
  ([0014](docs/decisions/0014-two-tier-memory-for-ava.md))
- **The memory reviewer's prompt was calibrated backwards on the first try, and
  a plausible prompt is not evidence.** Told to drop borderline notes, it
  returned an *empty list* on three runs out of three — which would have deleted
  a new job and a named sister. The asymmetry runs the other way: a wrongly kept
  note costs one line, a wrongly deleted one is gone silently. Then, told to drop
  duplicates, it returned the duplicate *with a reason saying it should be
  dropped* — the reason field is a scratchpad unless the prompt says everything
  returned is kept regardless of what its reason says. Re-run the fixture set
  three times after touching that prompt or changing `AVA_MODEL_MEMORY_REVIEWER`;
  one green run proves nothing.
- **The ranker moves ±10 points on identical input, so a prompt A/B without a
  control is worthless.** Adding the reader-notes block
  ([0016](docs/decisions/0016-reader-notes-in-the-ranker.md)) moved 11 of 14
  scores on the first measurement, which looks like a working feature and was
  nearly reported as one. Running the *same* prompt three times showed a mean
  max-min spread of **10.0 points per item** — almost every delta was inside it,
  and the two that weren't pointed the wrong way. Any claim about a ranking
  prompt needs both conditions run at least three times and the within-condition
  spread reported next to the between-condition delta. To measure whether the
  model acts on something at all, don't A/B *presence* — flip the input's
  *direction* and watch the items it names: `+80.0` on those against `+5.3` on
  the rest is a mechanism, `+15` on everything is weather.
- **French is a facade on Ava's replies, and nowhere else.** A memory may record
  that the reader writes in French and expects `vous`. That note is now in the
  *ranker's* prompt too, where obeying it would produce French `reason` strings
  in `items` — read later by `search-news`, by the article writer, and by
  whoever opens the database. Every stored string, every prompt, every note is
  English; only the text Telegram shows a human follows the reader's language.
  Both prompts say so explicitly (`curator.ts` for reasons, `ava.ts` for notes)
  because neither model infers it — verified across six ranking runs carrying a
  lasting "writes in French" note, all reasons English.
- **`decide` and `apply` are separate steps so a bad model response can't
  delete.** `reviewMemories` throws when the response has no parsed object rather
  than returning `[]`, because the caller deletes everything not promoted —
  "the model returned junk" and "nothing was worth keeping" must never be the
  same value. Promotion also runs *before* the sweep, and the sweep matches
  `tier = 'short'` only, so a note rescued this run cannot be deleted by it.
- **Ava's instructions are a function now, and the notes go in a second system
  message.** Concatenating them into the one string would change the whole
  prompt every turn and lose the cacheable prefix. The block also carries today's
  date — without it every date in the notes is an opaque string and the
  supersession reading doesn't happen at all.
- **A slash command still carries the swipe.** `handleSlashCommandUpdate` passes
  the untouched Telegram payload through as `event.raw` (verified in
  `@chat-adapter/telegram` 4.35), so a reply the reader typed `/translate` into
  reaches the handler with `reply_to_message` intact. That is the whole reason
  the translation commands work on a swipe without a second inbound path —
  `quotedSource()` is the same parser and the same link-to-item lookup the
  message path uses. Don't add a message-path special case for a command.
- **A prompt rule obeyed 99% of the time is a bug at this volume.** Densely
  glossing an article asks the model for hundreds of small judgements in one
  response, so "never gloss a proper noun" still shipped
  `OlmoEarth (OlmoEarth)`, and "never gloss a grammatical word" still shipped
  `sont (are)` and `dans (in)`. Strengthening the prompt moved density from 47
  glosses per 100 words to 29 and eliminated neither. `pruneGlosses` in
  `translator.ts` strips exactly the two cases that need no judgement — an echo
  of the word in front of it, and a bare English function word. Anything needing
  taste stays in the prompt and stays imperfect. Note the elision split in there:
  without it `L'API (API)` is not an echo, and in French the article fuses to the
  noun constantly.
- **`htmlToText` used to space out every tag, which destroyed code.**
  `<code>WebAssembly</code>.<code>compileStreaming</code>()` was stored as
  `WebAssembly . compileStreaming ()` — invalid, and invisible for the life of
  the project because a summary never quoted code. The translation commands put
  code in fenced blocks, where it is unmissable. Inline tags are now stripped
  rather than replaced with a space, and `td`/`th` had to join the block-closer
  list so table cells still separate. **Only new items benefit** — a conditional
  GET means an existing row keeps its mangled body forever, which is why the
  translator's prompt *also* repairs code spacing. Don't remove one fix on
  finding the other.
- **`translation.readerLevel` is the lever, not the gloss wording.** Both
  commands filter by CEFR level before anything else. Set to B2 the model glosses
  `raffinement` and `s'emboîtent`; with no level at all it glossed
  `vous n'avez (don't have)` and `petit (small)`, which is the feature failing
  while appearing to work. The two commands separate on the *same* axis —
  `/translearn` at the level and above, `/translate` only above it — and when
  that distinction was left to words like "dense" and "sparse" they converged to
  within two glosses of each other. Re-measure `minGlossesPer100Words` after
  changing the level; it went from ~27 per 100 words unlevelled to ~7.4 at B2,
  and a floor left at the old value retries every good run.
- **Telling a model to drop boilerplate makes it announce that it did.** The
  fetch fallback in `read-article` carries nav chrome, which a summary tolerates
  and a *translation* renders verbatim — a real run opened with
  `Retour aux Articles (Back to Articles)` and the CSS fragment `a]:hidden`.
  Adding a "drop page furniture" rule fixed that and produced a run whose first
  paragraph was a bulleted note listing what it had removed. Both rules are
  needed: drop it, **and** never describe the drop.
- **A prompt rule written in English gets applied to English.** `/summarize`
  was told never to write about the article, only about its subject — the usual
  "no 'This article covers…'" rule. Four live runs on one article: both English
  runs obeyed it and both non-English runs broke it, with
  `Cet article détaille une conversation…` and
  `Este resumo aborda um painel de discussão…`. The model was matching the
  *strings* the rule named rather than the shape of sentence it described. The
  fix was to quote the observed non-English openers verbatim and say outright
  that the rule is about the sentence, not about the English words — zero of
  four on a re-run of the same article. **So test a multilingual prompt in the
  languages it will actually run in**; an English pass proves nothing about the
  others, and this is the same class of failure as the reasons-must-be-English
  rule in the ranker, seen from the other side.
- **"Code goes in backticks" over-applies to proper nouns.** The same command
  came back with `Claude Code`, `Claude Tag` and `Fable` fenced as code
  throughout, which reads like a config file. Adding an explicit "a name is not
  code — backticks are for things you would *type*" cut it to three instances in
  one run of four (`Bun`, `Rust`, `Slack`) and did not eliminate it. Left in the
  prompt deliberately: a deterministic backtick-stripper would corrupt the real
  code spans the rule exists to produce.
- **`deepseek-v4-flash` has a latency range, not a latency.** Ten runs on one
  1556-character chunk: 9s, 11.6s, 21.1s, 25.7s, 52.8s, 68s, 107s, 160.8s,
  207.7s, 282.8s — a factor of thirty, uncorrelated with output length. Two runs
  will tell you whatever you want to hear, in either direction; the first pair
  measured here said 68s/107s and nearly justified switching models on it. Don't
  quote a number for this model, and don't tune a timeout against one.
- **`.history/` must stay gitignored.** An IDE extension snapshots `.env`
  verbatim into it.

## Where work stopped

*Last updated: 2026-07-29.*

**`/summarize [language]` — verified against the live model, and the command path
confirmed on the real bot — 2026-07-29.** A real swipe followed by
`/summarize ru` came back in Russian from the phone. That run predates the prompt
fixes recorded below, so what has been seen end to end is the *path*, not the
current prompt. Swipe an article, send the command, and it comes back as one
message in **Chat**: several paragraphs plus bullets where the article really is
a list of specifics. `/summarize` alone writes English; `/summarize fr`,
`/summarize ru`, `/summarize français` write that language
([ADR-0018](docs/decisions/0018-summarize-command.md)).

**The argument means the opposite of what it means to `/translate`.** There, text
after the command *is the text to translate*; here it is the target language and
the text comes from the swipe. That is why this is its own config
(`src/config/summary.ts`), its own handler, and not a third entry in
`TRANSLATIONS`. Anyone tempted to unify the two argument parsers should read
ADR-0018 first.

Three things are deliberately unlike the translator, all in ADR-0018: **one call
with no chunking** (a summary of part 3 is not a summary), **no
degenerate-result retry** (the translator's exists against a measured 1-in-7
failure; nothing equivalent has been observed here, and inventing one would
double the wait), and **no read of `memories`** (the language is typed, not
remembered — so this command touches only `items`).

Verified against the live database and the live model, eight runs over one real
7998-character article: `/summarize` → English, `ru` → Russian, `fr` → French,
and the deliberately mistyped `protuguese` → **Portuguese**, which the model
corrected rather than falling back on. 296–465 words, 6–8 blocks, **5.4s to
11.8s** — nothing like the translator's 9s–283s, which is why there is no
partial-output machinery here. `items` was 293 before and 293 after, which is the
check that nothing was written. Offline, the language guard was checked against
12 accepted and 8 rejected arguments, and `renderSummary` parsed to
`heading, paragraph, paragraph, list, paragraph, paragraph` through the real
`formatConverter` with the link intact and an asterisk in the title escaped.

Two prompt defects were found by those runs and one is only mostly fixed — see
the two new gotchas above about multilingual rules and backticked proper nouns.

**The unknown-language path has never been observed.** `protuguese` was meant to
trigger the "write in English and report English" fallback and instead got
corrected, so the branch that handles a token naming no language at all is
written and untested. The reader would see a summary footed `English`; nothing
worse can happen, since the argument is shape-checked before it reaches the
model.

**Working and verified:** ingest with conditional GET, global dedupe, clustering,
ranking, per-article summarization, seven registered schedules (2 categories ×
08:00 / 13:00 / 19:00 Europe/Paris, plus a 04:00 prune), and Telegram delivery.
Verified by a real scheduled fire on 2026-07-27: both 19:00 schedules fired, 272
items ingested, 257 with article bodies, 8 articles delivered, no errors.

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
Three Telegram topics (`src/config/topics.ts`): **Chat**, **News** and
**Translations**. Digests target News, translations target Translations; `Ava`
(`src/mastra/agents/ava.ts`) answers in Chat and owns the only inbound path — a
polling adapter on `channels.adapters`. She has five read-only tools over the
news tables. See [ADR-0009](docs/decisions/0009-telegram-topics-as-tabs.md).

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

**Ava answers in Chat — verified end to end 2026-07-28.** Real inbound messages
from the phone were answered in the Chat tab: four updates Telegram had queued
drained on boot and got replies, then live messages after them. The polling
adapter, the tab router and memory-on-one-thread all work against the real bot.

The failure that prompted checking: **she is silent whenever the process isn't
running**, and that looks exactly like a code regression. Telegram queues the
updates (`getWebhookInfo.pending_update_count` counts them) and the adapter
resets the webhook with `dropPendingUpdates: false`, so they are all answered
once it comes back — there is no other symptom. Check that the process is up
before reading any code.

**Still unverified:** that a digest actually lands in the News tab. Needs a real
scheduled fire, which has not happened since the tabs were provisioned.

**Still not wired:** the 👍/👎 loop. The inbound path now exists, so
`recentFeedback()` could finally be fed, but nothing handles a reaction yet and
it still always returns empty. `recordVote(item, vote)` takes the whole item now,
not an id — the caller has it in hand, since a reaction arrives on a message
built from it.

**The ranker reads Ava's notes about the reader — verified offline, 2026-07-28.**
`rank` now renders `memoriesForCuration()` beside the (still empty) vote profile,
so the reader steers their digest by telling Ava what they want
([ADR-0016](docs/decisions/0016-reader-notes-in-the-ranker.md)). This is what the
👍/👎 loop was going to be and isn't yet: a thumb can only teach the ranker about
a pattern it has already sent, a sentence can name a subject it never has.

The ranker's prompt splits the notes in two, and the split is measured rather
than assumed: a note stating what the reader wants is an instruction, applied
hard and only to what it names (**+80.0** on those items, `+5.3` on the rest,
against a 10-point noise floor); passive biography only breaks ties and mostly
moves nothing, which is intended. See the ±10 gotcha above before touching that
prompt — the first measurement of this change was a false positive.

**Not yet seen on a real fire.** Every run above was `agent.generate()` from a
script against a *copy* of the database with seeded notes (live `memories` was 2
rows before and after). What has never been observed is a scheduled run ranking
against notes Ava wrote herself, and the live table has nothing in it yet that
expresses a preference — "Franck has brown eyes" is exactly the background the
ranker is told to ignore. Telling Ava one thing you want more of, in the Chat
tab, is what makes the next 08:00 run the first real test.

**Ava has memory — verified end to end against the live model, 2026-07-28.** A
`memories` table (Drizzle, `0007`), two tiers, one row per fact, and the whole
thing injected into her instructions every turn
([ADR-0014](docs/decisions/0014-two-tier-memory-for-ava.md)). This is the "real
feedback system" the 👍/👎 loop was never going to be: 👍/👎 trains the *ranker's*
taste, this is what Ava knows about the *person*.

Three new tools, and they are the only ones on the conversational surface that
write — see the amended invariant 8. `remember` (one fact, tier chosen at write
time), `recall-memories` (reaches past the prompt caps and hands back the ids the
injected block deliberately omits), `forget-memory`.

`instructions` is now an async function returning two system messages: the static
prompt, then today's date and the notes. `src/mastra/agents/memory.ts` renders
the block; `src/config/memory.ts` holds the window and the caps.

Verified two ways. Against a **copy** of the live database (288 items, untouched
at 288 afterwards): a re-stated fact deduped through normalization rather than
adding a row, a 45-day-old short-term note dropped out of the block while
`recall-memories` still found it, `2025-01-15` and `2026-01-20` survived the
round trip with no day drift, oldest-first ordering held, and `forget-memory`
returned what it deleted. Then against the **live model**, one real turn:
*"Je m'appelle Franck, je vis à Nantes et je suis allergique aux arachides. Ce
midi j'ai mangé un curry"* produced four `remember` calls in that one turn,
tiered correctly (name/city/allergy `long`, curry `short` with today's date),
none of them announced in the reply — and she used the allergy immediately,
unprompted. Asked *"de quelle couleur sont mes cheveux ?"* against two dated,
contradicting notes she answered *"Blonds, depuis janvier 2026. Auparavant, vous
les aviez foncés."*

**Not yet seen against the real bot.** Every turn above went through
`agent.generate()` from a script with `TELEGRAM_BOT_TOKEN` deleted from the
environment first — that is deliberate and worth copying, since importing the
agent with a token present constructs a *second* polling adapter and it would
eat the live bot's updates (invariant 7). What a `remember` card looks like in
Telegram with `toolDisplay: 'cards'` has therefore never been observed, and four
memory cards on a first message may well be too much chatter.

**The weekly review closes that loop — verified 2026-07-28.** `review-memories`
(`src/mastra/workflows/review-memories.ts`) is the eighth schedule: Monday 05:00,
between the 04:00 prune and the 08:00 digest. It hands every note to a
`memory-reviewer` agent, promotes what has turned out to be biography, and
deletes the expired rest ([ADR-0015](docs/decisions/0015-weekly-memory-review.md)).
That is the third model call on a schedule and the reason invariant 2 is now
worded around *classifier over a fixed row set* rather than a list of two steps.

Verified against a copy of the live database with a seeded fixture set: the new
job and the named sister were promoted, the meals, the film and the flaky test
were deleted, a duplicate of an existing lasting note was dropped, the
still-fresh short note was untouched, promotion kept the original `happenedOn`,
and every promoted note survived the sweep that ran immediately after it.
`listWorkflows()` returns `['curateCategory', 'pruneItems', 'reviewMemories']`
and its schedule reads `{ cron: '0 5 * * 1', timezone: 'Europe/Paris' }`.

**Not yet seen on a real fire.** Nothing in the live database is old enough to
expire — the oldest note dates from today — so the first real run has nothing to
do until late August. Studio (**Workflows → reviewMemories**, input `{}`) is the
way to watch one; it cannot be driven from a script, see the evented-engine
gotcha. What has never been observed is a run over notes Ava wrote *herself*
rather than fixtures written to test her.

**Search rebuilt on FTS5, and the reply streams — 2026-07-28.** Both came out of
one real conversation that went wrong: the reader asked about *"the 500$ rl fine
tune"*, watched an empty chat for ~30 seconds, and got told Ava didn't know which
model they meant — about an article she had delivered to them that morning.

Two independent causes, both since fixed and verified:

- **Search couldn't tokenize.** One `LIKE '%<whole phrase>%'`, so `fine tune`
  missed `fine-tune`. Replaying the turn, all four of the model's searches
  returned nothing. Now `items_fts` with porter stemming and bm25
  ([0011](docs/decisions/0011-fts5-for-article-search.md)) — all four return the
  right article ranked first, and the same question answers correctly in 8.4s.
  288 existing rows were backfilled by the migration's `'rebuild'`; triggers
  verified for insert, text update, non-text update and delete against a copy of
  the live database before it was applied for real.
- **Nothing streamed.** ~25s of silence with a typing indicator that expires
  after 5. `streaming: true` on the adapter entry, plus `toolDisplay: 'cards'`
  kept on deliberately — seeing `searchNews` return `{"articles": []}` in the
  chat is how the search bug was noticed at all. Turn it to `'hidden'` when it
  stops earning the noise.

**Verified end to end for search, offline only for streaming.** The FTS5 work was
checked against the live database and through a real agent turn. `streaming:
true` typechecks and the draft path was read in the compiled adapter, but it has
not yet been watched on a phone — that needs a real inbound message.

**Ava is on vous, and the streaming report was a red herring — 2026-07-28.** A
real session came back reading like a chat between mates: `T'as d'autres
questions !`, a reply that was nothing but `✨`, and `Tu veux que je te dise quoi
en plus ?`. The prompt's only tone rules were "skip the flattery" and "short by
default", and short is what the model optimised.

`instructions` now carries a **Tone** block: answer in the reader's language and
use its formal register — `vous` in French, never `tu` — full sentences rather
than telegraphic fragments, at most one emoji and never an emoji alone, and no
throwaway closing question. Verified by replaying the three turns from that
session against the live model: `Avec plaisir. Bon courage pour la suite.`,
`Très bien, bonne soirée.`, and a full paragraph self-description on `vous`. The
first draft of the block still answered `Non c'est bon` with `Pas de souci,
autre chose ?`, which is why the closer rule names the done-signal explicitly.

The truncated first message in the same session looked like the streaming work
regressing. It wasn't — see the `</think>` gotcha above. Streaming itself is
still only verified offline.

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
Since verified with real inbound messages too — see *Where work stopped*.

**Tab names carry an emoji, and a rename reconciles — 2026-07-28.** `emoji` is a
separate field from `title` in `src/config/topics.ts` because the two have
different audiences: `topicTabName()` joins them for Telegram, while `title`
alone is what Ava's instructions and the welcome interpolate (`the "💬 Chat" tab`
reads badly in a prompt). `resolveTopics()` now pushes a changed name with
`editForumTopic` and records what it sent in `telegram_topics.name` — there is no
`getForumTopic` to read a name back with, so remembering it is the only way to
know whether config has drifted from the live tab. Verified by renaming both live
tabs in place: same ids, no duplicates, no lost messages.

**Search can reach the article body, and the database now has a ceiling —
2026-07-28.** Two changes, both verified by running.

`read-article` is a fifth tool: full stored text for one item, keyed by the `id`
every list tool now returns. `search-news` still returns excerpts and still
matches on bodies — the split is the point, see the gotcha above. Verified
against the live database: a stored body came back at 7998 chars against a
396-char excerpt, an Android Developers item with no `content` fetched 7999 chars
live, an unknown id returned null, and the `content is not null` count was
unchanged at 273 afterwards, which is the check that nothing was written back.

`prune-items` is a seventh schedule, daily at 04:00, deleting items older than
`pipeline.retentionDays` (30) — and **only** items
([0012](docs/decisions/0012-thirty-day-retention-on-items.md)). Verified against
a *copy* of the live database with 60 rows aged past the cutoff and
`pruneBatchSize` forced to 7 so the loop ran nine times: 288 → 228 items,
`items_fts` 288 → 228 in step, `integrity-check` clean, zero index rows left
pointing at nothing.

**Votes are kept forever, and that is why `feedback` denormalizes.** The first
version of retention swept votes whose article had been pruned, on the reasoning
that they were unreadable anyway. True, and the wrong conclusion: they were
unreadable because `recentFeedback` joined `items` for the title, so a 30-day
retention silently gave the reader's taste a 30-day memory. `feedback` now stores
`title` and `source` on the vote — the whole of what `renderInterestProfile`
emits — nothing joins `items`, and no vote is ever deleted. Keeping the rows
*without* denormalizing would have looked like a fix and changed nothing.

The table can grow without bound and that is fine: it grows only when a human
presses a button (~100 bytes), while items arrive by the hundred daily on their
own. `feedbackWindow` (40) still caps what reaches the prompt.

Verified end to end against a copy: a vote cast under the old schema was
backfilled by the migration, a vote cast through `recordVote` on an article that
was then pruned still appeared in the profile the ranker sees, and `getItem`
returned null for that article at the same moment.

Registration is verified through Mastra itself: `listWorkflows()` returns
`['curateCategory', 'pruneItems']` and `pruneItems.getScheduleConfigs()` returns
`[{ cron: '0 4 * * *', timezone: 'Europe/Paris', inputData: {} }]`.

**Not yet seen in production:** no prune has fired on a real schedule. Nothing in
the live database is old enough to delete yet — the oldest item is from
2026-07-27, so the first real fire has nothing to do until late August. Studio
(**Workflows → pruneItems**, input `{}`) is the way to watch one; it reports
`{ cutoff, items, feedback }` and will legitimately report zeroes for a month. It
cannot be driven from a script — see the evented-engine gotcha above.

**`mastra_*` tables are not covered and must not be.** Mastra owns them
(invariant 4), and they are not spare capacity — they are what Studio and the
runtime read: `mastra_workflow_snapshot` is workflow run history *and* the state
a suspended run resumes from, `mastra_threads` / `mastra_messages` are Ava's
conversation memory. Deleting rows there is not a cleanup, it is deleting the
chat history and breaking resumability. They are small today (22 snapshots, 30
messages) but grow per run and per turn with nothing trimming them, so this will
look tempting later. If storage ever looks wrong after retention ships, measure
with `select name, sum(pgsize)/1024 kb from dbstat group by name order by kb desc`
before assuming the prune job is broken. Mastra ships its own retention
configuration (`reference-storage-retention` in the embedded docs); that is the
lever, not a `delete from mastra_*`. Traces are the exception and already handled
by construction — they live in `traces.db`, which is disposable as a whole file.

**A swiped reply now carries the article — offline only, 2026-07-28.** Replying
to a digest and asking "what is this about?" used to arrive as those five words
and nothing else. `withQuotedMessage` (`src/mastra/channels.ts`) prepends what
the reader pointed at, and when the quoted message carries a link to a stored
item, the note names that item's id so Ava calls `read-article` rather than
searching. **No table was needed and none was added** — the item id is a hash of
the canonical link and the digest carries that link in its heading, so the URL in
the quoted message *is* the primary key
([0013](docs/decisions/0013-swipe-to-reply-as-article-context.md)).

Verified offline against the live database and the real `stringifyMarkdown`: a
synthetic rich-message digest flattened to heading, lede, both points and footer
with the photo block's `file_id` left out, its link hashed to the id of the row
it came from, the note rendered as a blockquote followed by the `read-article`
line, the original message object came out unmutated, and a message that is not
a reply was passed through by identity. The topic-root and `forum_topic_created`
cases both returned undefined.

**Not yet seen against the real bot, and this is the part that matters.** Every
payload above was hand-built. Whether Telegram populates `reply_to_message` at
all for a reply inside a *private-chat* topic is exactly what has never been
observed here — the Bot API documents it, the adapter passes it through, and
neither of those is a run. One swipe on a real digest settles it.

**`/translearn` and `/translate` — verified offline, 2026-07-28.** Swipe an
article, send the command, and it comes back in the reader's own language with
the English original in parentheses: densely for `/translearn` (a study aid),
only on terms worth watching for `/translate`
([ADR-0017](docs/decisions/0017-translation-commands.md)). The two differ *only*
by the `gloss` string in `src/config/translation.ts`; a third density is an
entry there, not a handler.

A **third tab**, `📜 Translations`, is where the output lands — a translated
article is several messages and would bury the conversation in Chat. It is third
in `TOPICS`, which decides creation order and nothing else (see the tab-order
gotcha). **This tab has never been created against the live chat**: nothing here
has run with a token present, so `resolveTopics()` has not yet had a chance to
make it. The first `/start`, digest or command after deploy does that.

Verified against the live database and the live model: a synthetic slash-command
payload carrying a reply to a real digest resolved to the right stored row; the
body came back at 7995 chars via the fetch fallback; `items` was 293 before and
293 after, which is the check that nothing was written; the rendered message
parsed to `heading, paragraph, paragraph, paragraph` through the real
`formatConverter` with the heading only on part 1, the source footer only on the
last, and the `n/N` marker absent when there is one part. Against the live model,
both commands resolved **French** from Ava's own notes with no language
configured anywhere, and separated cleanly on density — **26.1 vs 2.0 glosses
per 100 words** on the same chunk.

**Not yet seen against the real bot, and that is the part that matters.** Every
payload was hand-built. What has never been observed is a real swipe on a real
digest followed by a real command, the tab being created, or what several
minutes of waiting actually feels like on a phone.

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
