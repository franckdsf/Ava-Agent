CREATE TABLE `article_beats` (
	`article_id` text NOT NULL,
	`beat_slug` text NOT NULL,
	`cluster_id` text,
	`score` integer,
	`subtopic` text,
	`reason` text,
	`ranked_at` integer,
	PRIMARY KEY(`article_id`, `beat_slug`)
);
--> statement-breakpoint
CREATE INDEX `idx_article_beats_unranked` ON `article_beats` (`beat_slug`,`ranked_at`);--> statement-breakpoint
CREATE INDEX `idx_article_beats_score` ON `article_beats` (`beat_slug`,`score`);--> statement-breakpoint
CREATE INDEX `idx_article_beats_cluster` ON `article_beats` (`beat_slug`,`cluster_id`);--> statement-breakpoint
CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`feed_url` text NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`link` text NOT NULL,
	`excerpt` text,
	`content` text,
	`image_url` text,
	`published_at` integer,
	`discovered_at` integer NOT NULL,
	`delivered_at` integer,
	`delivered_beat` text,
	`delivery_kind` text
);
--> statement-breakpoint
CREATE INDEX `idx_articles_undelivered` ON `articles` (`delivered_at`,`discovered_at`);--> statement-breakpoint
CREATE INDEX `idx_articles_feed_image` ON `articles` (`feed_url`,`image_url`);--> statement-breakpoint
CREATE TABLE `beat_feeds` (
	`beat_slug` text NOT NULL,
	`feed_url` text NOT NULL,
	`source` text NOT NULL,
	`subtopic` text,
	`added_at` integer NOT NULL,
	`archived_at` integer,
	PRIMARY KEY(`beat_slug`, `feed_url`)
);
--> statement-breakpoint
CREATE INDEX `idx_beat_feeds_url` ON `beat_feeds` (`feed_url`);--> statement-breakpoint
CREATE TABLE `beats` (
	`slug` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`emoji` text NOT NULL,
	`rubric` text NOT NULL,
	`subtopics` text NOT NULL,
	`digest_threshold` integer,
	`max_items_per_digest` integer,
	`created_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_beats_active` ON `beats` (`archived_at`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`article_id` text PRIMARY KEY NOT NULL,
	`beat_slug` text NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`vote` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_feedback_beat` ON `feedback` (`beat_slug`,`created_at`);