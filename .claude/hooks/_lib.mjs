/**
 * Shared by the hooks in this folder.
 *
 * Two things live here rather than in the hook that needs them: the git wrapper, because a second
 * hook will want it and a pasted copy means fixing the working-directory assumption twice in
 * lockstep with nothing to catch a divergence; and ROOT, because getting it wrong is silent — a
 * hook that resolves paths against `cwd` reports on whatever directory the session happened to
 * start in, which looks exactly like a clean repo.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Derived from this file's own location, never from `cwd`, for the reason above. `node:path` keeps
 * it correct on Windows, which is where this repo is developed — the separators here are backslashes
 * and nothing may assume otherwise.
 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `core.quotepath=false` is load-bearing, not tidiness. Under git's default, any path containing a
 * byte above 0x7F comes back C-quoted and wrapped in double quotes — `"src/services/r\303\251sum.ts"`
 * — so it prints as gibberish and every `startsWith()` predicate a caller might write misses it.
 *
 * Every failure returns "". A hook that throws is a hook that breaks the session it was supposed to
 * inform, and there is no failure here worth that: not a repo, no git on PATH, a corrupt index —
 * every one of them reads correctly as "nothing to report".
 */
export const git = (...args) => {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

/**
 * Everything uncommitted: tracked modifications, staged changes, and untracked files — deduped and
 * repo-relative.
 *
 * All three sources, because each covers files the others miss. `diff HEAD` sees tracked work
 * staged or not; `diff --cached` is kept explicitly so the set survives a `git add` (and so this
 * still answers on a repo with no commits, where `HEAD` does not resolve and the first call returns
 * ""); `ls-files --others` is the only one that sees a new file, which is the case that matters
 * most — a file nobody has added yet is the one an agent is most likely to forget.
 */
export const changedFiles = () =>
  [
    ...new Set([
      ...git("diff", "--name-only", "HEAD").split("\n"),
      ...git("diff", "--cached", "--name-only").split("\n"),
      ...git("ls-files", "--others", "--exclude-standard").split("\n"),
    ]),
  ].filter(Boolean);
