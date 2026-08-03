CREATE TABLE `job_searches` (
	`slug` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`request` text NOT NULL,
	`locations` text NOT NULL,
	`remote` text NOT NULL,
	`seniority` text NOT NULL,
	`contract_types` text NOT NULL,
	`must_have` text NOT NULL,
	`dealbreakers` text NOT NULL,
	`min_compensation` integer,
	`currency` text,
	`notes` text,
	`fit_threshold` integer,
	`created_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_job_searches_active` ON `job_searches` (`archived_at`);