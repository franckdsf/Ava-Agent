---
id: 0041
applies_to: ["**"]
status: accepted
supersedes: ["0023"]
---

# ADR-0041: One deployment, one reader — and a `.env` that says only who they are

- **Status:** Accepted
- **Date:** 2026-08-23
- **Amends:** [ADR-0023](0023-a-bot-per-agent-two-tokens-two-chats.md), whose
  decision — a token per agent — is untouched. Only its *variables* change: the
  three-per-bot set becomes one token per bot plus one shared reader id.
- **Bears on:** [ADR-0001](0001-mastra-in-a-container-with-no-inbound-ports.md).
  Several containers on one host is still no inbound ports; the only thing they
  contend for is a loopback port for Studio.

## Context

This repo was built for one person, and the environment was written the way a
one-person environment is: whatever was being tuned that week got a variable.
That was correct while there was one deployment. It stops being correct the
moment the answer to *"can someone else run this?"* has to be yes.

Two problems, and they are different in kind.

**One: the identity variables say the same number four times.** ADR-0023 gave
each bot three variables — token, allowlist, chat id. The allowlist and the chat
id were split "on purpose: that one says who may talk, this says where a cron
fire should send". True as a distinction, and false as a *configuration*: in a
private chat Telegram's `chat_id` **is** the user id, and user ids are global
rather than per-bot. So the file asked four times for one number, with a comment
under each one explaining that it was the same number as the others. Checked in
the live `.env` before this change: `NEWY_TELEGRAM_ALLOWED_USER_IDS`,
`NEWY_TELEGRAM_CHAT_ID`, `JOOB_TELEGRAM_ALLOWED_USER_IDS` and
`JOOB_TELEGRAM_CHAT_ID` held one identical 10-digit id.

Four fields for one fact is not verbosity, it is four chances to typo per
deployment, and three of the four fail *silently*: a wrong allowlist entry makes
the bot ignore its owner, and a wrong chat id sends the digest nowhere.

**Two: the models were in the environment, and the reasoning was not.** Fifteen
`AVA_MODEL_*` lines in `.env.example`, each with a paragraph restating —
approximately, and by hand — the argument written in `src/config/env.ts` beside
the default. Every one of them already *had* a working default in code. The file
was overriding those defaults with copies of themselves.

Fifteen, against **seventeen** in `env.ts`: `AVA_MODEL_JOB_SCORER` and
`AVA_MODEL_JOB_WRITER` were never added to the example at all. Nobody noticed,
because nothing depended on them being there — which is the argument in
miniature.

That is worse than redundant once there is more than one deployment. A `.env` is
copied at deployment time and then never revisited; the code is what gets
updated. So an id copied in January is what a reader is still being served by in
June, and the measurement that superseded it lives in a file that deployment
does not read. **This had already happened here**: `.env` pointed
`AVA_MODEL_MEMORY_REVIEWER` at `deepseek-v4-pro` while the default in code — and
the comment justifying it — still said `flash`. The running system and the
documented system had quietly disagreed for months, and nothing could have
reported it, because the disagreement *was* the configuration.

## Decision

**A `.env` may only contain what is true of one reader or one machine.**
Everything a measurement chose lives in code.

Three consequences follow.

**1. One identity variable: `AVA_TELEGRAM_USER_ID`.** The reader's numeric
Telegram id, `AVA_`-prefixed because it belongs to the system rather than to any
one agent. It is the allowlist for every bot and, being a DM, the chat every bot
pushes to. Four variables become one; two bots keep their own tokens, which is
all ADR-0023 ever required.

It is validated as `^\d+$` rather than as a non-empty string. The wrong thing to
paste there is an `@username`, which is otherwise accepted here and rejected four
layers down as "chat not found".

**2. `<PREFIX>TELEGRAM_CHAT_ID` survives as an override, and only as one.**
Unset in an ordinary deployment. The supergroup-forum route is a real deployment
of this bot, and a group's `-100…` id is nobody's user id — it is the one value
that genuinely cannot be derived, so it is the one that stays typeable.

**3. No model in `.env`.** All seventeen are listed commented out in `.env.example`
under a note saying where the real ones are. `AVA_MODEL_MEMORY_REVIEWER`'s
default is corrected to `deepseek-v4-pro` — the running system wins the
disagreement it was having with the comment, and the comment now records why.

Two smaller changes fall out of the same rule, both about what a stranger has to
find before the thing boots:

- **`REPLICATE_API_KEY` is optional.** It buys exactly one tool — Newy's
  `generateImage`, the only call in this repo that does not go through
  OpenRouter. Without it `imageTools` is now empty and Newy is built without the
  tool, rather than with a tool that fails when asked. `OPENROUTER_API_KEY` is
  the only key a deployment must have.
- **An empty variable is an unset variable.** `dotenv` reads `FOO=` as `''`,
  which is *present* to zod — so `.default()` never fired and `.optional()` never
  applied, and `# FOO=` behaved differently from `FOO=` for no guessable reason.
  `parse()` strips empties first, which is what lets `.env.example` ship a key
  with nothing after the `=`.

**Deployment is a Compose project per reader**, off one file and one image:

```
docker compose -p ava-alice --env-file deploy/alice.env up -d --build
docker compose -p ava-bob   --env-file deploy/bob.env   up -d
```

`-p` gives each its own volume and container names; `image: ava-agent:latest`
means one build serves all of them. `env_file:` is gone from
`docker-compose.yml` in favour of an explicit `environment:` block, because
`env_file` resolves against the *compose file* while `--env-file` feeds only
interpolation — so the second deployment would have booted with the first one's
`.env` and answered the first one's reader. The host port is
`${AVA_HOST_PORT:-4111}`, the only thing two deployments on one box contend for.

## Cost

**The allowlist can no longer hold more than one person.** It was
comma-separated and now is not. This is the real loss, and it is deliberate:
sharing a bot between two people was never a supported shape — one `memories`
table, one CV, one set of beats, one `/client` profile, all keyed to nobody —
and pretending otherwise in the one variable that gates *access* was the wrong
place to keep the option open. A second person is a second project. If a shared
bot ever becomes a real requirement, it needs a reader dimension in the schema
first, and this variable is then the smallest part of that work.

**The explicit `environment:` block in Compose can drift.** Adding an env var
now means editing two files, and forgetting the second means a container that
boots without it. The failure is loud — zod names the missing variable at
startup — and the environment is now deliberately small and slow-moving, which
is what makes the trade acceptable. It was not acceptable when the file had
fifteen model variables in it, which is part of why they left.

**An existing deployment must edit its `.env` before it restarts.** Nothing is
read under the old names, and the old names are not tolerated as a fallback — a
silent fallback for a variable that decides *who may talk to your bot* is worse
than a startup error. Four lines out, one line in:

```
-NEWY_TELEGRAM_ALLOWED_USER_IDS=123456789
-NEWY_TELEGRAM_CHAT_ID=123456789
-JOOB_TELEGRAM_ALLOWED_USER_IDS=123456789
-JOOB_TELEGRAM_CHAT_ID=123456789
+AVA_TELEGRAM_USER_ID=123456789
```

**A per-reader model override is now a worse experience than it was**, since it
means uncommenting a line in a file that says not to. That is the intended
pressure: a model that is better for one reader is nearly always just better, and
belongs in `env.ts` with the measurement that showed it.

## Verified

`pnpm telegram:check`, live against both bots after the merge, 2026-08-23: Newy
and Joob each resolved chat `8401775038 (private)` from the single
`AVA_TELEGRAM_USER_ID`, reported Threaded Mode on via `private-threaded-mode`,
found all six existing tabs (`💬 Chat`, `📰 News`, `📜 Translations`;
`💬 Chat`, `💼 Jobs`, `🎯 Leads`) and reported both profiles up to date — so the
next boot pushes nothing. `docker compose -p ava-test config` resolves every
variable, defaults the two chat overrides to empty, and names the volume
`ava-test_ava-data`.
