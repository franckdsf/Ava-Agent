/**
 * The commit-message rules, run by `.githooks/commit-msg` against the message git is about to write.
 *
 *   1. The title opens with `(feat)`, `(fix)`, `(hotfix)` or `(clean)` — parenthesised, not `feat:`.
 *      `git log --oneline` is how this repo's history is read, and the prefix is what sorts it.
 *   2. No AI-attribution trailer. AGENTS.md bans them, and the rule needs a mechanism because the
 *      agent writing a commit is routinely told the opposite by its harness at the moment it writes
 *      the message — an instruction read then beats one in a document unless something downstream
 *      refuses the result. This is that refusal. Matched against the whole message, trailers
 *      included: a trailer is precisely the part a parsed body would no longer contain.
 *
 * Merge, revert, fixup and squash messages are git's own wording and are not checked.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TYPES = ["feat", "fix", "hotfix", "clean"];

const TITLE = new RegExp(`^\\((${TYPES.join("|")})\\) \\S`);

const AI_ATTRIBUTION = [/noreply@anthropic\.com/i, /co-?authored-by:\s*claude/i, /generated with \[?claude/i];

const GIT_WORDING = /^(Merge |Revert "|fixup! |squash! |amend! )/;

/** Every rule the message breaks, as sentences. Empty means it may be committed. */
export const problemsIn = (raw) => {
  // git strips `#` lines before writing the commit, so they are not part of the message.
  const message = raw
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();

  const title = message.split("\n")[0] ?? "";
  if (GIT_WORDING.test(title)) return [];

  const problems = [];

  if (!TITLE.test(title)) {
    problems.push(
      `The title must open with ${TYPES.map((t) => `(${t})`).join(" ")} and a space — ` +
        `e.g. "(fix) jobs — a refused fire was the day's only chance". Got: "${title}"`,
    );
  }

  const found = AI_ATTRIBUTION.filter((pattern) => pattern.test(message));
  if (found.length > 0) {
    problems.push(`The message carries an AI-attribution trailer (${found.join(", ")}). AGENTS.md bans them — delete it.`);
  }

  return problems;
};

/* ── CLI: node commit-message.mjs <path-to-COMMIT_EDITMSG> ─────────────────────────────── */

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = problemsIn(readFileSync(process.argv[2], "utf8"));

  if (problems.length > 0) {
    console.error("\n✖ Commit refused:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\n  Your message is kept in .git/COMMIT_EDITMSG.\n");
    process.exit(1);
  }
}
