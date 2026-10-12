---
applies_to: ["src/mastra/**", "scripts/**"]
---

# Mastra workflows

Gotchas. The routing table is [README.md](README.md).

- **A workflow *can* be started from a slash handler — verified 2026-07-29.**
  The gotcha below is about a *script*, and it was read for a while as "nothing
  can start a workflow but a schedule". `mastra.getWorkflow('discoverFeeds')
  .createRun()` then an un-awaited `run.start()` works from inside
  `sdk.onSlashCommand`, because the handler runs in the Mastra server and the
  server owns the pubsub loop the evented engine needs. `/follow` does this and
  both its messages arrived. Don't await it — `start()` resolves when the
  *workflow* finishes, minutes later, and the acknowledgement has to go out
  first.

- **A dry-run script that rebuilds the workflow's own mapping will drift from
  it.** `check-discovery.ts` had its own copy of the result mapping for one
  commit, and the copy skipped `sourceLabel` — so the dry run showed a
  47-character source name the real run would never produce. `describeSite` is
  exported for this reason; import it rather than re-deriving it.

- **A workflow written for one caller lies to the second one.** `discoverFeeds`
  had exactly one caller — `/follow`, on a brand-new beat — and its report read
  `results` for "feeds attached" and the run's `activate` flag for "is it
  running". Both are correct only on that path. The weekly review's top-up is the
  second caller: it runs on a beat *already near* `maxFeedsPerBeat`, so `attach`
  keeps the first few and the report named every feed it had found, including the
  ones it dropped on the floor; and it passes `activate: false` so as not to
  un-pause anything, which made the report tell the owner of a **running** beat it
  was paused. Neither was visible from `/follow`, where room is always 8 and
  `activate` is always true. The fix is the shape to copy: `attach` now emits
  `attachedFeeds` — what it actually wrote — and the report reads the beat's own
  `archivedAt` rather than the caller's intent. **A step that reports on itself
  must return what it did, not the inputs a caller can re-interpret.**

- **A workflow *can* be triggered from a terminal — over HTTP, not from a script.
  Verified 2026-07-30.** The gotcha below is about `run.start()` in-process, and
  it was read for a long time as "Studio is the only way", which is false and
  costs an agent a browser it does not have. `POST` to the running dev server
  instead; it owns the pubsub loop, so the evented engine is satisfied.
  **`pnpm workflow:run` now wraps all four of the traps below** — reach for it
  first, and read this only when it is the script itself that needs changing:

  ```powershell
  Invoke-RestMethod -Uri "http://localhost:4111/api/workflows/curateAll/start-async" `
    -Method Post -ContentType "application/json" `
    -Body '{"inputData":{},"initialState":{"feedsFetched":0,"discovered":0,"linked":0,"feedErrors":[]}}'
  ```

  Four things bite, in the order they bit:

  - **`npx mastra api workflow run start curateAll '{"inputData":{}}'` fails with
    `INVALID_JSON` under PowerShell.** PowerShell strips the inner double quotes
    passing the argument to a native exe. Use `Invoke-RestMethod`, or the `--%`
    stop-parsing token. The CLI is still the way to *discover* the contract:
    `npx mastra api workflow run start --schema` prints the route and body shape.
  - **The route needs the `/api` prefix.** `api-schema` reports the path as
    `/workflows/:workflowId/start-async`; the server mounts it under `/api`, and
    without the prefix it is a bare 404 with no hint.
  - **`initialState` is required and is not defaulted.** `curateAll` declares a
    `stateSchema` whose four fields have no defaults, so an empty body is a 500
    listing them — `feedsFetched: expected number, received undefined`. Studio
    fills this in from the schema, which is why it never comes up there.
  - **A 504 does not stop the run.** `start-async` waits for completion and the
    server's gateway timeout fires first on anything long; the workflow carries
    on regardless. Deliveries here landed up to 6 minutes *after* the 504.
    **Never retry on a 504** — poll
    `GET /api/workflows/:id/runs/:runId` for `status`, or read the database.
    Re-firing is how two runs end up delivering at once.

- **A workflow can't be run by `run.start()` in a plain script — but it can be started, two other
  ways.** Read the whole of this entry before concluding anything is impossible: the blunt version
  of this claim has already been misread twice, once as "nothing but a schedule can start a
  workflow" and once as "Studio is the only way", and both readings are false. The two entries
  **above** — the slash handler and the HTTP route — are the corrections, and they are the reason
  this one is phrased as a limit on `run.start()` rather than on workflows.
  `createRun()` resolves fine
  and `run.start()` then hangs forever with "unsettled top-level await" —
  schedules are "only supported on the evented engine", and the evented engine
  needs the pubsub loop the Mastra server owns. Nothing is wrong with the
  workflow when this happens. Test a *step's* logic by calling the functions it
  calls (that is how retention was verified, against a copy of the database), and
  test the *workflow* with `pnpm workflow:run <target>` against a running `pnpm dev`, which wraps
  all four of the traps in this file. `mastra.listWorkflows()` and
  `workflow.getScheduleConfigs()` do work in a script, which is enough to prove
  registration and fire times.
  **And the hang is not the whole cost:** a script that imports `src/mastra/index.ts` constructs
  **both** agents' polling adapters, so an orphaned run keeps polling both bots until it is killed
  by PID — eating the live bots' updates, and breaking invariant 7 for as long as it lives. A
  step-level script imports the agent module directly (`agents/job-scorer.js`), never the Mastra
  instance.

- **A schedule row is keyed by the workflow's own id, not the key it is
  registered under — and it can be read from a script.** `curateAll` is
  registered in `index.ts` under `curateAll` and declares
  `createWorkflow({ id: 'curate-all' })`; the persisted rows are
  `wf_curate-all__digest` (one row carrying every digest hour), whose `target.workflowId` is
  `curate-all`. Every lookup — `mastra.schedules.list({ workflowId })`,
  `mastra.schedules.run(id)` — takes the kebab-case one, and the registry key
  silently matches nothing: no error, an empty list, and a caller that concludes
  there are no schedules. Read `workflow.id` rather than spelling either by hand.
  Unlike *running* a workflow, *reading* the rows needs no server —
  `storage.getStore('schedules')` then `listSchedules({ workflowId })` works in a
  plain script, which is how `pnpm catchup:check` reports real fire times without
  booting the bots. Verified 2026-08-04 against a copy of the live database.

- **Firing a schedule publishes an event; a *different* worker runs it.** The
  scheduler's tick only claims a due row and publishes `workflow.start` — the
  orchestration worker consumes it. Both are started by the server's
  `startWorkers()`, which happens *after* `src/mastra/index.ts` is evaluated, so
  anything firing a run at module load must wait for
  `mastra.getWorker('orchestration')?.isRunning`. Publishing into a pubsub nobody
  has subscribed to yet is dropped with no error, and the trigger row still says
  `published` — a silent failure that looks exactly like success. `catchUpOnBoot`
  waits for that worker for this reason
  ([ADR-0025](../decisions/0025-a-boot-catch-up-for-a-stale-pipeline.md)).

- **The scheduler replays missed fires on boot, and it will put two runs of one
  workflow in flight.** [ADR-0025](../decisions/0025-a-boot-catch-up-for-a-stale-pipeline.md)
  states that Mastra deliberately does not do cron catch-up on resume. **It
  does** — one missed occurrence per schedule row, fired in the boot's own tick.
  Measured 2026-08-16: a container off since the 14th came back at 13:21 and four
  overdue schedules fired at once, **both digest schedules among them**, 146 ms
  apart, so two `curate-all` runs ingested, ranked and delivered over the same
  articles and the reader got the digest twice. The boot catch-up in
  `src/mastra/boot-catchup.ts` is *not* this mechanism and was correct to stand
  down (news 1.7 days stale against a seven-day bar) — do not start debugging
  there, read `mastra_schedule_triggers` instead, where a replay is a row whose
  `scheduled_fire_at` is days older than its `actual_fire_at`. The consequence
  for any new code: **anything that must happen once per row has to be claimed in
  the database, not recorded after the fact** — a guard evaluated after the side
  effect protects the row and nothing else
  ([ADR-0033](../decisions/0033-a-delivery-is-claimed-before-it-is-sent.md)).
  Every pipeline now claims its cycle in one guarded write before doing any
  work, through the kit (`pipeline_cycles`, [ADR-0034](../decisions/0034-a-pipeline-claims-its-cycle.md)),
  and each declares one schedule row whose cron carries every fire hour — so a
  boot replays a pipeline once, not once per hour.
  **`find-jobs` was believed to be safe here and was not** — its gate read
  `job_runs.startedAt` and inserted the next run several awaits later, which is
  the same read-then-write shape and passes two simultaneous fires. Two layers
  now, and they answer different questions: the cycle claim stops the second run
  *spending*, the delivery claim stops the reader *seeing* a story twice. Keep
  both — the delivery claim is the one that still covers a hand-fired
  `workflow:run --force` or a 504 retry, which no gate can.
