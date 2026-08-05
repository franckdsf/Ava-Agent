CREATE TABLE `beat_revisions` (
	`beat_slug` text NOT NULL,
	`rubric` text NOT NULL,
	`subtopics` text NOT NULL,
	`reason` text,
	`replaced_at` integer NOT NULL,
	PRIMARY KEY(`beat_slug`, `replaced_at`)
);
