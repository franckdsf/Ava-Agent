/**
 * C9 — the invariants a line of text can break.
 *
 * Most of AGENTS.md's nine invariants are shapes only a reader can judge. These five rules are not:
 * each one is broken by a specific string in a specific file, so CONVENTIONS §1 had them as ⏳ —
 * held by nobody, mechanisable. This check holds them:
 *
 *   1. Invariants 1 and 7 — the Telegram adapter's mode. `mode: 'auto'` falls back to a *webhook*,
 *      and a webhook needs an inbound port. So no `mode: 'auto'` or `'webhook'` anywhere; the one
 *      polling adapter (`src/mastra/agents/chat-agent.ts`) says `mode: 'polling'`; and no other
 *      `createTelegramAdapter({…})` — the outbound ones — passes a `mode` at all.
 *   2. Invariants 1 and 6 — `docker-compose.yml` binds every port to `127.0.0.1` and never asks for
 *      `replicas:` or `scale:`.
 *   3. Invariant 8 — nothing in `src/mastra/tools/` or `src/mastra/commands/` names `curateAll` or
 *      `'curate-all'` in code. Strings count, because a workflow is started by its id.
 *   4. The domain rule "never write `lead_signals` from the jobs workflow" — `find-jobs.ts` imports
 *      nothing from `db/leads`; `hiringSignalsFromJobs` already reads `jobs`.
 *   5. Invariant 4 — `src/db/schema.ts` declares no `mastra_` table; Mastra owns those.
 *
 * Comments are exempt everywhere, so a rule can be explained with the very word it forbids. Tests
 * are exempt: a test may build an adapter however it likes.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { lineAt, listFiles, relative, report, ROOT, stripCommentsAndStrings } from "./_lib.mjs";

const POLLING_ADAPTER = "src/mastra/agents/chat-agent.ts";
const isTest = (file) => file.includes("/__tests__/") || /\.test\.ts$/.test(file);

const findings = [];
const add = (file, text, index, message, fix) => findings.push({ file, line: lineAt(text, index), message, fix });

/** The argument text of the call whose `(` is at `open`, up to its matching `)`. */
const callArguments = (code, open) => {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
};

const sources = listFiles(path.join(ROOT, "src"), [".ts"])
  .map((absolute) => ({ file: relative(absolute), absolute }))
  .filter(({ file }) => !isTest(file))
  .map(({ file, absolute }) => ({
    file,
    code: stripCommentsAndStrings(readFileSync(absolute, "utf8"), { keepStrings: true }),
  }));

// 1. The Telegram adapter's mode.
let pollingFound = false;
for (const { file, code } of sources) {
  for (const match of code.matchAll(/\bmode\s*:\s*["'](auto|webhook)["']/g)) {
    add(file, code, match.index, `\`mode: '${match[1]}'\` — 'auto' falls back to a webhook, which needs an inbound port.`,
      "Poll: `mode: 'polling'` on the agent's adapter, and no mode on an outbound one (invariants 1, 7).");
  }
  for (const match of code.matchAll(/\bcreateTelegramAdapter\s*\(/g)) {
    const args = callArguments(code, match.index + match[0].length - 1);
    const mode = args.match(/\bmode\s*:\s*["']([a-z]+)["']/);
    if (file === POLLING_ADAPTER) {
      if (mode?.[1] === "polling") pollingFound = true;
    } else if (mode) {
      add(file, code, match.index, "An outbound Telegram adapter is given a `mode`.",
        "Leave `mode` off: only the agent's adapter polls, and exactly one adapter polls per token (invariant 7).");
    }
  }
}
if (existsSync(path.join(ROOT, POLLING_ADAPTER)) && !pollingFound) {
  findings.push({
    file: POLLING_ADAPTER,
    line: 1,
    message: "The agent's Telegram adapter does not say `mode: 'polling'`.",
    fix: "Pass `mode: 'polling'` explicitly — the default is not a promise (invariants 1, 7).",
  });
}

// 2. docker-compose.yml: loopback ports, one replica.
const composePath = path.join(ROOT, "docker-compose.yml");
if (existsSync(composePath)) {
  const compose = readFileSync(composePath, "utf8").replace(/#.*$/gm, (comment) => " ".repeat(comment.length));
  const ports = compose.match(/^(\s*)ports\s*:\s*\n((?:\1\s+-.*\n?|\s*\n)*)/m);
  if (ports) {
    const start = ports.index + ports[0].indexOf(ports[2]);
    for (const entry of ports[2].matchAll(/-\s*["']?([^"'\s]+)["']?/g)) {
      if (!entry[1].startsWith("127.0.0.1:")) {
        add("docker-compose.yml", compose, start + entry.index, `Port \`${entry[1]}\` is not bound to loopback.`,
          "Prefix it with `127.0.0.1:` — nothing reaches the agent from the network (invariant 1).");
      }
    }
  }
  for (const match of compose.matchAll(/^\s*(replicas|scale)\s*:/gm)) {
    add("docker-compose.yml", compose, match.index, `\`${match[1]}:\` asks for more than one replica.`,
      "Remove it — two replicas poll one token and fire every schedule twice (invariant 6).");
  }
}

// 3. Nothing conversational starts curateAll.
for (const { file, code } of sources) {
  if (!file.startsWith("src/mastra/tools/") && !file.startsWith("src/mastra/commands/")) continue;
  for (const match of code.matchAll(/\bcurateAll\b|["']curate-all["']/g)) {
    add(file, code, match.index, "A tool or command reaches the news run.",
      "A conversation never starts `curateAll` — the run is the schedule's (invariant 8).");
  }
}

// 4. The jobs workflow writes no lead signal.
for (const { file, code } of sources) {
  if (file !== "src/mastra/workflows/find-jobs.ts") continue;
  for (const match of code.matchAll(/\bfrom\s+["'][^"']*db\/leads(\.js)?["']|import\(\s*["'][^"']*db\/leads(\.js)?["']/g)) {
    add(file, code, match.index, "The jobs workflow imports the leads tables' functions.",
      "`hiringSignalsFromJobs` already reads `jobs`; the jobs run never writes `lead_signals` (ADR-0038).");
  }
}

// 5. Drizzle owns no mastra_ table.
for (const { file, code } of sources) {
  if (file !== "src/db/schema.ts") continue;
  for (const match of code.matchAll(/\bsqliteTable\s*\(\s*["']mastra_/g)) {
    add(file, code, match.index, "Drizzle declares a `mastra_` table.",
      "Mastra owns `mastra_*`; a drizzle migration over it would fight Mastra's own (invariant 4).");
  }
}

report("C9 the invariants a line of text can break", findings);
