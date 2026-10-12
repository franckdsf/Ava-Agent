/**
 * C4 — no error is swallowed without a word.
 *
 * Two shapes, both of which turn a failure into nothing at all — no log line, no message, no trace
 * in a run that otherwise looks healthy:
 *
 *   1. an empty `catch {}` — a block with nothing in it, not even a comment saying why
 *   2. a promise swallowed whole — `.catch(() => {})`, or one returning `undefined` / `null`
 *
 * A catch that holds only a comment passes: the comment is the decision, written where the next
 * reader needs it. That is the bar — not "handle every error", but "never discard one silently".
 *
 * Shape 2 is a RATCHET, not a ban. The repo had fifteen when this check landed — best-effort
 * Telegram notices, mostly, where a failed send must not fail the run. That intent is right; the
 * silence is not, because a notice that never arrived leaves nothing to find. They are listed in
 * `c4-baseline.json`, per file, and the list may only shrink: a file with more than its baseline
 * fails (a new swallow), and a file with fewer fails too, until its entry is lowered — so a fix is
 * recorded in the same commit that makes it, and the list never claims debt that is gone.
 *
 * The baseline is data under the checked tree rather than a constant here, so a test's fixture tree
 * states its own — none, unless the test is about the ratchet.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { lineAt, listFiles, relative, report, ROOT, stripCommentsAndStrings } from "./_lib.mjs";

const BASELINE_FILE = "scripts/checks/c4-baseline.json";

/** File → how many swallowed promises it is allowed. Lower an entry when you fix one; never raise it. */
const BASELINE = existsSync(path.join(ROOT, BASELINE_FILE))
  ? JSON.parse(readFileSync(path.join(ROOT, BASELINE_FILE), "utf8"))
  : {};

const ROOTS = ["src", "scripts", ".claude/hooks"];

const findings = [];
const swallowed = new Map();

for (const absolute of ROOTS.flatMap((root) => listFiles(path.join(ROOT, root), [".ts", ".mts", ".mjs"]))) {
  const file = relative(absolute);
  if (file.includes("/__tests__/")) continue;

  const source = readFileSync(absolute, "utf8");
  const code = stripCommentsAndStrings(source);
  // Comments kept: a catch holding only a comment is the allowed shape, so it must not read as empty.
  const withComments = stripCommentsAndStrings(source, { keepComments: true });

  /* 1 — `catch {}` / `catch (e) {}` with nothing inside, comments included. Found in the
         comment-blanked text, so prose about the rule is not a hit; confirmed against the
         comment-kept text, so a catch that says why is not one either. Offsets match in both. */
  for (const match of code.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) {
    const span = withComments.slice(match.index, match.index + match[0].length);
    if (!/\{\s*\}$/.test(span)) continue;

    findings.push({
      file,
      line: lineAt(withComments, match.index),
      message: "Empty catch block — the error is discarded and nothing says why.",
      fix: "Log it, rethrow it, or — if discarding it is the decision — write one comment saying why.",
    });
  }

  /* 2 — `.catch(() => {})` and its `undefined` / `null` spellings. */
  const swallow = /\.catch\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)/g;
  const hits = [...code.matchAll(swallow)];
  if (hits.length > 0) swallowed.set(file, hits.map((m) => lineAt(code, m.index)));
}

for (const [file, lines] of swallowed) {
  const allowed = BASELINE[file] ?? 0;
  if (lines.length <= allowed) continue;

  findings.push({
    file,
    line: lines[lines.length - 1],
    message: `${lines.length} swallowed promise(s), baseline ${allowed} — a .catch(() => {}) was added (lines ${lines.join(", ")}).`,
    fix: "Log the failure before discarding it, or let it propagate. The baseline is debt, not a quota.",
  });
}

for (const [file, allowed] of Object.entries(BASELINE)) {
  const found = swallowed.get(file)?.length ?? 0;
  if (found >= allowed) continue;

  findings.push({
    file: BASELINE_FILE,
    message: `${file} is down to ${found} swallowed promise(s), and the baseline still allows ${allowed}.`,
    fix: found === 0 ? `Delete its entry in ${BASELINE_FILE}.` : `Lower its entry in ${BASELINE_FILE} to ${found}.`,
  });
}

report("C4 no error is swallowed silently", findings);
