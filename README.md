<p align="center">
  <img src=".github/ava.png" alt="Ava" width="160">
</p>

# Ava Agent 🦋

A self-hosted Telegram bot that reads RSS/news feeds and job boards on a
schedule, ranks what it finds against your interests, and delivers a curated
digest — no dashboard, no inbound webhook, just a chat.

> **⚠️ Vibe-coded.** This is a personal project, built almost entirely with an
> AI coding agent (Claude Code) and run for an audience of one. It works well
> enough that I trust it with my own reading, but it hasn't had a review, 
> a second maintainer, or production hardening. Read the code before
> you point it at anything that matters, and expect rough edges.

> **💸 What it costs.** Pay-as-you-go OpenRouter credit — about **$2 a
> month** for a typical setup. It scales with what you follow:
>
> | Each… | ≈ per day | ≈ per month |
> | --- | --- | --- |
> | news subject (`/follow`) | $0.005 | $0.15 |
> | job search (`/target`) | $0.012 | $0.35 |
> | client profile (`/client`) — estimated, not yet measured | $0.010 | $0.30 |
>
> So 5 subjects and 4 job searches come to about $0.07 a day, $2 a month. The expensive calls are
> capped per run, so even with everything turned up it stays under ~$5.
> Chatting adds cents, `pnpm bench` runs cost extra, and a server, if you rent
> one, is extra. OpenRouter's activity page shows the real figure.

## ✨ What it does

Two bots, one reader. Both run **outbound-only** — the container polls
Telegram and calls an LLM gateway, nothing needs to reach it from the
network — so it runs fine on a laptop, a Raspberry Pi, or a small VPS.

### 📰 Newy — news

Subscribes to RSS feeds grouped into "beats" (e.g. `design`, `ai`,
`climate`), dedupes stories carried by multiple outlets, scores each item
against your beat's rubric, and writes a digest for the ones that clear the
bar — twice a day, one message per article, into
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

### 💼 Joob — jobs & leads

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

## 🚀 Quick start

About 15 minutes, most of it in Telegram. You need:

- a **Telegram** account;
- an **[OpenRouter](https://openrouter.ai)** account with a few dollars of
  credit — every model call goes through it;
- **Node 20.12+** and **pnpm** on your computer (`corepack enable` installs the
  right pnpm), and **Docker** wherever Ava will run.

### 1. 📦 Get the code

```bash
git clone https://github.com/franckdsf/Ava-Agent.git ava-agent
cd ava-agent
pnpm install
```

### 2. 🔑 Create an OpenRouter key

At [openrouter.ai/keys](https://openrouter.ai/keys), create a key and keep it
at hand. Add some credit on the same site, or the first model call fails.

### 3. 🤖 Create the bots in Telegram

Ava is two bots: **Newy** for news and **Joob** for jobs. Joob is optional —
skip it to run news only.

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and a
   username ending in `bot`. BotFather replies with a **token**
   (`123456:ABC…`) — that is Newy's. Do it again for Joob.
2. For **each** bot, still in @BotFather: open the mini app → your bot →
   **Bot Settings** and turn on **Threaded Mode** and **Disallow users to
   create new threads**. Without it there are no tabs, and no code can turn it
   on for you.
3. Open [@userinfobot](https://t.me/userinfobot) and send it anything. It
   replies with your **numeric id** (numbers only, not your @username) — the
   bots only ever talk to that id.

### 4. ⚙️ Write the config

```bash
pnpm setup
```

It asks for everything from steps 2 and 3, checks each token against Telegram
as you go, asks your time zone (digests arrive at 10:00 and 20:00 in it), and
writes `.env`. For Joob it also asks where to fetch your CV — that can wait.
Rerunning is safe: Enter keeps the value already there.

Then make sure Telegram agrees:

```bash
pnpm telegram:check
```

### 5. ▶️ Start it

| Where | Command |
| --- | --- |
| On this computer | `docker compose up -d --build` |
| On a server, kept up to date | see [On a server](#on-a-server) below |

Then, in Telegram, open each bot and send **`/start`** — a bot cannot message
you first. The first digest lands at the next 10:00 or 20:00.

> 👀 **Just looking?** Run `pnpm setup`, give only the OpenRouter key, answer no to
> Telegram, then `pnpm dev`: Mastra Studio opens at http://localhost:4111 and
> runs the news pipeline by hand, no bot needed.

State (dedupe history, beats, memory) lives in the `ava-data` Docker volume —
back it up.

<a id="on-a-server"></a>

### 🖥️ On a server

Any Linux box with Docker works — a small VPS is plenty, though the build wants
about 2 GB of RAM (or swap). Open no ports: everything is outbound. The server
needs git and Docker, not Node.

```bash
# on the server
git clone https://github.com/franckdsf/Ava-Agent.git ava-agent

# on your computer — the .env from step 4
scp .env server:ava-agent/

# on the server
cd ava-agent
./scripts/deploy.sh --auto weekly
```

That last command builds and starts Ava, then installs a cron job that re-runs
it every Sunday at 02:00 in your time zone: it pulls whatever was pushed,
builds before stopping anything, snapshots the volume into `backups/`,
restarts, and fails loudly if a migration didn't land. A week with nothing new
pulls nothing. `./scripts/deploy.sh` alone deploys right now without touching
the schedule; `--auto off` removes it.

Before you run it:

- **`docker ps` and `git fetch` must work without a password** for your user —
  the weekly run cannot answer a prompt. `sudo usermod -aG docker $USER` (then
  log in again) fixes the first; an SSH key or a public repo the second.
- **Stop the copy on your computer** (`docker compose down`, or `pnpm dev`) —
  two processes on one bot token eat each other's messages.
- **The server starts empty.** Copy `.data/ava.db` into the `ava-data` volume
  to keep your beats and history, or point `AVA_DATA_DB_URL` at a Turso URL
  and drop the volume.

Each run appends to `deploy.log` in the checkout. It grows slowly but without
limit — a few MB after some years — and it is safe to delete at any time.

Mastra Studio is loopback-only on a server: `ssh -L 4111:localhost:4111 server`,
then open http://localhost:4111. Several readers on one box is one Compose
project each — see the header of [docker-compose.yml](docker-compose.yml); add
`-p` and `--env-file` to the deploy command and each gets its own schedule and
`deploy-<project>.log`.

## 🧠 How it works

```
┌─ container (no inbound ports) ──────────────┐
│  Mastra          agents + workflows          │   ┌─ ava.db (libsql/Turso) ─┐
│  scheduler       native cron                  │──▶│  news / jobs / leads    │
│  Telegram        long-polling, outbound only │   │  memory, feedback       │
└──────────────────────────────────────────────┘   └─────────────────────────┘
```

In a scheduled run the model judges and writes; code decides everything
else. Ingest, dedupe, filtering, clustering and the schedule are
deterministic. A model scores a fixed batch — articles against a beat,
postings against your CV, companies against a client profile — and writes
the message for each winner. Where a model *proposes* something (a site to
follow, an employer that might be hiring), code verifies it before anything
is stored. So a scheduled job never has an LLM improvising its own control
flow. How the code is put together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Built on [Mastra](https://mastra.ai) for agents/workflows, libSQL for
storage, and `@chat-adapter/telegram` for delivery. Any model reachable
through [OpenRouter](https://openrouter.ai) works.

<a id="useful-dev-commands"></a>

## 🛠️ Useful dev commands

| Command               | What it does                                              |
| --------------------- | --------------------------------------------------------- |
| `pnpm dev`            | Mastra Studio — run workflows by hand, inspect traces     |
| `pnpm feeds:check`    | Confirm every subscribed feed is reachable                |
| `pnpm jobs:check`     | Dry-run the jobs pipeline against real sources, no writes |
| `pnpm telegram:check` | Verify both bots' profile, commands, and tabs are live    |
| `pnpm verify`         | Typecheck, rule checks, tests — what every commit runs    |

More scripts and what each proves: [docs/COMMANDS.md](docs/COMMANDS.md).

## 📚 Docs

- [AGENTS.md](AGENTS.md) — the operating contract: invariants, gotchas, and
  patterns for anyone (human or agent) working in this repo
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the code fits together: bots as data, the
  pipeline kit, and the model and data boundaries, each with the check that holds it
- [docs/decisions/](docs/decisions/README.md) — ADRs explaining why it looks
  the way it does, including the ideas that were tried and reversed

## 🚧 Status

News (ingest → rank → digest → Telegram) and jobs/leads are both running
day to day. The 👍/👎 feedback loop is half-built: the ranker reads past
votes into its prompt, but nothing records a vote yet, so it always reads an
empty list. See [AGENTS.md § Current state](AGENTS.md#current-state) for the
honest, up-to-date list of what's solid and what's known to be rough.

## 📄 License

[MIT](LICENSE) — fork it, change it, run it for yourself.
