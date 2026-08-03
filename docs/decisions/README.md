# Architecture Decision Records

Each file records one decision: the context that forced it, what was chosen, and
what it costs. They exist so nobody — including a future you, or an AI assistant
picking this repo up cold — has to re-litigate a settled question or guess why
something looks the way it does.

## Rules

- **One decision per file**, numbered and dated.
- **Never rewrite an accepted ADR.** If a decision changes, write a new one and
  set the old one's status to `Superseded by ADR-XXXX`. The reversal is the
  useful part.
- **Record the cost.** An ADR with no downside listed is marketing, not a record.
- Write it when the decision is made, not afterwards from memory.

## Index

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-mastra-in-a-container-with-no-inbound-ports.md) | Mastra in a container with no inbound ports | Accepted |
| [0002](0002-telegram-via-chat-sdk-adapter-in-polling-mode.md) | Telegram via Chat SDK adapter in polling mode | Accepted |
| [0003](0003-convex-for-storage-and-scheduling.md) | Convex for storage and scheduling | Superseded by [0005](0005-two-libsql-databases-instead-of-convex.md) |
| [0004](0004-native-mastra-schedules-over-a-job-queue.md) | Native Mastra schedules over a job queue | Accepted |
| [0005](0005-two-libsql-databases-instead-of-convex.md) | Two libSQL databases instead of Convex | Accepted |
| [0006](0006-drizzle-orm-for-application-tables.md) | Drizzle ORM for application tables | Accepted |
| [0007](0007-lexical-clustering-instead-of-embeddings.md) | Lexical clustering instead of embeddings | Accepted |
| [0008](0008-categories-as-configuration.md) | Categories as configuration, one parameterized curator | Partly superseded by [0019](0019-beats-as-reader-owned-data.md) |
| [0009](0009-telegram-topics-as-tabs.md) | Telegram topics as tabs, splitting chat from news | Partly superseded by [0021](0021-a-tab-per-beat.md) |
| [0010](0010-ava-answers-only-in-the-chat-tab.md) | Ava answers only in the Chat tab | Accepted |
| [0011](0011-fts5-for-article-search.md) | FTS5 for article search, not embeddings | Accepted |
| [0012](0012-thirty-day-retention-on-items.md) | Thirty-day retention on items, enforced by a scheduled prune | Accepted |
| [0013](0013-swipe-to-reply-as-article-context.md) | Swipe-to-reply resolves the article, with no table | Accepted |
| [0014](0014-two-tier-memory-for-ava.md) | Two-tier memory, dated and never rewritten | Accepted |
| [0015](0015-weekly-memory-review.md) | A weekly model-judged review promotes memories, then expires them | Accepted |
| [0016](0016-reader-notes-in-the-ranker.md) | The ranker reads Ava's notes about the reader | Accepted |
| [0017](0017-translation-commands.md) | Translation as slash commands, glossed inline, in their own tab | Accepted |
| [0018](0018-summarize-command.md) | `/summarize [language]`, answered in Chat, with the language typed rather than remembered | Accepted |
| [0019](0019-beats-as-reader-owned-data.md) | Beats are rows the reader owns, and a story is scored per beat but sent once | Accepted |
| [0020](0020-feed-discovery-from-a-subject.md) | `/follow <subject>` — the model proposes sites, the code finds the feeds | Accepted |
| [0021](0021-a-tab-per-beat.md) | A tab per beat, created on first delivery | Accepted |
| [0022](0022-ava-is-the-system-agents-have-names.md) | Ava is the system, and agents have their own names | Accepted |

**Reading 0001–0021:** they predate [0022](0022-ava-is-the-system-agents-have-names.md)
and call the conversational agent *Ava*. That agent is now **Newy**; *Ava* is the
system it lives in. The ADRs are frozen per the rule above and keep the old name,
filenames included.

## Template

```markdown
# ADR-XXXX: <short imperative title>

- **Status:** Proposed | Accepted | Superseded by ADR-YYYY
- **Date:** YYYY-MM-DD

## Context
What forced a choice. Constraints, and what was actually true at the time.

## Decision
What we chose, stated plainly.

## Consequences
**Good:** what this buys.
**Costs:** what it gives up. Be specific.
**Revisit if:** the condition that would reopen this.
```
