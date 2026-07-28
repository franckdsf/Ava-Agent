-- Denormalize the article's title and source onto the vote, so a vote outlives
-- the item it was cast on (items are pruned at `retentionDays`, votes are not).
--
-- Hand-edited away from what drizzle-kit generated, which was:
--
--   ALTER TABLE `feedback` ADD `title` text NOT NULL;
--   ALTER TABLE `feedback` ADD `source` text NOT NULL;
--
-- That applies today and only today: SQLite refuses `ADD COLUMN ... NOT NULL`
-- with no default the moment the table has a single row — "Cannot add a NOT NULL
-- column with default value NULL" — and it is empty right now purely because the
-- 👍/👎 loop was never wired and `recordVote` has no callers. Verified both ways
-- against copies of the live database before this was replaced. A migration that
-- fails takes the whole app down rather than just feedback, since every
-- repository function awaits `migrate()`.
--
-- The recreate below is row-count independent. The end state is column-for-column
-- what drizzle's 0006 snapshot records, so `db:generate` stays quiet afterwards.
CREATE TABLE `__new_feedback` (
	`item_id` text PRIMARY KEY NOT NULL,
	`category_slug` text NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`vote` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
-- Titles come from the item where it still exists. The fallback is for a vote
-- whose article was already pruned: the row is kept rather than dropped, because
-- losing a vote silently is the exact failure this whole change exists to
-- prevent, and an unnamed vote still carries its direction.
INSERT INTO `__new_feedback` (`item_id`, `category_slug`, `title`, `source`, `vote`, `created_at`)
SELECT
	`feedback`.`item_id`,
	`feedback`.`category_slug`,
	coalesce(`items`.`title`, '(article no longer stored)'),
	coalesce(`items`.`source`, 'unknown'),
	`feedback`.`vote`,
	`feedback`.`created_at`
FROM `feedback` LEFT JOIN `items` ON `items`.`id` = `feedback`.`item_id`;
--> statement-breakpoint
DROP TABLE `feedback`;
--> statement-breakpoint
ALTER TABLE `__new_feedback` RENAME TO `feedback`;
--> statement-breakpoint
CREATE INDEX `idx_feedback_category` ON `feedback` (`category_slug`,`created_at`);
