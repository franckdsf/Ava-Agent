-- Copies `job_runs` and `lead_runs` into `pipeline_runs`, before 0029 drops them.
--
-- Hand-written, like `0011_reset_feed_state.sql`, because this is a data change
-- and `db:generate` only emits schema diffs: it would create the new table and
-- drop the old two, and every run ever logged would go with them
-- ([audit D2](../docs/audit/04-BLUEPRINT.md#decisions) — keep the stats).
--
-- The five shared counters copy across by name. `vision_calls` is the one column
-- only leads has, so it moves into `detail`, the same shape the code writes.
-- Ids cannot collide: jobs used `run-<base36>`, leads a UUID.
INSERT INTO `pipeline_runs`
  (`id`, `pipeline`, `started_at`, `finished_at`, `fetched`, `stored`, `considered`, `scored`, `delivered`, `note`, `detail`)
SELECT `id`, 'jobs', `started_at`, `finished_at`, `fetched`, `stored`, `considered`, `scored`, `delivered`, `note`, NULL
FROM `job_runs`;
--> statement-breakpoint
INSERT INTO `pipeline_runs`
  (`id`, `pipeline`, `started_at`, `finished_at`, `fetched`, `stored`, `considered`, `scored`, `delivered`, `note`, `detail`)
SELECT `id`, 'leads', `started_at`, `finished_at`, `fetched`, `stored`, `considered`, `scored`, `delivered`, `note`,
  json_object('visionCalls', `vision_calls`)
FROM `lead_runs`;
