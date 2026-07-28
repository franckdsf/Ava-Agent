CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`tier` text NOT NULL,
	`fact` text NOT NULL,
	`happened_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_memories_tier` ON `memories` (`tier`,`happened_at`);