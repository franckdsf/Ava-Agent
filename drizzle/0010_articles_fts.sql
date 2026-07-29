-- Full-text index over articles, so search matches terms instead of one substring.
--
-- Hand-written: drizzle-kit cannot express a virtual table, so this migration is
-- the one piece of the app schema that does not come from src/db/schema.ts.
-- It replaces `items_fts`, dropped in 0008 with the table it indexed.
-- See docs/decisions/0011-fts5-for-article-search.md.
--
-- External-content (`content='articles'`): the index stores no copy of the text,
-- it points back at articles by rowid. That keeps articles the single source of
-- truth and costs an extra lookup per hit, which is the right trade for a table
-- this size.
--
-- `content` appears twice on purpose — bare it is the third indexed column,
-- `content=` is the external-content option. FTS5 treats an argument containing
-- `=` as an option and everything else as a column name.
CREATE VIRTUAL TABLE `articles_fts` USING fts5(
  `title`,
  `excerpt`,
  `content`,
  content=`articles`,
  content_rowid=`rowid`,
  tokenize='porter unicode61'
);
--> statement-breakpoint
-- An ignored conflict in insertDiscovered does not fire this, which is what we
-- want: no row inserted, no index entry.
CREATE TRIGGER `articles_fts_insert` AFTER INSERT ON `articles` BEGIN
  INSERT INTO `articles_fts`(`rowid`, `title`, `excerpt`, `content`)
  VALUES (new.`rowid`, new.`title`, new.`excerpt`, new.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `articles_fts_delete` AFTER DELETE ON `articles` BEGIN
  INSERT INTO `articles_fts`(`articles_fts`, `rowid`, `title`, `excerpt`, `content`)
  VALUES ('delete', old.`rowid`, old.`title`, old.`excerpt`, old.`content`);
END;
--> statement-breakpoint
-- `UPDATE OF` is still load-bearing, though less so than it was. Ranking has
-- moved to `article_beats`, so this table no longer takes a score write per run
-- — but delivery still writes `delivered_at` on every article sent, and the
-- compose step writes `image_url` when it resolves an og:image. Without the
-- column list both would reindex text that never changed.
--
-- No backfill statement follows, unlike 0005: `articles` is created empty by
-- 0009, so there is nothing to rebuild from.
--
-- Two things about the breakpoint marker, both learned by failing here. The
-- migrator splits on it with a plain string split that knows nothing about SQL
-- comments, so writing the marker inside a comment cuts the file at that point.
-- And a file must end on a real statement: a trailing marker leaves an empty
-- string to execute. Both fail as `SQLITE_UNKNOWN_0: not an error` with a
-- statement index and no file name, which is a long way from the cause.
CREATE TRIGGER `articles_fts_update` AFTER UPDATE OF `title`, `excerpt`, `content` ON `articles` BEGIN
  INSERT INTO `articles_fts`(`articles_fts`, `rowid`, `title`, `excerpt`, `content`)
  VALUES ('delete', old.`rowid`, old.`title`, old.`excerpt`, old.`content`);
  INSERT INTO `articles_fts`(`rowid`, `title`, `excerpt`, `content`)
  VALUES (new.`rowid`, new.`title`, new.`excerpt`, new.`content`);
END;
