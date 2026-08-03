PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_telegram_topics` (
	`bot_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`slug` text NOT NULL,
	`message_thread_id` integer NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`bot_id`, `chat_id`, `slug`)
);
--> statement-breakpoint
INSERT INTO `__new_telegram_topics`("bot_id", "chat_id", "slug", "message_thread_id", "name", "created_at") SELECT 'newy', "chat_id", "slug", "message_thread_id", "name", "created_at" FROM `telegram_topics`;--> statement-breakpoint
DROP TABLE `telegram_topics`;--> statement-breakpoint
ALTER TABLE `__new_telegram_topics` RENAME TO `telegram_topics`;--> statement-breakpoint
PRAGMA foreign_keys=ON;