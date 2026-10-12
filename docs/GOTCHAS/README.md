# Gotchas

A gotcha records a surprise we did not choose and cannot decide away — usually a third party's
behaviour: SQLite, drizzle-kit, Telegram, OpenRouter, a feed, YouTube. The measurement is the part
that earns its place; a gotcha without a number, a date or a file path is just a hunch.

- A **gotcha** explains a surprise. It belongs here.
- An **ADR** (`../decisions/`) records a choice we made and the reasoning we would otherwise re-argue.
- A **Never** row in `AGENTS.md` constrains a choice with no judgement left to exercise.

Each file below declares `applies_to` globs in its frontmatter. Read the file whose globs match what
you are touching; nothing here needs reading before you know what you are editing.

| File | `applies_to` | What kind of surprise |
| --- | --- | --- |
| [runtime-and-paths.md](runtime-and-paths.md) | `src/mastra/**`, `src/config/**`, `scripts/**`, `Dockerfile`, `docker-compose.yml` | Where the process actually runs from — bundle cwd, path resolution, image build inputs, Compose env and volumes, ESM statement order. Also holds the empty-`ava-data`-volume fork, which reads like a database problem. |
| [database-and-migrations.md](database-and-migrations.md) | `src/db/**`, `drizzle/**`, `drizzle.config.ts` | drizzle-kit's diffing and prompts, SQLite's `NOT NULL` refusal, the `-wal`/`-shm` copy trap, the orphaned FTS index, backfills after a table drop, retention coupled to the age window. |
| [feeds-and-ingest.md](feeds-and-ingest.md) | `src/services/**`, `src/config/**`, `src/mastra/workflows/**` | What feeds actually serve — whole histories, hundreds of same-day arXiv papers, conditional GET hiding schema changes, images that are site banners, the text extraction that used to destroy code, clustering that is tuned rather than derived. |
| [telegram.md](telegram.md) | `src/services/**`, `src/mastra/commands/**`, `src/mastra/registrar.ts`, `src/config/**` | The Bot API and the client as they behave, not as documented: soft wraps, escape sets, tab order owned by the client, slash routing that bypasses the agent, `formatted` beating `text`, streaming off by default, two bots sharing one private `chat_id`. |
| [mastra-workflows.md](mastra-workflows.md) | `src/mastra/**`, `scripts/**` | Schedules, the workflow's own id versus its registry key, what can and cannot start a run from a script or over HTTP, the publish/consume split behind a fire, boot catch-up putting two runs in flight, and dry-run scripts drifting from the workflow they mirror. |
| [models-and-prompts.md](models-and-prompts.md) | `src/mastra/agents/**`, `src/mastra/tools/**`, `src/mastra/workflows/**`, `src/config/**` | The `openrouter/` prefix, structured output as a request rather than a guarantee, latency spread across identical calls, thinking share the rate card cannot show, prompt rules that over-apply, the memory reviewer calibrated backwards, French as a facade. |
| [search-and-discovery.md](search-and-discovery.md) | `src/services/**`, `src/mastra/tools/**`, `src/mastra/workflows/**` | Asking a model for sites rather than feed URLs, English queries out-yielding the reader's language, section pages beating front pages, `checkFeed()`'s blind spots, what a rubric does and does not name, and the search tools over the article index. |
| [jobs-and-leads.md](jobs-and-leads.md) | `src/services/job-*.ts`, `src/services/lead-*.ts`, `src/services/ats.ts`, `src/mastra/workflows/find-{jobs,leads}.ts`, `src/config/{jobs,leads}.ts` | Joob's two pipelines: a count that is really a boolean, posting identity when a board has no permalink, an ATS that looks bodyless until you pass a content parameter, and the ATS-versus-marketplace line the exclusion lists turn on. |
| [youtube.md](youtube.md) | `src/services/youtube.ts`, `src/config/youtube.ts`, `src/mastra/tools/youtube.ts` | Caption URLs that answer 200 with nothing, titles A/B tested per viewer, transcripts ten times an article's length against an article-sized cap, and the one place Newy copies text instead of writing it. |
