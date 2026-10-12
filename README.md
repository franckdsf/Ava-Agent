# Ava Agent 🦋

A self-hosted Telegram bot that reads RSS/news feeds and job boards on a
schedule, ranks what it finds against your interests, and delivers a curated
digest — no dashboard, no inbound webhook, just a chat.

> **⚠️ Vibe-coded.** This is a personal project, built almost entirely with an
> AI coding agent (Claude Code) and run for an audience of one. It works well
> enough that I trust it with my own reading, but it hasn't had a review, 
> a second maintainer, or production hardening. Read the code before
> you point it at anything that matters, and expect rough edges.

## What it does

Two bots, one reader. Both run **outbound-only** — the container polls
Telegram and calls an LLM gateway, nothing needs to reach it from the
network — so it runs fine on a laptop, a Raspberry Pi, or a small VPS.

### Newy — news

Subscribes to RSS feeds grouped into "beats" (e.g. `design`, `ai`,
`climate`), dedupes stories carried by multiple outlets, scores each item
against your beat's rubric and your past 👍/👎, and writes a digest for the
ones that clear the bar — three times a day, one message per article, into
a Telegram topic per beat.

Talk to Newy directly in the **Chat** tab: it remembers facts about you over
time (durable facts vs. recent context) and can translate or summarize any
article it delivered. A beat is just a row in the database — no code change,
no restart — so it can also be run by hand from Mastra Studio: `Workflows →
curateAll → { "beats": ["design"] }`.

| Command | What it does |
| --- | --- |
| `/follow <subject>` | Follow a new subject — Newy finds the feeds itself |
| `/beats` | List the beats it follows and how each is doing |
| `/beat <slug>` | Show one beat's rubric, feeds and thresholds |
| `/pause` / `/resume <slug>` | Stop or restart a beat without losing it |
| `/addfeed` / `/removefeed <slug> <url>` | Manage a beat's feeds directly |
| `/why` | Swipe an article and ask why it was — or wasn't — sent |
| `/summarize [lang]` | A few hundred words on an article, in any language |
| `/translate` / `/translearn` | An article translated, glossed for your level |

### Joob — jobs & leads

A second bot that crawls job boards and company career pages, scores
postings against your CV, and separately flags companies that look like
they *should* be hiring you even if they haven't posted a role — jobs in
the **Jobs** tab, prospects in **Leads**.

| Command | What it does |
| --- | --- |
| `/target <what you want>` | Describe a role in your own words — Joob parses it into a search |
| `/targets` / `/untarget <slug>` | List or stop one of your active searches |
| `/retarget <slug> [wording]` | Re-read a search with the current parser, or change it |
| `/client <what you sell, to whom>` | Describe a lead profile for prospecting |
| `/clients` / `/unclient <slug>` | List or stop one of your active client profiles |
| `/reclient <slug> [wording]` | Re-read a client profile, or change it |

Both command sets are also always in Telegram's own `/` menu for each bot,
with a one-line description — the tables above are the shape, not the full
help text (`/start` in either chat prints the rest).

## How it works

```
┌─ container (no inbound ports) ──────────────┐
│  Mastra          agents + workflows          │   ┌─ ava.db (libsql/Turso) ─┐
│  scheduler       native cron                  │──▶│  news / jobs / leads    │
│  Telegram        long-polling, outbound only │   │  memory, feedback       │
└──────────────────────────────────────────────┘   └─────────────────────────┘
```

Only two steps of the pipeline call a model — ranking and composing the
digest. Ingest, dedupe, and clustering are deterministic, so a scheduled job
never has an LLM improvising its own control flow.

Built on [Mastra](https://mastra.ai) for agents/workflows, libSQL for
storage, and `@chat-adapter/telegram` for delivery. Any model reachable
through [OpenRouter](https://openrouter.ai) works.

## Quick start

```bash
pnpm install
pnpm setup                # interactive: keys, your Telegram id, both bot tokens
docker compose up -d --build
```

`pnpm setup` walks you through getting a token from
[@BotFather](https://t.me/BotFather) and your numeric id from
[@userinfobot](https://t.me/userinfobot) — the two things only a human can do on
Telegram's side — checks each token live, and writes `.env`. Answer just the
`OPENROUTER_API_KEY` prompt and say no to the Telegram questions to skip
straight to `pnpm dev` (Mastra Studio at http://localhost:4111) and run the
news pipeline by hand instead.

State (dedupe history, feedback, memory) lives in the `ava-data` volume —
back it up.

## Useful dev commands

| Command               | What it does                                              |
| --------------------- | --------------------------------------------------------- |
| `pnpm dev`            | Mastra Studio — run workflows by hand, inspect traces     |
| `pnpm feeds:check`    | Confirm every subscribed feed is reachable                |
| `pnpm jobs:check`     | Dry-run the jobs pipeline against real sources, no writes |
| `pnpm telegram:check` | Verify both bots' profile, commands, and tabs are live    |
| `pnpm verify`         | Typecheck, rule checks, tests — what every commit runs    |

More scripts and what each proves: [docs/COMMANDS.md](docs/COMMANDS.md).

## Docs

- [AGENTS.md](AGENTS.md) — the operating contract: invariants, gotchas, and
  patterns for anyone (human or agent) working in this repo
- [docs/decisions/](docs/decisions/README.md) — ADRs explaining why it looks
  the way it does, including the ideas that were tried and reversed

## Status

News (ingest → rank → digest → Telegram) and jobs/leads are both running
day to day. The 👍/👎 feedback loop is wired for input but nothing consumes
it yet. See [AGENTS.md § Current state](AGENTS.md#current-state) for the
honest, up-to-date list of what's solid and what's known to be rough.
