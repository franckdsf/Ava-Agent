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
| [0008](0008-categories-as-configuration.md) | Categories as configuration, one parameterized curator | Accepted |
| [0009](0009-telegram-topics-as-tabs.md) | Telegram topics as tabs, splitting chat from news | Accepted |
| [0010](0010-ava-answers-only-in-the-chat-tab.md) | Ava answers only in the Chat tab | Accepted |
| [0011](0011-fts5-for-article-search.md) | FTS5 for article search, not embeddings | Accepted |
| [0012](0012-thirty-day-retention-on-items.md) | Thirty-day retention on items, enforced by a scheduled prune | Accepted |
| [0013](0013-swipe-to-reply-as-article-context.md) | Swipe-to-reply resolves the article, with no table | Accepted |

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
