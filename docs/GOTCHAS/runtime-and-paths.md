---
applies_to: ["src/mastra/**", "src/config/**", "scripts/**", "Dockerfile", "docker-compose.yml"]
---

# Runtime and paths

Gotchas. The routing table is [README.md](README.md).

- **No relative path may be resolved against cwd.** `mastra dev` runs the bundle
  from `.mastra/.build`, `mastra build` from `.mastra/output` — neither is the
  project root. This has bitten twice: stray databases under
  `src/mastra/public/`, then `AVA_MIGRATIONS_DIR=drizzle` failing with "Can't
  find meta/_journal.json". Anchor every path with `resolveFromRoot()` in
  `src/lib/project-root.ts` (database URLs go through `resolveDbUrl()`, which
  wraps it). Absolute paths pass through untouched, which is what Docker sets.

- **`pnpm-workspace.yaml` is a build input, and the Dockerfile has to copy it.**
  pnpm 10+ refuses to run a dependency's install script unless it is approved in
  that file, and it **errors** rather than warning — `ERR_PNPM_IGNORED_BUILDS`,
  exit 1. The only entry here is `esbuild`, whose postinstall fetches the native
  binary `mastra build` needs, so the file is not optional decoration. The
  Dockerfile copied `package.json` and `pnpm-lock.yaml` into the install layer
  and nothing else, which meant **`docker compose up --build` had never worked**;
  found 2026-07-30 by running it. Anything else that install reads belongs in
  that same `COPY`, before `pnpm install`, not with the source afterwards.

- **Pin `packageManager`, or corepack picks the pnpm of the day.** With no pin,
  `corepack enable` fetched **11.18.0** into the image against a lockfile written
  by **11.0.3** — same major by luck, and the next major would arrive just as
  quietly. `package.json` now pins it and the Dockerfile sets
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, since the download is not a decision
  anyone is present to make.

- **`env_file:` is the wrong tool for a deployment per reader, and it was hiding
  a path bug before that.** Two separate reasons, a month apart, and both end at
  the explicit `environment:` block `docker-compose.yml` now uses.
  1. **Paths.** `.env` is written for the dev machine — copying `.env.example`
     verbatim used to bring `AVA_MIGRATIONS_DIR=drizzle` with it — so the path
     variables are set in compose, not passed through. The relative value does
     resolve in the container (the bundle ships a package.json for
     `resolveFromRoot()` to anchor on), but leaning on that walk is how "Can't
     find meta/_journal.json" happened the first time.
  2. **Whose deployment it is.** `env_file:` resolves against the *compose file*
     while `--env-file` feeds only interpolation — so
     `docker compose -p ava-bob --env-file deploy/bob.env up` would have loaded
     Alice's `.env` into Bob's container and answered Alice's reader with Bob's
     bot ([ADR-0041](../decisions/0041-one-deployment-one-reader.md)). The cost
     of the explicit block is drift: **a new env var means editing two files**,
     and the second one is easy to forget. It fails loudly — zod names the
     missing variable at boot — which is the whole reason it is tolerable.

- **An empty `ava-data` volume against a chat you already use is not a clean
  start — it is a fork.** The container's database has no `telegram_topics`, and
  the persisted id is the only authority on whether a tab exists, so
  `resolveTopics()` creates a **second** Chat, News and Translations in the same
  chat; `createForumTopic` is not idempotent and `deleteForumTopic` is not wired,
  so that cleanup is manual. It also re-seeds `beats` from
  `src/config/seed-beats.ts` — losing every beat made with `/follow`, which lives
  nowhere else — and empties `feed_state`, so the next digest re-ingests
  everything and re-delivers read news. Seed the volume from `.data/` first
  (procedure in the [README](../../README.md#moving-an-existing-database-into-the-volume)).
  Checked 2026-07-30 against a seeded volume: 3 beats including `formula-1`, 967
  articles, all 5 topic rows, clean FTS `integrity-check`.

- **A statement above an `import` does not run first, and two scripts here are
  written as if it does.** ESM hoists every `import` above all top-level
  statements, so `process.env.X = …` or `delete process.env.X` written at the top
  of a script executes *after* the imported modules have already loaded and read
  their config. Proven with a probe: a variable set on line 1 reads `undefined`
  inside the module imported on line 3, and a deleted one reads its old value.
  **This cost a live database write on 2026-08-05** — a verification script set
  `AVA_DATA_DB_URL` to a copy above its imports, `env.ts` parsed the default
  first, and migration `0018` applied to `.data/ava.db` instead of the copy. No
  data was lost and the migration was the intended one, but it landed on
  production by accident. `check-discovery.ts` and `check-sonar.ts` both use the
  `delete process.env.*_TELEGRAM_BOT_TOKEN` form and it is equally ineffective;
  invariant 7 survives there only because neither import graph reaches an agent
  that polls — `telegram.ts` is outbound-only and builds its adapter lazily. Do
  not add an import to those scripts without checking that. **The reliable way to
  point a script at another database is the command line**
  (`AVA_DATA_DB_URL=… tsx …`), not an assignment in the file. To exercise a
  migration against a copy, verify with a *fresh connection in a separate process*
  — a client opened before the migration ran reported the stale row count and
  hid the problem for two steps.

- **`.history/` must stay gitignored.** An IDE extension snapshots `.env`
  verbatim into it.
