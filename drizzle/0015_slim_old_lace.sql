CREATE TABLE `job_deliveries` (
	`identity` text PRIMARY KEY NOT NULL,
	`company` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`search_slug` text NOT NULL,
	`delivered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_matches` (
	`job_id` text NOT NULL,
	`search_slug` text NOT NULL,
	`fit` integer,
	`reason` text,
	`mismatches` text,
	`scored_at` integer,
	PRIMARY KEY(`job_id`, `search_slug`)
);
--> statement-breakpoint
CREATE INDEX `idx_job_matches_unscored` ON `job_matches` (`search_slug`,`scored_at`);--> statement-breakpoint
CREATE INDEX `idx_job_matches_fit` ON `job_matches` (`search_slug`,`fit`);--> statement-breakpoint
CREATE TABLE `job_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`label` text NOT NULL,
	`adapter` text,
	`added_at` integer NOT NULL,
	`archived_at` integer,
	`etag` text,
	`last_modified` text,
	`last_fetched_at` integer,
	`last_status` text,
	`last_error` text,
	`last_count` integer
);
--> statement-breakpoint
CREATE INDEX `idx_job_sources_active` ON `job_sources` (`archived_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`identity` text NOT NULL,
	`source_id` text NOT NULL,
	`company` text NOT NULL,
	`title` text NOT NULL,
	`location` text,
	`remote` text NOT NULL,
	`url` text NOT NULL,
	`description` text,
	`salary_text` text,
	`contract_type` text,
	`tags` text NOT NULL,
	`derived_tags` text NOT NULL,
	`posted_at` integer,
	`discovered_at` integer NOT NULL,
	`delivered_at` integer,
	`delivered_search` text
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_undelivered` ON `jobs` (`delivered_at`,`discovered_at`);--> statement-breakpoint
CREATE INDEX `idx_jobs_identity` ON `jobs` (`identity`);