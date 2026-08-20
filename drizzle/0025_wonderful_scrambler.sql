CREATE TABLE `client_profiles` (
	`slug` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`request` text NOT NULL,
	`offer` text NOT NULL,
	`industries` text NOT NULL,
	`locations` text NOT NULL,
	`signal_kinds` text NOT NULL,
	`dealbreakers` text NOT NULL,
	`min_deal_size` integer,
	`currency` text,
	`notes` text,
	`fit_threshold` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_client_profiles_active` ON `client_profiles` (`archived_at`);--> statement-breakpoint
CREATE TABLE `lead_deliveries` (
	`lead_id` text NOT NULL,
	`signal_id` text NOT NULL,
	`company` text NOT NULL,
	`url` text NOT NULL,
	`profile_slug` text NOT NULL,
	`signal_kind` text NOT NULL,
	`delivered_at` integer NOT NULL,
	PRIMARY KEY(`lead_id`, `signal_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_lead_deliveries_lead` ON `lead_deliveries` (`lead_id`,`delivered_at`);--> statement-breakpoint
CREATE TABLE `lead_matches` (
	`lead_id` text NOT NULL,
	`signal_id` text NOT NULL,
	`profile_slug` text NOT NULL,
	`fit` integer,
	`reason` text,
	`mismatches` text,
	`angle` text,
	`scored_at` integer,
	PRIMARY KEY(`lead_id`, `signal_id`, `profile_slug`)
);
--> statement-breakpoint
CREATE INDEX `idx_lead_matches_unscored` ON `lead_matches` (`profile_slug`,`scored_at`);--> statement-breakpoint
CREATE INDEX `idx_lead_matches_fit` ON `lead_matches` (`profile_slug`,`fit`);--> statement-breakpoint
CREATE TABLE `lead_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`fetched` integer DEFAULT 0 NOT NULL,
	`stored` integer DEFAULT 0 NOT NULL,
	`considered` integer DEFAULT 0 NOT NULL,
	`scored` integer DEFAULT 0 NOT NULL,
	`vision_calls` integer DEFAULT 0 NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `idx_lead_runs_started` ON `lead_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `lead_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_url` text NOT NULL,
	`origin` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`summary` text NOT NULL,
	`discovered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_lead_signals_lead` ON `lead_signals` (`lead_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_lead_signals_recent` ON `lead_signals` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`company` text NOT NULL,
	`location` text,
	`url` text NOT NULL,
	`page_text` text,
	`page_fetched_at` integer,
	`vision_verdict` text,
	`vision_at` integer,
	`discovered_at` integer NOT NULL,
	`last_signal_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_leads_last_signal` ON `leads` (`last_signal_at`);