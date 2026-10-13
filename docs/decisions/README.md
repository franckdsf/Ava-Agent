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

| # | Decision | Status | Governs | Verify |
| --- | --- | --- | --- | --- |
| [0001](0001-mastra-in-a-container-with-no-inbound-ports.md) | Mastra in a container with no inbound ports | Accepted | `docker-compose.yml`, `Dockerfile`, `src/mastra/index.ts` | — |
| [0002](0002-telegram-via-chat-sdk-adapter-in-polling-mode.md) | Telegram via Chat SDK adapter in polling mode | Accepted | `src/mastra/agents/chat-agent.ts`, `src/services/telegram.ts` | `pnpm telegram:check` |
| [0003](0003-convex-for-storage-and-scheduling.md) | Convex for storage and scheduling | Superseded by [0005](0005-two-libsql-databases-instead-of-convex.md) | — | — |
| [0004](0004-native-mastra-schedules-over-a-job-queue.md) | Native Mastra schedules over a job queue | Accepted | `src/mastra/index.ts`, `src/mastra/workflows/**` | — |
| [0005](0005-two-libsql-databases-instead-of-convex.md) | Two libSQL databases instead of Convex | Accepted (amended 2026-10-02) | `src/db/client.ts`, `src/mastra/storage.ts`, `docker-compose.yml` | — |
| [0006](0006-drizzle-orm-for-application-tables.md) | Drizzle ORM for application tables | Accepted | `src/db/schema.ts`, `drizzle/**` | `pnpm db:generate` |
| [0007](0007-lexical-clustering-instead-of-embeddings.md) | Lexical clustering instead of embeddings | Accepted | `src/services/cluster.ts`, `src/config/pipeline.ts` | — |
| [0008](0008-categories-as-configuration.md) | Categories as configuration, one parameterized curator | Partly superseded by [0019](0019-beats-as-reader-owned-data.md) | `src/mastra/agents/curator.ts`, `src/mastra/workflows/curate-all.ts` | — |
| [0009](0009-telegram-topics-as-tabs.md) | Telegram topics as tabs, splitting chat from news | Partly superseded by [0021](0021-a-tab-per-beat.md) | `src/services/telegram*.ts`, `src/config/topics.ts` | `pnpm telegram:check` |
| [0010](0010-ava-answers-only-in-the-chat-tab.md) | Ava answers only in the Chat tab | Accepted | `src/mastra/agents/chat-agent.ts`, `src/mastra/chat-surface.ts` | — |
| [0011](0011-fts5-for-article-search.md) | FTS5 for article search, not embeddings | Accepted | `src/db/schema.ts`, `src/mastra/tools/news.ts`, `drizzle/**` | `pnpm db:generate` |
| [0012](0012-thirty-day-retention-on-items.md) | Thirty-day retention on items, enforced by a scheduled prune | Accepted | `src/mastra/workflows/prune-articles.ts`, `src/config/pipeline.ts` | — |
| [0013](0013-swipe-to-reply-as-article-context.md) | Swipe-to-reply resolves the article, with no table | Accepted | `src/services/telegram-reply.ts`, `src/services/quoted-article.ts`, `src/mastra/quoted-message.ts` | — |
| [0014](0014-two-tier-memory-for-ava.md) | Two-tier memory, dated and never rewritten | Accepted | `src/db/memories.ts`, `src/mastra/tools/memory.ts`, `src/config/memory.ts` | — |
| [0015](0015-weekly-memory-review.md) | A weekly model-judged review promotes memories, then expires them | Accepted | `src/mastra/workflows/review-memories.ts`, `src/config/memory.ts` | — |
| [0016](0016-reader-notes-in-the-ranker.md) | The ranker reads Ava's notes about the reader | Accepted | `src/mastra/workflows/curate-all.ts`, `src/db/memories.ts` | — |
| [0017](0017-translation-commands.md) | Translation as slash commands, glossed inline, in their own tab | Accepted | `src/mastra/commands/translate.ts`, `src/config/translation.ts` | `pnpm bench translator` |
| [0018](0018-summarize-command.md) | `/summarize [language]`, answered in Chat, with the language typed rather than remembered | Accepted | `src/mastra/commands/summarize.ts`, `src/config/summary.ts` | `pnpm bench summarizer` |
| [0019](0019-beats-as-reader-owned-data.md) | Beats are rows the reader owns, and a story is scored per beat but sent once | Accepted | `src/db/beats.ts`, `src/db/schema.ts`, `src/config/seed-beats.ts` | — |
| [0020](0020-feed-discovery-from-a-subject.md) | `/follow <subject>` — the model proposes sites, the code finds the feeds | Accepted | `src/mastra/workflows/discover-feeds.ts`, `src/config/discovery.ts` | `pnpm discovery:check` |
| [0021](0021-a-tab-per-beat.md) | A tab per beat, created on first delivery | Accepted | `src/services/telegram-topics.ts`, `src/db/topics.ts` | `pnpm telegram:check` |
| [0022](0022-ava-is-the-system-agents-have-names.md) | Ava is the system, and agents have their own names | Accepted | everything (`**`) | — |
| [0023](0023-a-bot-per-agent-two-tokens-two-chats.md) | A bot per agent — two tokens, two chats, one process | Variables amended by [0041](0041-one-deployment-one-reader.md) | `src/bots/`, `src/services/telegram.ts`, `src/mastra/agents/chat-agent.ts`, `src/mastra/registrar.ts` | `pnpm telegram:check` |
| [0024](0024-joob-a-job-pipeline-beside-the-news-one.md) | Joob — a job pipeline beside the news one, sharing everything but the tables | Accepted (amended 2026-08-23) | `src/mastra/workflows/find-jobs.ts`, `src/config/jobs.ts` | `pnpm jobs:check` |
| [0025](0025-a-boot-catch-up-for-a-stale-pipeline.md) | A boot fires a pipeline that has stopped running, on its own cadence | Partly superseded by [0045](0045-one-run-log-for-every-pipeline.md) | `src/mastra/boot-catchup.ts`, `src/config/catchup.ts` | `pnpm catchup:check` |
| [0026](0026-sonar-as-a-job-source.md) | Sonar as a job source, keyed on the page it resolves | Extended by [0040](0040-a-careers-page-with-nothing-on-it-is-a-lead.md) | `src/services/job-scout.ts`, `src/mastra/agents/job-scout.ts` | `pnpm sonar:check` |
| [0027](0027-ats-boards-as-discovered-sources.md) | Real postings off applicant-tracking boards, and the boards become sources | Partly superseded by [0029](0029-six-ats-providers-probed-concurrently.md) | `src/services/ats.ts`, `src/services/job-scout.ts` | `pnpm jobs:check` |
| [0028](0028-a-search-decides-what-counts-as-a-job.md) | A search decides what counts as a job, not the taxonomy | Extended by [0030](0030-domains-as-vocabularies-a-search-names-its-field.md) | `src/services/job-filter.ts`, `src/config/job-taxonomy.ts` | `pnpm jobs:check` |
| [0029](0029-six-ats-providers-probed-concurrently.md) | Six applicant-tracking providers, probed concurrently | Accepted | `src/services/ats.ts` | `pnpm jobs:check` |
| [0030](0030-domains-as-vocabularies-a-search-names-its-field.md) | Domains as vocabularies, and a search names its own field | Accepted | `src/config/job-taxonomy.ts`, `src/db/job-searches.ts` | `pnpm jobs:check` |
| [0031](0031-a-race-decides-which-sources-are-early.md) | A race decides which sources are early, not a health check | Accepted | `src/services/feed-timeliness.ts`, `src/config/feed-finder.ts` | `pnpm finder:check` |
| [0032](0032-a-youtube-link-summarizes-itself.md) | A YouTube link summarizes itself — a tool on Newy, not a command | Accepted | `src/services/youtube.ts`, `src/mastra/tools/youtube.ts` | `pnpm youtube:check` |
| [0033](0033-a-delivery-is-claimed-before-it-is-sent.md) | A delivery is claimed before it is sent, not stamped after | Accepted | `src/mastra/workflows/{curate-all,find-jobs}.ts` | — |
| [0034](0034-a-pipeline-claims-its-cycle.md) | A pipeline claims its cycle in one write, rather than checking then starting | Partly superseded by [0045](0045-one-run-log-for-every-pipeline.md) | `src/db/cycles.ts`, `src/mastra/workflows/**` | `pnpm catchup:check` |
| [0035](0035-a-source-is-judged-on-what-it-yields.md) | A source is judged on what it yields, not on whether it answers | Accepted | `src/db/jobs.ts`, `src/config/jobs.ts`, `src/mastra/workflows/find-jobs.ts` | `pnpm jobs:check` |
| [0036](0036-a-source-may-declare-its-field-and-a-search-may-be-re-read.md) | A source may declare its field, and a search may be re-read | Accepted | `src/db/job-searches.ts`, `src/services/job-filter.ts` | `pnpm jobs:check` |
| [0037](0037-the-hiring-thread-as-a-source-kind.md) | Hacker News's hiring thread is a source kind, not an adapter | Accepted | `src/services/job-hn.ts`, `src/services/job-fetch.ts` | `pnpm jobs:check` |
| [0038](0038-leads-a-prospecting-pipeline-in-joobs-chat.md) | Leads — a prospecting pipeline in Joob's chat, keyed on a company | Accepted | `src/mastra/workflows/find-leads.ts`, `src/services/lead-*.ts` | `pnpm leads:check` |
| [0039](0039-a-lead-scout-with-its-own-budget.md) | A lead scout with its own budget, and a verification the job scout does not need | Accepted | `src/services/lead-scout.ts`, `src/config/leads.ts` | `pnpm leadscout:check` |
| [0040](0040-a-careers-page-with-nothing-on-it-is-a-lead.md) | A careers page with nothing on it is a lead, not a job | Accepted | `src/services/job-scout.ts`, `src/services/page-fetch.ts` | `pnpm sonar:check` |
| [0041](0041-one-deployment-one-reader.md) | One deployment, one reader — and a `.env` that says only who they are | Accepted | everything (`**`) | — |
| [0042](0042-a-scheduled-model-call-has-a-shape-not-a-list.md) | A scheduled model call has a shape, not a list | Accepted | `src/mastra/workflows/**`, `src/mastra/agents/**` | `pnpm workflow:run` |
| [0043](0043-what-a-conversation-may-write-is-decided-by-what-reads-it-back.md) | What a conversation may write is decided by what reads it back | Accepted | `src/mastra/tools/**`, `src/mastra/commands/**`, `src/db/schema.ts` | — |
| [0044](0044-a-pipeline-s-cadence-is-one-definition.md) | A pipeline's cadence is one definition, and its claim is handed back before it is spent | Accepted | `src/mastra/pipeline-kit.ts`, `src/mastra/pipelines.ts`, `src/mastra/boot-catchup.ts`, `src/config/catchup.ts`, `src/config/leads.ts`, `src/config/jobs.ts`, `src/config/pipeline.ts`, `src/mastra/workflows/curate-all.ts`, `src/mastra/workflows/find-jobs.ts`, `src/mastra/workflows/find-leads.ts`, `scripts/checks/c8-one-cadence.mjs` | `pnpm verify` |
| [0045](0045-one-run-log-for-every-pipeline.md) | One run log for every pipeline, written by the kit | Accepted | `src/db/runs.ts`, `src/db/schema.ts`, `src/mastra/pipeline-kit.ts`, `drizzle/0028_copy_run_logs.sql` | `pnpm verify` |
| [0046](0046-a-model-is-chosen-by-pnpm-bench.md) | A model is chosen by `pnpm bench`, against the incumbent, on the real call path | Accepted | `src/config/env.ts`, `src/mastra/agents/**`, `src/config/bench.ts`, `scripts/bench/**` | `pnpm verify` |
| [0047](0047-a-bot-is-data-and-a-command-is-one-object.md) | A bot is data, built into an agent and a surface once; a command is one object | Accepted | `src/bots/**`, `src/services/telegram.ts`, `src/mastra/registrar.ts`, `src/mastra/chat-bots.ts`, `src/mastra/chat-surface.ts`, `src/mastra/quoted-message.ts`, `src/mastra/agents/chat-agent.ts`, `src/mastra/commands/**`, `scripts/checks/c7-bot-agnostic.mjs` | `pnpm verify` |
| [0048](0048-a-model-is-asked-through-structured-with-its-attempts-written.md) | A model is asked through `structured()`, with how many times written at the call site | Accepted | `src/mastra/agents/**`, `src/services/structured-output.ts`, `scripts/checks/c5-model-boundary.mjs` | `pnpm verify` |

**Reading 0001–0021:** they predate [0022](0022-ava-is-the-system-agents-have-names.md)
and call the conversational agent *Ava*. That agent is now **Newy**; *Ava* is the
system it lives in. The ADRs are frozen per the rule above and keep the old name,
filenames included.

## Format

Every ADR opens with a frontmatter block. It exists so an agent can decide whether
to read the file at all, from the paths it is about to touch:

```yaml
---
id: 0035
applies_to: ["src/db/jobs.ts", "src/config/jobs.ts", "src/mastra/workflows/find-jobs.ts"]
status: accepted            # accepted | amended | partly-superseded | superseded
supersedes: []
verify: "pnpm jobs:check"
---
```

- **`applies_to`** — the files this decision actually constrains. An agent loads the
  ADR only when its change intersects these globs, so the cost of 41 records scales
  with what is being touched rather than with how many exist. A glob that matches
  nothing routes nothing: check it before you commit it. Two records resist this —
  [0022](0022-ava-is-the-system-agents-have-names.md) (naming) and
  [0041](0041-one-deployment-one-reader.md) (one deployment) govern everything, carry
  `["**"]`, and for them the mechanism is a no-op.
- **`status`** — the index above is written from this field, not the other way round.
- **`supersedes`** — the ids this record replaces or amends, matching the
  `Supersedes:` / `Amends:` / `Extends:` line in the body.
- **`verify`** — the one command that proves the decision still holds. Ten of the
  fifteen check scripts are named here, and 25 of the 41 records carry one; that
  pairing used to live only in prose in `AGENTS.md`'s command table. Omitted where no
  script proves anything — `pnpm typecheck` is not a verification of a decision.

**A knowingly-broken rule becomes `status: superseded`, with the record that replaces
it named in the new ADR's `supersedes`.** Deciding once to do it the other way and
leaving the ADR reading `accepted` is the failure this format exists to prevent: the
document keeps asserting a rule the code stopped following, and every agent that
reads it is told something false. Never leave a decision documented as active that
the project has stopped following.

## Template

```markdown
---
id: XXXX
applies_to: ["src/…"]
status: accepted
supersedes: []
verify: "pnpm …:check"      # omit if no script proves it
---

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
