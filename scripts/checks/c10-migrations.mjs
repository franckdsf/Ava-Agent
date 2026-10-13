/**
 * C10 — the migrations match the schema.
 *
 * Editing `src/db/schema.ts` without `pnpm db:generate` keeps typechecking — the code reads the new
 * column — and lags the database silently: nothing creates it, and the first query that touches it
 * fails at runtime. Until this check, the only guard was a `SessionStart` hook comparing file times.
 *
 * So this runs the real `drizzle-kit generate` against a **scratch copy** of `drizzle/` and fails if
 * it writes a migration: a migration it would write is one the commit is missing. Nothing in the
 * repo's `drizzle/` is touched. The copy lives under `.mastra/` — gitignored, skipped by every
 * check, and inside the project so the schema's imports resolve — and is removed either way.
 *
 * Offline and deterministic: `generate` reads the schema and the last snapshot, never a database.
 * It costs about two seconds of `pnpm verify`. A crash of drizzle-kit is thrown, never read as a
 * pass.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { report, ROOT } from "./_lib.mjs";

const SCHEMA = "src/db/schema.ts";
const MIGRATIONS = "drizzle";

const findings = [];

if (existsSync(path.join(ROOT, SCHEMA)) && existsSync(path.join(ROOT, MIGRATIONS))) {
  // `bin.cjs` is not in drizzle-kit's exports map; it sits beside the main entry.
  const drizzleKit = path.join(path.dirname(createRequire(import.meta.url).resolve("drizzle-kit")), "bin.cjs");
  const scratchParent = path.join(ROOT, ".mastra");
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(path.join(scratchParent, "migration-check-"));

  try {
    const out = path.join(scratch, MIGRATIONS);
    cpSync(path.join(ROOT, MIGRATIONS), out, { recursive: true });
    const before = new Set(readdirSync(out));

    // drizzle-kit joins the working directory onto an absolute `--out` on Windows, so both paths
    // are given relative to ROOT, with forward slashes.
    const relative = (absolute) => path.relative(ROOT, absolute).split(path.sep).join("/");
    execFileSync(
      process.execPath,
      [drizzleKit, "generate", "--dialect", "turso", "--schema", SCHEMA, "--out", relative(out)],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    const written = readdirSync(out).filter((entry) => !before.has(entry) && entry.endsWith(".sql"));
    for (const file of written) {
      findings.push({
        file: SCHEMA,
        line: 1,
        message: `The schema has changed with no migration — drizzle-kit would write \`${file}\`.`,
        fix: "Run `pnpm db:generate` and commit the migration with the schema change (invariant 4).",
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

report("C10 the migrations match the schema", findings);
