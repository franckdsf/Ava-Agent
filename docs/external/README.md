# External

Everything true about this project that does **not** live in the repository.

Where it runs, which accounts own it, which third parties it depends on, which settings exist only
in someone else's UI. The code answers "how does this work"; nothing in the repo answers "where does
this run and who owns it" — and that gap is a question an agent has to stop and ask a human, every
time.

---

## The rule

**Names and locations, never values.** A Compose project name, a volume name, a variable name, a
provider, an account owner, a dashboard URL — all fine. A key, a token, a bot token, a numeric
Telegram id, a portfolio URL — never, in any form, including "shortened" or "example" ones.

Secrets are set per deployment and only their *names* are documented, in `.env.example`. That file
is the pattern this folder follows: it ships every variable with nothing after the `=`.

If a fact would let someone act without asking, it belongs here. If it would let someone act without
*authorisation*, it does not.

---

## How it grows

This folder is deliberately small and starts almost empty. **Add a fact the moment it becomes true**
— the first host it is deployed on, the first second reader, the first paid provider — rather than
reconstructing six services from memory later.

The trigger is concrete: **when an agent asks you where something lives, the answer goes here, not
only into the reply.** That is the same question being asked twice otherwise.

One file per surface once a surface earns one (`deployments.md`, `telegram.md`, `accounts.md`).
Until then, facts live in this README. A folder of six files that each say "not yet" is the dead
documentation this project exists to avoid.

---

## What is true today

### Deployment

Docker, one long-running container, no inbound ports (invariant 1 ·
[ADR-0001](../decisions/0001-mastra-in-a-container-with-no-inbound-ports.md)). Telegram is
long-polled and models are called outbound, so nothing has to reach the container from the network.

**One deployment serves one reader** ([ADR-0041](../decisions/0041-one-deployment-one-reader.md)).
Several readers means several *Compose projects* off the one `docker-compose.yml` and the one image:

| | |
| --- | --- |
| Compose service | `ava` |
| Image | `ava-agent:latest` — built once, reused by every project |
| Project naming | `docker compose -p ava-<reader> --env-file deploy/<reader>.env up -d` |
| Container | `<project>-ava-1` |
| Named volume | `ava-data`, mounted at `/data` → `<project>_ava-data` per project |
| Files in the volume | `ava.db` (app + Mastra tables), `traces.db` (disposable, dev-time) |
| Migrations in the image | `/app/drizzle`, copied out of the build stage |
| Published port | `127.0.0.1:${AVA_HOST_PORT}:4111` — loopback only, for Studio, never inbound traffic |

`-p` is the whole isolation mechanism: it renames the volume and the container. Nothing is shared
between two deployments except the image. `AVA_HOST_PORT` is the one thing two deployments on one
box collide over, and the second `up` fails outright on a taken port.

**Env files are per reader and live outside this repo.** `docker-compose.yml` lists every variable
in an explicit `environment:` block rather than using `env_file:`, so `--env-file` alone decides
which reader a container serves. `deploy/<reader>.env` is the convention the ADR and the compose
header both use; that directory is not in the repository and must not be.

**Updating a deployment** is `./scripts/deploy.sh` on the host (`-p` / `--env-file` for a named
project). It refuses a dirty tree, builds before stopping anything, snapshots the volume to
`backups/<volume>-<timestamp>.tar.gz` on the host — keeping the last 7, excluding `traces.db*` —
and then waits until the number of applied migrations matches the number shipped. Migrations
themselves are applied lazily at boot by `migrate()` in `src/db/client.ts`, not by the script.

**`--auto weekly`** installs, after a successful deploy, one crontab line per Compose project that
re-runs the script Sundays at 02:00 `AGENT_TIMEZONE` — converted to the server's zone at install,
since cron fires in the server's — into `deploy[-<project>].log` (gitignored by `*.log`; safe to
delete). The line is tagged `# ava-deploy:<project>`, so a re-run replaces it and `--auto off`
removes only it. 02:00 clears every in-app schedule — the 04:00 prune, the Monday 05:00/06:00
reviews, the pipelines from 08:00 — because a restart mid-run cuts that run short. A cron run
cannot answer a git prompt, so the script disables them when stdin is not a terminal, and an
`flock` on `.git/deploy.lock` keeps a hand run and a cron run from overlapping.

A deployment can also run **stateless**: point `AVA_DATA_DB_URL` at a `libsql://` (Turso) URL and
there is no volume at all. `deploy.sh` detects this and reports the migration count as unchecked
rather than as passing.

### Telegram — two bots, and one setting no code can reach

Two @BotFather bots, one per agent, each with its own token
([ADR-0023](../decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)). Two adapters sharing a
token share a `getUpdates` offset and eat each other's messages, so these are always two distinct
bots, never one token twice.

| Agent | Traffic | Token variable | Tabs |
| --- | --- | --- | --- |
| **Newy** | News | `NEWY_TELEGRAM_BOT_TOKEN` | 💬 Chat · 📰 News · 📜 Translations |
| **Joob** | Jobs and leads | `JOOB_TELEGRAM_BOT_TOKEN` (optional) | 💬 Chat · 💼 Jobs · 🎯 Leads |

**Threaded Mode is a manual @BotFather toggle and no API can set it.** It is per bot, so a new bot
needs its own: *Bot Settings → Threads Settings → Threaded Mode*. Without it there are no tabs, and
the failure looks like a code bug. `pnpm telegram:check` reports it for every bot — that is the
first thing to run when a tab is missing.

The reader's numeric Telegram id (`AVA_TELEGRAM_USER_ID`) is both the allowlist and, being a DM, the
chat every bot pushes to. It is a value: it lives in the deployment's env file and nowhere in this
repo.

### Third parties this depends on

| Surface | What it is | Failure shape |
| --- | --- | --- |
| **OpenRouter** | The model gateway for every model call. One key, `OPENROUTER_API_KEY` — the only key a deployment must have. Model ids are validated to start with `openrouter/`; a bare `<provider>/<model>` routes direct and needs that provider's own key | Boot fails loudly if the key is missing |
| **Replicate** | Optional, and the only optional key. Buys exactly one thing: Newy's `generateImage` tool. Without `REPLICATE_API_KEY` the tool is not built at all | Absent rather than broken |
| **Portfolio endpoint** | `PORTFOLIO_FEED_URL` — the CV Joob scores every posting against and the portfolio the leads pipeline pitches. Lives outside this repo, is fetched fresh each run and cached nowhere. Must answer `text/markdown` or `text/plain`; optional bearer token | **Never errors when wrong** — a protection wall answers 200 with an HTML login page. `pnpm portfolio:check` is the only way to see what actually came back |
| **Telegram Bot API** | Long-polled outbound | — |
| **RSS/Atom feeds and job boards** | Rows in the database, not code (invariant 3). Which ones a deployment follows is per reader, in its own volume | — |
| **YouTube captions** | `youtube-caption-extractor` scrapes a third party behind anti-bot measures that move. When they move, every video fails at once | `pnpm youtube:check` first, then `pnpm update youtube-caption-extractor` |

Models are chosen in `src/config/env.ts` with the measurement that chose them written beside each
one — **never in an env file** (ADR-0041). That is a repo fact, restated here because "which model
is production on" is exactly the question people expect this folder to answer, and the answer is
"read the code, not the deployment".

---

## Not yet recorded

Listed so the absence reads as *not yet* rather than *forgotten*:

- The host(s) these containers actually run on — provider, name, who has access
- Which Compose project names are live, and which reader each serves
- Where `deploy/*.env` files are kept and how a new one is provisioned
- Whether host backups (`backups/*.tar.gz`) are copied anywhere off the box
- The OpenRouter account owner, its spend cap, and where its dashboard is
- The Replicate account owner, where one exists
- Where the portfolio endpoint is hosted and who can change what it serves
- The two bots' @usernames and which Telegram account owns them
- Any monitoring or alerting — today the only signal a deployment is unhealthy is silence in a chat
