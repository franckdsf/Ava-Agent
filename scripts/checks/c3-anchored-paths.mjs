/**
 * C3 — no path in `src/` is resolved against the working directory.
 *
 * `mastra dev` runs the bundle from `.mastra/.build` and `mastra build` from `.mastra/output`;
 * neither is the project root. A relative path therefore points somewhere different in dev, in the
 * container and under `pnpm start` — and it fails by creating an empty database or reading nothing,
 * not by throwing. This has bitten twice (docs/GOTCHAS/runtime-and-paths.md). The affordance is
 * `resolveFromRoot()` in `src/lib/project-root.ts`; this check makes it the only path. Two shapes:
 *
 *   1. `process.cwd()` anywhere in `src/` but `src/lib/project-root.ts`
 *   2. a `node:fs` call whose first argument is a relative string literal
 *
 * `scripts/` is out of scope on purpose: pnpm runs every script from the project root, so cwd IS
 * the root there. Code a script imports from `src/` is still checked, because it is in `src/`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { lineAt, listFiles, relative, report, ROOT, stripCommentsAndStrings } from "./_lib.mjs";

const AFFORDANCE = "src/lib/project-root.ts";

const FS_CALLS = [
  "readFileSync", "writeFileSync", "appendFileSync", "existsSync", "readdirSync", "mkdirSync",
  "statSync", "rmSync", "readFile", "writeFile", "appendFile", "readdir", "mkdir", "stat", "rm",
  "createReadStream", "createWriteStream",
];

const findings = [];

for (const absolute of listFiles(path.join(ROOT, "src"), [".ts"])) {
  const file = relative(absolute);
  const source = readFileSync(absolute, "utf8");
  const code = stripCommentsAndStrings(source);
  const withStrings = stripCommentsAndStrings(source, { keepStrings: true });

  if (file !== AFFORDANCE) {
    for (const match of code.matchAll(/\bprocess\s*\.\s*cwd\s*\(/g)) {
      findings.push({
        file,
        line: lineAt(code, match.index),
        message: "process.cwd() outside src/lib/project-root.ts — cwd is not the project root under mastra.",
        fix: "Use resolveFromRoot() (or resolveDbUrl() for a database URL).",
      });
    }
  }

  const fsCall = new RegExp(String.raw`\b(${FS_CALLS.join("|")})\s*\(\s*(["'\x60])([^"'\x60]*)\2`, "g");
  for (const match of withStrings.matchAll(fsCall)) {
    const [, call, , literal] = match;
    if (path.posix.isAbsolute(literal) || path.win32.isAbsolute(literal)) continue;

    findings.push({
      file,
      line: lineAt(withStrings, match.index),
      message: `${call}("${literal}") resolves against cwd, which is not the project root under mastra.`,
      fix: `Wrap it: ${call}(resolveFromRoot("${literal}")).`,
    });
  }
}

report("C3 paths in src/ are anchored to the project root", findings);
