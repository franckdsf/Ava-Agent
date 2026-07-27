CREATE TABLE `telegram_topics` (
	`chat_id` text NOT NULL,
	`slug` text NOT NULL,
	`message_thread_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `slug`)
);
