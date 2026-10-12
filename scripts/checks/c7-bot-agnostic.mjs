/**
 * C7 — the code written once for every bot names no bot.
 *
 * Each bot used to be four copied files, and the copies drifted: a fix to one registrar did not
 * reach the other (audit F3). Slices 4+5 wrote the shared half once — the transport, the
 * registrar, the command runner, the agent builder, the routing — against a bot's definition. The
 * day one of those files says `if (bot.id === 'joob')`, or imports Joob's tabs, it is a copy again
 * in all but name. This check keeps the shared half shared:
 *
 *   A bot's name — any identifier or string starting with it, any case, so `newyTelegram`,
 *   `JOOB_TOPICS` and `'joob'` alike — does not appear in the code of a shared layer: `src/services/`,
 *   `src/db/`, `src/lib/`, `src/config/`, and the bot-agnostic files in `src/mastra/` listed below.
 *
 * **The bot names are the file names in `src/bots/`**, `index.ts` aside — a bot *is* a file there,
 * so a third one is covered the moment it exists, with nothing to add here.
 *
 * Comments are exempt: explaining a rule with Newy as the example is documentation, not a branch.
 * Tests are exempt: a test of the transport has to build it for some bot. Everything a bot owns —
 * its workflows, its commands, its agent, its tools — is outside the scope on purpose; those name
 * their bot by design (04-BLUEPRINT Part 1: a bot brings "its commands and its workflows").
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { lineAt, listFiles, relative, report, ROOT, stripCommentsAndStrings } from "./_lib.mjs";

const SHARED_DIRS = ["src/services", "src/db", "src/lib", "src/config"];
const SHARED_FILES = [
  "src/mastra/registrar.ts",
  "src/mastra/chat-surface.ts",
  "src/mastra/quoted-message.ts",
  "src/mastra/commands/command.ts",
  "src/mastra/agents/chat-agent.ts",
];

const isTest = (file) => file.includes("/__tests__/") || /\.test\.ts$/.test(file);

const botsDir = path.join(ROOT, "src", "bots");
const bots = existsSync(botsDir)
  ? readdirSync(botsDir)
      .filter((entry) => entry.endsWith(".ts") && entry !== "index.ts")
      .map((entry) => entry.slice(0, -".ts".length))
  : [];

const findings = [];

if (bots.length > 0) {
  const name = new RegExp(`\\b(${bots.join("|")})\\w*`, "gi");
  const files = [
    ...SHARED_DIRS.flatMap((dir) => listFiles(path.join(ROOT, dir), [".ts"])),
    ...SHARED_FILES.map((file) => path.join(ROOT, file)).filter((file) => existsSync(file)),
  ];

  for (const absolute of files) {
    const file = relative(absolute);
    if (isTest(file)) continue;

    const code = stripCommentsAndStrings(readFileSync(absolute, "utf8"), { keepStrings: true });
    for (const match of code.matchAll(name)) {
      findings.push({
        file,
        line: lineAt(code, match.index),
        message: `\`${match[0]}\` names a bot in code written once for every bot.`,
        fix:
          "Take the bot as an argument (a BotDefinition or a BotSurface) instead of naming it. " +
          "If the code is genuinely one bot's, it belongs with that bot — src/bots/, its agent, its commands.",
      });
    }
  }
}

report("C7 the code shared by every bot names no bot", findings);
