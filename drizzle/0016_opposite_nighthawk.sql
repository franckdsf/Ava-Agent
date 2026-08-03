CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`fetched` integer DEFAULT 0 NOT NULL,
	`stored` integer DEFAULT 0 NOT NULL,
	`considered` integer DEFAULT 0 NOT NULL,
	`scored` integer DEFAULT 0 NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `idx_job_runs_started` ON `job_runs` (`started_at`);