CREATE TABLE `pipeline_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`pipeline` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`fetched` integer DEFAULT 0 NOT NULL,
	`stored` integer DEFAULT 0 NOT NULL,
	`considered` integer DEFAULT 0 NOT NULL,
	`scored` integer DEFAULT 0 NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`note` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_runs_pipeline_started` ON `pipeline_runs` (`pipeline`,`started_at`);