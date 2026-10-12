/**
 * Stop — run the rule checks the working set warrants, at the one moment the code is coherent.
 *
 * On PostToolUse this would be noise: mid-edit files are half-written by design, so a per-edit check
 * reports states nobody intended and trains you to ignore it. At turn end the work is finished,
 * which makes a failure actionable — one turn after the mistake rather than at commit time.
 *
 * ADVISORY, deliberately. It prints and exits 0; it never blocks the turn. The pre-commit hook is the
 * gate. Promote this to blocking only once it has been observed not to cry wolf.
 *
 * Typecheck and tests are not run here: they take seconds rather than milliseconds, on every turn,
 * and both run at commit. The C scripts are text scans that finish in about a tenth of a second.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { changedFiles, ROOT } from "./_lib.mjs";

const STAMP = path.join(ROOT, "node_modules", ".cache", "ava-stop-checks.json");

/** Named once because it is read twice — to run a check and to stamp its mtime — and the two fail differently when wrong. */
const CHECKS_DIR = path.join(ROOT, "scripts", "checks");

/**
 * Which check answers for which part of the tree. Conservative supersets of what each script reads:
 * over-running costs milliseconds, under-running is a check that silently stopped covering something.
 *
 * C1's trigger is `true` on purpose. Its real input is the whole tree, not the docs: renaming any
 * file a doc names breaks it without one `.md` being touched.
 */
const CHECKS = [
  { name: "C1 doc integrity", script: "c1-doc-integrity.mjs", when: () => true },
  { name: "C2 import cycles", script: "c2-import-cycles.mjs", when: (f) => f.startsWith("src/") || f.startsWith("scripts/") },
  { name: "C3 anchored paths", script: "c3-anchored-paths.mjs", when: (f) => f.startsWith("src/") },
  {
    name: "C4 silent catch",
    script: "c4-silent-catch.mjs",
    when: (f) => f.startsWith("src/") || f.startsWith("scripts/") || f.startsWith(".claude/hooks/"),
  },
];

const changed = changedFiles();
const needed = CHECKS.filter((check) => changed.some(check.when));

if (needed.length === 0) process.exit(0);

/* ── Skip when nothing moved since the last run ─────────────────────────────────────────── */

const mtimeOf = (absolute) => {
  try {
    return String(statSync(absolute).mtimeMs);
  } catch {
    return "absent"; // Deleted between git listing it and this call — still part of the signature.
  }
};

/**
 * Covers both halves of what a verdict depends on — the files checked and the check scripts — so
 * editing a rule re-runs it rather than leaving a stale verdict cached. Without the stamp at all,
 * every turn for the rest of the session re-reports a violation already reported.
 */
const signature = [
  ...needed.map((check) => `${check.script}:${mtimeOf(path.join(CHECKS_DIR, check.script))}`),
  `_lib.mjs:${mtimeOf(path.join(CHECKS_DIR, "_lib.mjs"))}`,
  ...changed
    .filter((f) => needed.some((check) => check.when(f)))
    .sort()
    .map((f) => `${f}:${mtimeOf(path.join(ROOT, f))}`),
].join("|");

const readStamp = () => {
  try {
    return JSON.parse(readFileSync(STAMP, "utf8")).signature;
  } catch {
    return null; // No stamp yet, or unreadable — treat as never run.
  }
};

if (readStamp() === signature) process.exit(0);

/* ── Run them ───────────────────────────────────────────────────────────────────────────── */

const failures = [];

for (const check of needed) {
  try {
    // process.execPath, not "node": off PATH it can resolve to another runtime, or to nothing — and
    // nothing would make every check throw ENOENT and be reported as a violation.
    execFileSync(process.execPath, [path.join(CHECKS_DIR, check.script)], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // A check prints its own ❌ banner. One that crashed prints none, so it is labelled here —
    // otherwise "this check stopped running" arrives looking like a finding.
    const output = (error.stderr || error.stdout || String(error.message)).trim();
    failures.push(output.startsWith("❌") ? output : `❌ ${check.name} crashed — ${output}`);
  }
}

let stampWarning = null;

try {
  mkdirSync(path.dirname(STAMP), { recursive: true });
  writeFileSync(STAMP, JSON.stringify({ signature }));
} catch (error) {
  // Without a stamp these re-run and re-report on every turn. A tooling problem, not a violation.
  stampWarning = `⚠️  Could not write the run stamp (${error.code ?? error.message}) — these checks will re-report every turn.`;
}

const message = [];

if (failures.length > 0) {
  message.push(
    `⚠️  ${failures.length} rule check(s) failed on the current working set.`,
    "",
    ...failures,
    "",
    "These run again at commit time via pnpm verify — fixing now is cheaper.",
  );
}
if (stampWarning) message.push(...(message.length ? [""] : []), stampWarning);

if (message.length === 0) process.exit(0);

process.stdout.write(JSON.stringify({ systemMessage: message.join("\n") }));
