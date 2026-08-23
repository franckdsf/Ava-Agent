/**
 * SessionStart — the facts every session otherwise opens by rediscovering.
 *
 * Branch, working set, whether the installed dependencies still match the lockfile, whether a plan
 * is still in flight, and whether the migrations have fallen behind the schema. An agent spends its
 * first few tool calls establishing some of this, and only when it thinks to look — which is the
 * failure mode, not the cost. Printing it deterministically costs CPU cycles and zero inference.
 *
 * Prints a JSON envelope whose `additionalContext` is injected before the first turn. Stays quiet
 * when there is nothing to say: a hook that speaks every session about nothing is a hook people
 * learn to skim, and then it is worth nothing on the session that mattered.
 *
 * Never fails the session. Every git call degrades to an empty string, every filesystem read is
 * wrapped, and the emit at the bottom runs whatever happened above it. Nothing here touches the
 * network — this runs before turn one, on a 10s timeout, and a DNS stall would be paid every time.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { changedFiles, git, ROOT } from "./_lib.mjs";

const MAX_FILES = 15;

const lines = [];

/** Anything below may throw on a filesystem that surprises us; nothing below may take the session down. */
const safely = (fn) => {
  try {
    fn();
  } catch {
    /* A block that cannot answer says nothing. Silence is the documented degradation. */
  }
};

/* ── Branch ─────────────────────────────────────────────────────────────────────────────── */

safely(() => {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!branch) return;

  // `--abbrev-ref` returns the literal string "HEAD" when detached — mid-rebase, mid-bisect, or on
  // a checked-out tag. Printing "Branch: HEAD" says nothing, and committing there is worse than
  // committing on main: the commit belongs to no branch and is lost at the next checkout.
  if (branch === "HEAD") {
    lines.push(`Detached HEAD at ${git("rev-parse", "--short", "HEAD")} — do not commit here.`);
  } else if (branch === "main") {
    // Stated plainly, with no warning attached: this repo ships from `main` and every commit in
    // its history is on it. The imported version of this hook told you to branch first, which is
    // correct for a repo with a review gate and pure noise here — a hook that nags on every
    // session start is a hook you stop reading, including the lines that matter.
    lines.push("Branch: main");
  } else {
    lines.push(`Branch: ${branch}`);
  }

  // Three, because the useful signal is the shape of the recent work — the prefix convention in
  // use, whether the last change is half-landed — and that is visible in three lines and diluted
  // by twenty.
  const recent = git("log", "--oneline", "-3", "--no-decorate");
  if (recent) lines.push("Recent:", ...recent.split("\n").map((l) => `  ${l}`));
});

/* ── Dependency drift ───────────────────────────────────────────────────────────────────── */

/**
 * A branch switch or a pull resyncs the lockfile but not `node_modules`, and the resulting failures
 * read as code problems rather than install problems — so the wrong thing gets debugged, sometimes
 * for a while. pnpm rewrites `.modules.yaml` on every install, so its mtime against the lockfile's
 * answers this exactly.
 *
 * The missing case is called out separately and first: it is the worst one (a fresh clone, where
 * nothing runs at all) and it is the one an mtime comparison alone stays completely silent about,
 * because there is no second mtime to compare against.
 */
safely(() => {
  const lockfile = path.join(ROOT, "pnpm-lock.yaml");
  const installed = path.join(ROOT, "node_modules", ".modules.yaml");

  if (!existsSync(lockfile)) return;

  if (!existsSync(installed)) {
    lines.push("node_modules is missing — run `pnpm install` before anything else. pnpm only, never npm.");
  } else if (statSync(lockfile).mtimeMs > statSync(installed).mtimeMs) {
    lines.push("node_modules is older than pnpm-lock.yaml — run `pnpm install` before anything else.");
  }
});

/* ── Working set ────────────────────────────────────────────────────────────────────────── */

/**
 * Capped, because the point is orientation and not an inventory: past a screenful the list stops
 * being read, and the count alone already tells you a big change is in flight. The total is printed
 * either way so a truncated list never reads as the whole story.
 */
safely(() => {
  const files = changedFiles();
  if (!files.length) return;

  lines.push(`Uncommitted (${files.length}):`);
  lines.push(...files.slice(0, MAX_FILES).map((f) => `  ${f}`));
  if (files.length > MAX_FILES) lines.push(`  …and ${files.length - MAX_FILES} more`);
});

/* ── Plan in flight ─────────────────────────────────────────────────────────────────────── */

/**
 * A plan is deleted in the commit that lands its slice (docs/plans/README.md). So a plan still on
 * disk means one of exactly two things — a slice is genuinely in progress, or a landed one left its
 * specification behind — and both are things to know before the first edit, because the second
 * reads as a specification and an agent will build against it.
 *
 * This is the enforcement half of the deletion rule: nothing can make the delete happen, but a file
 * that announces itself at the top of every session does not rot quietly.
 */
safely(() => {
  const plansDir = path.join(ROOT, "docs", "plans");
  if (!existsSync(plansDir)) return;

  const plans = readdirSync(plansDir).filter(
    (f) => f.endsWith(".md") && f !== "README.md" && !f.startsWith("_"),
  );

  if (plans.length) {
    lines.push(
      `Plans in flight: ${plans.map((f) => `docs/plans/${f}`).join(", ")}`,
      "Read before touching the slices they cover. Intent, not description: where a plan disagrees",
      "with the repo, the repo wins and the plan should already have been deleted.",
    );
  }
});

/* ── Migrations behind the schema ───────────────────────────────────────────────────────── */

/**
 * The one rule here that is this repo's rather than any repo's, and the one worth the whole hook.
 *
 * `pnpm db:generate` is REQUIRED after editing the drizzle schema, and skipping it fails silently:
 * the types keep compiling, `pnpm typecheck` stays green, and the migration simply lags the code
 * until a container boots against a database that has never seen the column. Nothing in the normal
 * loop catches it — which is exactly why it is worth one mtime comparison at session start.
 *
 * Newest file under `src/db/` against newest under `drizzle/` (which includes `meta/_journal.json`,
 * rewritten on every generate). mtimes are a heuristic: a checkout can reorder them and produce a
 * false positive. That is the safe direction — the cost is running a generate that emits nothing.
 */
safely(() => {
  const newest = (dir) => {
    let latest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Recursive by hand rather than by shell: `find` does not exist on Windows, and the two
      // trees involved are a handful of files each.
      if (entry.isDirectory()) latest = Math.max(latest, newest(full));
      else if (entry.isFile()) latest = Math.max(latest, statSync(full).mtimeMs);
    }
    return latest;
  };

  const schemaDir = path.join(ROOT, "src", "db");
  const migrationsDir = path.join(ROOT, "drizzle");
  if (!existsSync(schemaDir) || !existsSync(migrationsDir)) return;

  if (newest(schemaDir) > newest(migrationsDir)) {
    lines.push(
      "src/db/ is newer than drizzle/ — if the schema changed, run `pnpm db:generate` and commit the",
      "migration with it. A missed generate keeps typechecking and lags the database silently.",
    );
  }
});

/* ── Emit ───────────────────────────────────────────────────────────────────────────────── */

/**
 * `{}` when there is nothing to say — a valid envelope that injects nothing, which is what the
 * silence requirement means in practice. Written last and unconditionally, so however little the
 * blocks above managed to establish, this still prints valid JSON and exits 0.
 */
process.stdout.write(
  JSON.stringify(
    lines.length
      ? {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: lines.join("\n"),
          },
        }
      : {},
  ),
);
