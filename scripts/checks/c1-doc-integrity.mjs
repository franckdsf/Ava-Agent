/**
 * C1 — the documentation still points at things that exist.
 *
 * A doc is written when it is true, or when it is intended, and nothing re-reads it afterwards. An
 * agent told to read the docs before the code then writes against a file that was renamed, a script
 * that was dropped, or a heading that moved — with more confidence than if it had found nothing.
 * This is the re-read. It proves:
 *
 *   1. every relative link resolves — the file, and the heading anchor where one is given
 *   2. every `pnpm <script>` a doc tells you to run exists in package.json
 *   3. every repo path a doc names in backticks exists on disk
 *   4. every path an ADR's `applies_to` names exists — that frontmatter is how an agent and the
 *      invariant-reviewer decide which ADRs to read, so a dead entry silently unroutes a decision
 *
 * It cannot prove prose is true. It proves the doc is not pointing at a ghost.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { lineAt, relative, report, ROOT } from "./_lib.mjs";

const findings = [];

/**
 * Paths a doc names before they are built — a plan or a spec describing the shape a file must take
 * as it lands. Self-cleaning: once the file exists, part 5 fails until the entry is removed, so this
 * can only shrink, and a typo is still caught because a typo is not in here.
 */
const PLANNED = new Set([
  // What the refactor's blueprint becomes (docs/audit/README.md).
  "docs/ARCHITECTURE.md",
]);

/** pnpm's own commands, which a doc may name without them being scripts. */
const PNPM_BUILTINS = new Set([
  "install", "i", "add", "remove", "update", "dlx", "exec", "why", "outdated", "rebuild",
  "approve-builds", "store", "run", "list", "ls",
]);

/* ── Which files to check ─────────────────────────────────────────────────────────────── */

const markdownIn = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return markdownIn(full);
    return entry.endsWith(".md") ? [full] : [];
  });
};

const docs = [
  ...markdownIn(path.join(ROOT, "docs")),
  ...markdownIn(path.join(ROOT, ".claude", "agents")),
  ...["AGENTS.md", "CLAUDE.md", "README.md"].map((f) => path.join(ROOT, f)).filter(existsSync),
  ...markdownIn(path.join(ROOT, "src")),
];

const packageJson = path.join(ROOT, "package.json");
const scripts = new Set(
  existsSync(packageJson) ? Object.keys(JSON.parse(readFileSync(packageJson, "utf8")).scripts ?? {}) : [],
);

/** The YAML frontmatter of an ADR, as a tiny map of the two keys this check reads. */
const frontmatterOf = (text) => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return null;

  const field = (key) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(block[1])?.[1]?.trim() ?? "";
  const appliesTo = [...field("applies_to").matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  return { appliesTo, status: field("status").split(/\s/)[0] ?? "" };
};

/**
 * A superseded ADR is frozen, and frozen on purpose: it records a decision the project reversed,
 * so the files it governed may be gone and that is correct. Its links are still checked — those
 * point within this repo today — but its backticked paths and `applies_to` are history.
 */
const isFrozen = (text) => frontmatterOf(text)?.status === "superseded";

/**
 * GitHub lowercases, strips punctuation and hyphenates spaces without collapsing runs; other
 * renderers trim and collapse. Accept every variant so a correct anchor is never reported broken.
 */
const anchorsOf = (text) => {
  const out = new Set();
  for (const [, heading] of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const stripped = heading.toLowerCase().replace(/[^\w\s-]/g, "");
    for (const base of [stripped, stripped.trim()]) {
      out.add(base.replace(/\s/g, "-"));
      out.add(base.replace(/\s+/g, "-"));
    }
  }
  return out;
};

/**
 * Explicit anchors — `<a id="invariants"></a>` — which GitHub honours like a heading's. They are how
 * a heading gets renamed without breaking the links into it: the old slug stays as an anchor.
 */
const explicitAnchorsOf = (text) => new Set([...text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)].map((m) => m[1]));

const allAnchorsOf = (text) => new Set([...anchorsOf(text), ...explicitAnchorsOf(text)]);

const blank = (s) => s.replace(/[^\n]/g, " ");

/** Fenced blocks blanked — a link-shaped string inside one is code, not a link. */
const withoutFences = (text) => text.replace(/^```[\s\S]*?^```/gm, blank);

/** Inline code spans blanked too — `[title](item.link)` in backticks is code, not a link. */
const withoutCode = (text) => withoutFences(text).replace(/`[^`\n]+`/g, blank);

/**
 * Only the text a doc presents as a command: inline code spans and fenced blocks. "pnpm only" in a
 * sentence is prose; `pnpm only` in backticks is an instruction someone will paste.
 */
const codeOnly = (text) => {
  const spans = [...text.matchAll(/^```[\s\S]*?^```|`[^`\n]+`/gm)];
  let out = blank(text);
  for (const span of spans) out = out.slice(0, span.index) + span[0] + out.slice(span.index + span[0].length);
  return out;
};

/* ── 1 · 2 · 3 · 4 ────────────────────────────────────────────────────────────────────── */

for (const doc of docs) {
  const raw = readFileSync(doc, "utf8");
  const text = withoutCode(raw);
  const file = relative(doc);
  const isAdr = file.startsWith("docs/decisions/") && file !== "docs/decisions/README.md";
  // An audit document describes the repo at the commit it names, and is frozen once written
  // (docs/audit/README.md). Its paths belong to that commit; its links still point at today.
  const isAudit = /^audited_at:/m.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "");

  /* 1 — relative links resolve, including their anchors. */
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:)/.test(target)) continue;

    const [rel, anchor] = target.split("#");
    const at = { file, line: lineAt(text, match.index) };

    if (!rel) {
      if (anchor && !allAnchorsOf(raw).has(anchor)) {
        findings.push({
          ...at,
          message: `Anchor "#${anchor}" does not match any heading in this file.`,
          fix: "The heading was renamed or removed — update the anchor.",
        });
      }
      continue;
    }

    const resolved = path.resolve(path.dirname(doc), decodeURIComponent(rel).replace(/\\_/g, "_"));

    if (!existsSync(resolved)) {
      findings.push({
        ...at,
        message: `Link target does not exist: ${target}`,
        fix: "Fix the path, or delete the link if what it described is gone.",
      });
      continue;
    }

    if (anchor && resolved.endsWith(".md") && !allAnchorsOf(readFileSync(resolved, "utf8")).has(anchor)) {
      findings.push({
        ...at,
        message: `Link anchor does not exist: ${target}`,
        fix: "The heading was renamed or removed — update the anchor.",
      });
    }
  }

  /* 2 — every `pnpm <script>` a doc tells you to run is real. */
  const commands = codeOnly(raw);
  for (const match of commands.matchAll(/\bpnpm (?:run )?([a-z][a-z0-9:-]*)\b/g)) {
    const script = match[1];
    if (scripts.has(script) || PNPM_BUILTINS.has(script)) continue;

    findings.push({
      file,
      line: lineAt(commands, match.index),
      message: `Doc tells you to run "pnpm ${script}", which is not a script in package.json.`,
      fix: "Add the script, or correct the doc.",
    });
  }

  /* 3 — backticked repo paths exist. Only paths with an extension: a directory or a glob is a
         statement about where things go, not a claim that a file exists today.

         Not in an ADR's body. An accepted ADR is never rewritten, so the paths it names are the
         paths of the day it was decided — `src/mastra/agents/ava.ts` in the ADR that renamed it is
         correct history. What routes an agent to an ADR is its frontmatter, which part 4 checks. */
  const prose = withoutFences(raw);
  for (const match of isAdr || isAudit ? [] : prose.matchAll(/`((?:src|scripts|docs|drizzle|\.claude|\.githooks)\/[\w./-]+)`/g)) {
    const target = match[1];
    if (target.includes("*") || target.endsWith("/") || !path.extname(target)) continue;
    if (existsSync(path.join(ROOT, target)) || PLANNED.has(target)) continue;

    findings.push({
      file,
      line: lineAt(prose, match.index),
      message: `Doc references \`${target}\`, which does not exist.`,
      fix:
        "Correct the path, or — if the doc names it deliberately before it is built — add it to " +
        "PLANNED in scripts/checks/c1-doc-integrity.mjs.",
    });
  }

  /* 4 — an ADR's applies_to names paths that exist. A glob is checked up to its first wildcard:
         `src/mastra/workflows/**` needs `src/mastra/workflows/` to exist, which is what routes it. */
  if (!isAdr || isFrozen(raw)) continue;

  for (const entry of frontmatterOf(raw)?.appliesTo ?? []) {
    const literal = entry.split(/[*{]/)[0] ?? "";
    if (!literal) continue; // `**` — governs everything, nothing to resolve.
    if (existsSync(path.join(ROOT, literal))) continue;

    findings.push({
      file,
      line: lineAt(raw, raw.indexOf(entry)),
      message: `applies_to names "${entry}", and "${literal}" does not exist.`,
      fix:
        "An agent touching the file that replaced it will never be routed to this ADR. Point " +
        "applies_to at where the code lives now — that is frontmatter, not the decision, so " +
        "correcting it is not rewriting the ADR.",
    });
  }
}

/* ── 5. PLANNED only ever shrinks ─────────────────────────────────────────────────────── */

for (const planned of PLANNED) {
  if (!existsSync(path.join(ROOT, planned))) continue;

  findings.push({
    file: "scripts/checks/c1-doc-integrity.mjs",
    message: `"${planned}" now exists but is still listed as PLANNED.`,
    fix: "Remove it from PLANNED — it is a real path now, and should be checked like one.",
  });
}

report("C1 documentation points at things that exist", findings);
