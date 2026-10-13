/**
 * C11 — a conversation reaches only the `src/db/` functions written down here.
 *
 * Invariant 8: what a conversation may write is decided by what reads it back
 * ([ADR-0043](../../docs/decisions/0043-what-a-conversation-may-write-is-decided-by-what-reads-it-back.md),
 * amended 2026-10-13). The ADR said no check could hold that, because "what reads this table back?"
 * is a judgement. That is still true — so this check does not make the judgement. It makes the
 * question **unavoidable**: every function a conversation imports from `src/db/` is listed below,
 * reads and writes alike, and a new one fails `pnpm verify` until someone adds it here, beside the
 * answer.
 *
 * "A conversation" is the code a person drives by typing: `src/mastra/tools/`, `src/mastra/commands/`,
 * the chat agents, and `discover-feeds`, the run `/follow` starts. Tests are exempt.
 *
 * Adding a **read** is routine. Adding a **write** means answering, in the comment beside it, which
 * ADR-0043 category its table is in — input to a future run, or read by no run — and that it is
 * additive: a write that destroys its own predecessor is refused whatever table it lands in.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { lineAt, listFiles, relative, report, ROOT, stripCommentsAndStrings } from "./_lib.mjs";

const READ = "read";

/** Module in `src/db/` → function → `read`, or why the write is allowed. */
const ALLOWED = {
  articles: {
    articleIdsFromFeed: READ,
    articlesByIds: READ,
    beatActivity: READ,
    deliveredArticles: READ,
    feedPerformance: READ,
    getArticle: READ,
    searchArticleIds: READ,
    topVerdictsForBeat: READ,
    verdictsForArticle: READ,
    verdictsForArticles: READ,
    linkToBeats: "an unscored link — input to the next ranking, insert-only (ADR-0043 amendment)",
  },
  beats: {
    activeBeats: READ,
    allBeats: READ,
    beatRevisionHistory: READ,
    feedsForBeats: READ,
    getBeat: READ,
    subscribedFeedUrls: READ,
    addBeatFeed: "beat_feeds — input to a future run",
    createBeat: "beats — input to a future run",
    removeBeatFeed: "beat_feeds — archives, never deletes",
    retuneBeat: "beats — supersedes the rubric, keeping it in beat_revisions",
    setBeatArchived: "beats — archives, never deletes",
  },
  feedback: {
    votes: READ,
  },
  feeds: {
    getFeedState: READ,
  },
  "job-searches": {
    activeSearches: READ,
    getSearch: READ,
    saveSearch: "job_searches — input to a future run",
    saveSuggestion: "job_searches — advice shown to the reader, input to nothing until they apply it",
    setSearchArchived: "job_searches — archives, never deletes",
  },
  leads: {
    activeProfiles: READ,
    allProfiles: READ,
    getProfile: READ,
    archiveProfile: "client_profiles — archives, never deletes",
    upsertProfile: "client_profiles — input to a future run",
  },
  memories: {
    searchMemories: READ,
    rememberFact: "memories — input to a future run, additive (ADR-0014)",
    forgetMemory: "memories — only a fact never true, or one the reader asks to erase (ADR-0014)",
  },
};

const CONVERSATIONAL_DIRS = ["src/mastra/tools/", "src/mastra/commands/"];
const CONVERSATIONAL_FILES = [
  "src/mastra/agents/newy.ts",
  "src/mastra/agents/joob.ts",
  "src/mastra/workflows/discover-feeds.ts",
];

const isTest = (file) => file.includes("/__tests__/") || /\.test\.ts$/.test(file);
const isConversational = (file) =>
  CONVERSATIONAL_FILES.includes(file) || CONVERSATIONAL_DIRS.some((dir) => file.startsWith(dir));

// The clause may not contain a quote, so a match cannot run on through an earlier import's
// specifier to reach a `db/` one.
const IMPORT = /\bimport\s+([^"']*?)\s+from\s+["']([^"']*\bdb\/([a-z-]+))(?:\.js)?["']/g;

const findings = [];

for (const absolute of listFiles(path.join(ROOT, "src"), [".ts"])) {
  const file = relative(absolute);
  if (isTest(file) || !isConversational(file)) continue;

  const code = stripCommentsAndStrings(readFileSync(absolute, "utf8"), { keepStrings: true });
  for (const match of code.matchAll(IMPORT)) {
    const [, clause, , module] = match;
    if (/^type\s/.test(clause) || module === "schema" || module === "types") continue;
    const braces = clause.match(/\{([\s\S]*)\}/);
    const names = braces
      ? braces[1].split(",").map((part) => part.trim()).filter((name) => name && !/^type\s/.test(name))
      : [];
    // A default or `* as db` import beside or instead of the braces is a name too.
    const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
    if (outside) names.push(outside);

    for (const raw of names) {
      const name = raw.split(/\s+as\s+/)[0].trim();
      if (ALLOWED[module]?.[name]) continue;
      findings.push({
        file,
        line: lineAt(code, match.index),
        message: `A conversation imports \`${name}\` from db/${module}, which C11 has not been told about.`,
        fix:
          "If it reads, add it to ALLOWED in scripts/checks/c11-conversational-writes.mjs as `READ`. If it " +
          "writes, answer first what reads the table back (ADR-0043) and write that answer beside it.",
      });
    }
  }
}

report("C11 a conversation reaches only the src/db/ functions written down", findings);
