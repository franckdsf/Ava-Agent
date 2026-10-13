/**
 * C5 — the model boundary has a place.
 *
 * Seventeen structured model calls handled a malformed answer three ways, and nobody chose which:
 * `/target` asked once while its twin `/client` asked twice, and the job scout turned an answer
 * that did not parse into "found no companies" (audit F7). Slice 6 gave every call one shape —
 * `structured()` in `src/mastra/agents/structured.ts`, whose `attempts` is required — and this
 * check keeps it the only shape:
 *
 *   1. `new Agent(` only under `src/mastra/agents/` — an agent is built where its prompt lives.
 *   2. `.generate(` and `.stream(` (and their `Legacy` variants) only in `structured.ts` — a model
 *      is asked through `structured()`, so how many times is written at every call site.
 *
 * Anyone may *call* a function `agents/` exports — `services/job-scout.ts` does. Comments and
 * strings are exempt, and so are tests: a test of `structured()` has to fake a `generate`.
 * `scripts/` is out of scope: the bench builds clones and calls its judge directly, which is its
 * job (ADR-0046).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { lineAt, listFiles, relative, report, ROOT, stripCommentsAndStrings } from "./_lib.mjs";

const AGENTS_DIR = "src/mastra/agents/";
const STRUCTURED = "src/mastra/agents/structured.ts";

const isTest = (file) => file.includes("/__tests__/") || /\.test\.ts$/.test(file);

const NEW_AGENT = /\bnew\s+Agent\s*\(/g;
const MODEL_CALL = /\.(generate|stream)(Legacy)?\s*\(/g;

const findings = [];

for (const absolute of listFiles(path.join(ROOT, "src"), [".ts"])) {
  const file = relative(absolute);
  if (isTest(file)) continue;

  const code = stripCommentsAndStrings(readFileSync(absolute, "utf8"));

  if (!file.startsWith(AGENTS_DIR)) {
    for (const match of code.matchAll(NEW_AGENT)) {
      findings.push({
        file,
        line: lineAt(code, match.index),
        message: "An agent is built outside src/mastra/agents/.",
        fix: "Move it into src/mastra/agents/ beside its prompt, and export the function that calls it.",
      });
    }
  }

  if (file !== STRUCTURED) {
    for (const match of code.matchAll(MODEL_CALL)) {
      findings.push({
        file,
        line: lineAt(code, match.index),
        message: `\`${match[0].trim()}\` asks a model outside structured().`,
        fix:
          "Call structured(agent, input, schema, { attempts }) from src/mastra/agents/structured.ts, " +
          "stating how many times to ask — `attempts: 1` is allowed, it has to be written.",
      });
    }
  }
}

report("C5 model calls go through structured(), agents live in src/mastra/agents/", findings);
