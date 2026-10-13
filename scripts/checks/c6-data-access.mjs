/**
 * C6 — data access stays in `src/db/`.
 *
 * Every write already lived in `src/db/`, but four files read the database outside it — the news
 * tools seven times, `/beat`, the leads signals, and find-leads through three dynamic `import()`s —
 * so a column rename had four more places to break (audit F9). Slice 7 moved each read into a named
 * repository function. This check keeps them there:
 *
 *   1. No value import from `drizzle-orm` outside `src/db/` — the query builder is how a read is
 *      written, so a file holding it is a file writing queries.
 *   2. Nothing from `db/client` outside `src/db/` — `db`, `migrate`, `batchAll` alike — and no
 *      dynamic `import()` of it.
 *   3. No value import of a table from `db/schema` outside `src/db/` — a table object is only good
 *      for building a query. Its *types* (`import type { Job }`) are how the rest of the code
 *      speaks about rows, and stay allowed.
 *
 * **`rawClient` is allowed in `mastra/storage.ts` only:** it hands the connection to Mastra's `LibSQLStore`,
 * which is Mastra owning `mastra_*` (invariant 4), not app data access. Tests are exempt: a test
 * seeds rows to read them back. `scripts/` is out of scope.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { lineAt, listFiles, relative, report, ROOT, stripCommentsAndStrings } from "./_lib.mjs";

const DB_DIR = "src/db/";
/** The one file outside `src/db/` that may take the connection — and only as `rawClient`. */
const MASTRA_STORE = "src/mastra/storage.ts";
const isTest = (file) => file.includes("/__tests__/") || /\.test\.ts$/.test(file);

/** Static imports: the clause between `import` and `from`, and the specifier. */
const STATIC_IMPORT = /\bimport\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const isDrizzle = (specifier) => specifier === "drizzle-orm" || specifier.startsWith("drizzle-orm/");
const isDbModule = (specifier, name) => new RegExp(`(^|/)db/${name}(\\.js)?$`).test(specifier);

/** The names an import clause brings in as values — `type` ones and `import type` dropped. */
const valueNames = (clause) => {
  if (/^type\s/.test(clause)) return [];
  const names = [];
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const name = part.trim();
      if (name && !/^type\s/.test(name)) names.push(name.split(/\s+as\s+/)[0].trim());
    }
  }
  const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
  if (outside) names.push(outside); // a default or `* as x` import
  return names;
};

const findings = [];
const add = (file, code, index, message, fix) => findings.push({ file, line: lineAt(code, index), message, fix });

const FIX = "Write the read as a function in src/db/ and import that instead.";

for (const absolute of listFiles(path.join(ROOT, "src"), [".ts"])) {
  const file = relative(absolute);
  if (file.startsWith(DB_DIR) || isTest(file)) continue;

  const code = stripCommentsAndStrings(readFileSync(absolute, "utf8"), { keepStrings: true });

  for (const match of code.matchAll(STATIC_IMPORT)) {
    const [, clause, specifier] = match;
    const values = valueNames(clause);
    if (values.length === 0) continue;

    if (isDrizzle(specifier)) {
      add(file, code, match.index, `imports the query builder from \`${specifier}\` outside src/db/.`, FIX);
    } else if (isDbModule(specifier, "client")) {
      const allowed = file === MASTRA_STORE ? ["rawClient"] : [];
      const refused = values.filter((name) => !allowed.includes(name));
      if (refused.length > 0) {
        add(file, code, match.index, `imports \`${refused.join("`, `")}\` from db/client outside src/db/.`, FIX);
      }
    } else if (isDbModule(specifier, "schema")) {
      add(file, code, match.index, `imports table \`${values.join("`, `")}\` from db/schema outside src/db/.`,
        `${FIX} Row types stay importable: \`import type { … }\`.`);
    }
  }

  for (const match of code.matchAll(DYNAMIC_IMPORT)) {
    const specifier = match[1];
    if (isDrizzle(specifier) || isDbModule(specifier, "client") || isDbModule(specifier, "schema")) {
      add(file, code, match.index, `dynamically imports \`${specifier}\` outside src/db/.`, FIX);
    }
  }
}

report("C6 data access stays in src/db/", findings);
