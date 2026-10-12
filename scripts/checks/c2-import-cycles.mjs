/**
 * C2 — no import cycles inside this repository.
 *
 * ESM does not fail on a cycle. The second module in the loop sees the first one's bindings before
 * they are initialised, so the symptom is a `ReferenceError: Cannot access 'x' before
 * initialization` — or a silent `undefined` through a namespace import — on one import order and
 * not another. `mastra dev` and `mastra build` bundle in a different order than `tsx` runs a script,
 * so a cycle can pass every `:check` script and break only the container. Nothing in either file
 * looks wrong, which is why it survives review.
 *
 * Only this repo's own files are graph nodes. A bare specifier is a package: a cycle through one is
 * not something this repo can fix, and resolving node_modules to rule it out is pure cost.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { listFiles, relative, report, ROOT, stripCommentsAndStrings } from "./_lib.mjs";

/** Where cycles are worth preventing. */
const ROOTS = ["src", "scripts"];

const EXTENSIONS = [".ts", ".mts", ".mjs"];

/**
 * How a written specifier maps onto a file. This repo writes `./foo.js` for `./foo.ts` — the ESM
 * rule under `moduleResolution: bundler` — so the `.js` suffix is swapped before anything else is
 * tried, and an extensionless or directory import still resolves.
 */
const candidatesFor = (repoPath) => {
  const base = repoPath.replace(/\.(m?js)$/, "");
  return [repoPath, `${base}.ts`, `${base}.mts`, `${base}.mjs`, `${base}/index.ts`];
};

/**
 * Every runtime import/export-from specifier in a file, as written.
 *
 * `import type` and `export type` are skipped: types are erased before anything runs, so a
 * type-only edge cannot cause an initialisation-order failure. Read from the file with comments
 * blanked, so an import quoted in a doc comment is not an edge.
 */
const specifiersOf = (file) => {
  const text = stripCommentsAndStrings(readFileSync(file, "utf8"), { keepStrings: true });
  const out = [];

  // The clause is spelled out — `x`, `{ … }`, `x, { … }`, `* as x` — rather than matched lazily up
  // to the next `from`. This repo omits semicolons, so a lazy match starting at `export type X =`
  // would run on into the next line's runtime import and file it as type-only.
  const clause = String.raw`(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)`;
  const statement = new RegExp(
    String.raw`(?:^|[;\n])\s*(import|export)\s+(type\s+)?(${clause})\s*from\s*["']([^"']+)["']`,
    "g",
  );
  for (const [, , typeOnly, , specifier] of text.matchAll(statement)) {
    if (!typeOnly) out.push(specifier);
  }

  // Side-effect imports — `import "./x.js"` — are edges too, and the likeliest to hide one.
  for (const [, specifier] of text.matchAll(/(?:^|[;\n])\s*import\s*["']([^"']+)["']/g)) out.push(specifier);

  return out;
};

/* ── Build the graph ──────────────────────────────────────────────────────────────────────── */

const files = ROOTS.flatMap((root) => listFiles(path.join(ROOT, root), EXTENSIONS))
  .map(relative)
  .filter((file) => !file.endsWith(".d.ts") && !file.includes("/__tests__/"));

const known = new Set(files);
const graph = new Map();

for (const file of files) {
  const edges = [];

  for (const specifier of specifiersOf(path.join(ROOT, file))) {
    if (!specifier.startsWith(".")) continue; // A package. See the header.

    const repoPath = relative(path.resolve(path.dirname(path.join(ROOT, file)), specifier));
    const target = candidatesFor(repoPath).find((candidate) => known.has(candidate));
    if (target && target !== file) edges.push(target);
  }

  graph.set(file, edges);
}

/* ── Find cycles ──────────────────────────────────────────────────────────────────────────── */

const findings = [];
const seen = new Set();
const state = new Map(); // file → "visiting" | "done"
const stack = [];

/** Rotation-independent identity, so one cycle is reported once rather than once per member. */
const signatureOf = (cycle) => [...cycle].sort().join(" ");

/**
 * Iterative rather than recursive: a recursive walk over a long import chain is a stack overflow,
 * which exits 1 with no ❌ banner — a crash the harness reports as a crash, but one a reader of the
 * Stop hook would first take for a finding.
 */
const visit = (start) => {
  const frames = [{ file: start, next: 0 }];
  state.set(start, "visiting");
  stack.push(start);

  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    const edges = graph.get(frame.file) ?? [];

    if (frame.next >= edges.length) {
      frames.pop();
      stack.pop();
      state.set(frame.file, "done");
      continue;
    }

    const next = edges[frame.next++];

    if (state.get(next) === "visiting") {
      const cycle = stack.slice(stack.indexOf(next));
      const signature = signatureOf(cycle);

      if (!seen.has(signature)) {
        seen.add(signature);
        findings.push({
          file: cycle[0],
          message: `Import cycle: ${[...cycle, cycle[0]].join(" → ")}`,
          fix:
            "Break one edge. Usually one side wants a type (make it `import type`) or a constant " +
            "that belongs in src/config/ — import it from where it is defined, not through the loop.",
        });
      }
      continue;
    }

    if (!state.has(next)) {
      state.set(next, "visiting");
      stack.push(next);
      frames.push({ file: next, next: 0 });
    }
  }
};

for (const file of files) if (!state.has(file)) visit(file);

report("C2 no import cycles", findings);
