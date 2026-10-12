/**
 * C8 — a scheduled pipeline's cadence and claim come from `definePipeline`, and from nowhere else.
 *
 * The claim, the cadence and the boot catch-up were each solved once and then copied by hand, and
 * the copies drifted: leads got neither the second fire nor the self-releasing claim jobs had
 * (audit F1), and news kept a claim an early throw never released (F4). The kit
 * (`src/mastra/pipeline-kit.ts`, ADR-0044) writes them once. This check keeps it the only way in:
 *
 *   1. `claimCycle` appears only in `src/db/cycles.ts`, which defines it, and in the kit. Tests
 *      are exempt — they exercise the claim directly.
 *   2. A `schedule:` in a file that calls `createWorkflow` is `<NAME>.schedule`, a pipeline's
 *      rendered schedule — unless the line directly above it is `// C8: maintenance — <why>`.
 *
 * The exemption exists because not every schedule is a pipeline. Retention and the weekly reviews
 * have no gate, no claim and no catch-up, and `runHours` cannot express a weekday. The comment
 * makes a new scheduled workflow choose one of the two in writing, where it is declared.
 *
 * @limitation A shorthand `{ schedule }` is not seen. **Accepted because** every workflow here
 * declares its options inline, and a shorthand would need a local named `schedule` that some
 * reviewer would read. **The fix** is the AST this folder cannot use (see `_lib.mjs`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { lineAt, listFiles, relative, report, ROOT, stripCommentsAndStrings } from "./_lib.mjs";

const KIT = "src/mastra/pipeline-kit.ts";
const CLAIM_ALLOWED = new Set([KIT, "src/db/cycles.ts"]);
const EXEMPTION = /^\s*\/\/\s*C8: maintenance\s+—\s+\S/;

const isTest = (file) => file.includes("/__tests__/") || /\.test\.ts$/.test(file);

const findings = [];

for (const absolute of listFiles(path.join(ROOT, "src"), [".ts"])) {
  const file = relative(absolute);
  if (isTest(file)) continue;

  const source = readFileSync(absolute, "utf8");
  const code = stripCommentsAndStrings(source);

  if (!CLAIM_ALLOWED.has(file)) {
    for (const match of code.matchAll(/\bclaimCycle\b/g)) {
      findings.push({
        file,
        line: lineAt(code, match.index),
        message: "claimCycle outside the pipeline kit — a hand-written claim is how F1 and F4 happened.",
        fix: "Define the pipeline with definePipeline (src/mastra/pipelines.ts) and claim with <NAME>.open().",
      });
    }
  }

  if (!/\bcreateWorkflow\s*\(/.test(code)) continue;

  const lines = source.split("\n");
  for (const match of code.matchAll(/\bschedule\s*:/g)) {
    const value = code.slice(match.index + match[0].length);
    if (/^\s*[A-Z][A-Z0-9_]*\.schedule\b/.test(value)) continue;

    const line = lineAt(code, match.index);
    if (EXEMPTION.test(lines[line - 2] ?? "")) continue;

    findings.push({
      file,
      line,
      message: "A schedule that is neither a pipeline's nor marked as maintenance.",
      fix:
        "A pipeline: definePipeline in src/mastra/pipelines.ts, then `schedule: <NAME>.schedule`. " +
        "Not a pipeline: put `// C8: maintenance — <why it has no gate or catch-up>` directly above it.",
    });
  }
}

report("C8 every pipeline's cadence and claim come from definePipeline", findings);
