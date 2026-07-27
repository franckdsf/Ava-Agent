CREATE TABLE `feed_state` (
	`feed_url` text PRIMARY KEY NOT NULL,
	`etag` text,
	`last_modified` text,
	`last_fetched_at` integer,
	`last_status` text,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `feedback` (
	`item_id` text PRIMARY KEY NOT NULL,
	`category_slug` text NOT NULL,
	`vote` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_feedback_category` ON `feedback` (`category_slug`,`created_at`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`category_slug` text NOT NULL,
	`feed_url` text NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`link` text NOT NULL,
	`excerpt` text,
	`published_at` integer,
	`discovered_at` integer NOT NULL,
	`cluster_id` text,
	`score` integer,
	`subtopic` text,
	`reason` text,
	`ranked_at` integer,
	`delivered_at` integer,
	`delivery_kind` text
);
--> statement-breakpoint
CREATE INDEX `idx_items_unranked` ON `items` (`category_slug`,`ranked_at`,`discovered_at`);--> statement-breakpoint
CREATE INDEX `idx_items_undelivered` ON `items` (`category_slug`,`delivered_at`,`score`);--> statement-breakpoint
CREATE INDEX `idx_items_cluster` ON `items` (`cluster_id`);