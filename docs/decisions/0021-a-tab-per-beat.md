# ADR-0021: A tab per beat, created on first delivery

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

Every digest went to one **News** tab. That was ADR-0009's assumption, stated
there outright, and it held while beats were a hand-written config array of two.
It stopped holding the moment beats became rows the reader creates by typing
`/follow` ([ADR-0019](0019-beats-as-reader-owned-data.md), and the discovery
workflow in [ADR-0020](0020-feed-discovery-from-a-subject.md)): a reader who
follows six subjects gets six subjects interleaved in one stream, which is the
problem ADR-0009 set out to fix, one level down.

The symptom that prompted this was reading an article about Formula 1 in a tab
called News, next to an article about WebKit.

Three things were already true, none of which needed changing:

- **`telegram_topics` is keyed by `(chatId, slug)` with no reference to
  `TOPICS`.** [ADR-0009](0009-telegram-topics-as-tabs.md) persisted topic ids in
  a table rather than deriving them, and `src/db/topics.ts` takes a plain
  `string` slug. The storage layer needed no migration and got none.
- **`beats` already carries what a tab is made of.** `slug`, `title` and `emoji`
  are columns, and the schema comments named their tab role before a tab
  existed — `emoji` as "prefixed to the title on the beat's Telegram tab",
  `archivedAt` as "tab closed".
- **Delivery already runs per beat.** `curateAll` fans out to `deliverBeat` in a
  `foreach`, so the step that sends already knows which beat it is sending for.

That last one is worth recording because ADR-0009 predicted otherwise. Its
"revisit if" said per-category tabs "change the delivery step's grouping, not
just its target". By the time it was revisited, ADR-0019 had already done the
regrouping for unrelated reasons, and the change really was just the target.

## Decision

**Every beat gets its own Telegram tab, named `<emoji> <title>`, and its digests
go there.**

- **The tab is created on first delivery**, not at `/follow`. `resolveBeatTopic`
  is called from the send path, so a tab appears the moment a beat first wins an
  article and never before. A beat whose discovery found no usable feeds, or
  whose ranker never clears the threshold, costs no tab at all — which matters
  because `/follow` takes three seconds to type and there is no command that
  deletes a tab.
- **Beat rows in `telegram_topics` are namespaced `beat:<slug>`.**
  `beatCommands.slugPattern` accepts `news`, `chat` and `translations`, so
  `/follow the news` can genuinely produce a beat whose slug collides with a
  system tab's row. Without the prefix the two would share a primary key and the
  first to resolve would hand the other its thread id. The prefix cannot itself
  collide because the pattern forbids a colon.
- **News becomes a fallback, not a destination.** It keeps every digest sent
  before this change, and now receives an article only when that article's beat
  tab could not be resolved. `sendToTelegram` takes an ordered chain — beat tab,
  then News, then the flat chat — and walks it on failure.
- **`/pause` closes the beat's tab and `/resume` reopens it — where Telegram
  allows it, which on a private chat is nowhere.** Probed against the live bot
  with `has_topics_enabled: true`: `closeForumTopic` and `reopenForumTopic` both
  answer `Bad Request: the chat is not a supergroup forum`, while
  `editForumTopic` against the same chat and the same id answers
  `TOPIC_ID_INVALID` — renaming reaches private-chat topics and closing does not.
  Bot API 9.3's notes list the methods extended to private chats and close/reopen
  are absent, which now reads as deliberate. The call is kept because the
  supergroup-forum route is a real deployment and works there; on a private chat
  `/pause` reports that the tab stays and goes quiet, which is the truth.
  Neither ever *creates* a tab: pausing a beat that has never delivered leaves it
  without one, because a tab that only a pause produced would be an empty tab
  nobody asked for.
- **`sendArticle`'s target is required.** It used to default to `'news'`. Every
  article belongs to exactly one beat, so a call site that has not said which
  beat has lost track of it, and a default would hide exactly the bug this ADR
  fixes.

Inbound routing needed no change at all. `routeToChatTab` moves any message in
the configured chat to the Chat tab, keyed on the chat id rather than on a list
of known topics, so a message typed in a beat's tab is moved like any other and
[invariant 9](../../AGENTS.md#invariants) holds for tabs that did not exist when
it was written.

## Consequences

**Good:** one subject per tab, which is what the reader asked the tabs for. The
tab strip becomes the list of what they follow, so `/beats` and the sidebar agree
without either being generated from the other. Telegram sorts tabs by most recent
message, so an active beat floats up on its own. Nothing was migrated, because
the tables that mattered were built for this.

Verified against the real bot on 2026-07-30: 13 articles into two tabs created on
their beats' first delivery, `sendErrors` empty on both runs, and the paused
`formula-1` left without a tab.

**Costs:**

- **Tabs accumulate and nothing prunes them.** `/pause` closes a tab; no command
  deletes one. A reader who follows and abandons ten subjects has ten tabs, and
  tidying them means deleting them by hand on the phone — which orphans the row
  until the next send fails and re-creates it. `deleteForumTopic` exists and is
  deliberately not wired: a command that destroys a tab full of history on a
  typed slug is not a command worth having yet.
- **The tab name is model output.** `beats.title` and `beats.emoji` come from the
  namer. A bad name is now a tab name, and the only way to change it is to
  recreate the beat. `TAB_NAME_MAX_CHARS` guards the length, since
  `createForumTopic` rejects an over-long name outright rather than truncating.
- **A silent degrade.** A beat tab that cannot be created falls back to News
  rather than throwing, and there is no logger on the transport to say so. The
  symptom is the article turning up in News, which is why News is documented as a
  tab that should be silent — anything in it is the report. That is weaker than a
  logged error and was chosen because the alternative is the article not arriving.
- **One `topicIds` read per beat per process** instead of one for all tabs. The
  set of beats is never known to be complete, so they cannot be batched the way
  `TOPIC_LIST` is. Memoized after the first resolve; a beat rename mid-process
  therefore does not reach Telegram until a restart, exactly as for system tabs.
- **A paused beat's tab cannot be closed on a private chat**, per the probe
  above, so it stays in the tab strip looking exactly like a live one. The only
  thing that distinguishes it is that nothing new arrives, and Telegram's
  recency sort will sink it over time. This is the one part of the decision that
  did not survive contact with the API, and it is why `/pause` describes the tab
  going quiet rather than closing.

**Revisit if:** the reader accumulates enough dead tabs to want a delete command
(then `deleteForumTopic` plus a confirmation, and decide what happens to the
articles), or Telegram grows a way to order or group tabs — today the client
sorts by recency and no API reorders them, so a "pinned" beat is not expressible.
