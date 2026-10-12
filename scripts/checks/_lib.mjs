/**
 * Shared by the architectural checks in this folder (C1–C4, run by `pnpm verify`).
 *
 * Every check is a top-level script that prints its findings and exits 1 when there are any. They
 * read source as text, never through TypeScript's compiler API: TypeScript 7 ships a native binary
 * and no JS API (`require("typescript").createSourceFile` is undefined), so a check built on the AST
 * would crash on import. Text is enough for what these assert — import specifiers, a call name, an
 * empty block — and keeps the checks free of any dependency that can move under them.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The tree a check runs against — this repo, unless CHECK_ROOT overrides it.
 *
 * The override is what makes the checks testable. They end in `process.exit`, so a test cannot
 * import one and inspect its findings; it runs the real script against a fixture tree and reads the
 * exit code. Without it the only tree a check could run against is this repo, where the violations
 * it hunts do not exist by definition.
 */
export const ROOT = process.env.CHECK_ROOT
  ? path.resolve(process.env.CHECK_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const IGNORED_DIRS = new Set(["node_modules", ".git", ".history", ".mastra", ".data", "dist"]);

/** All files under `dir` whose name ends in one of `exts`, recursively. Absolute paths. */
export const listFiles = (dir, exts = [".ts"]) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // The directory does not exist — nothing to check, not an error.
  }

  return entries.flatMap((entry) => {
    if (IGNORED_DIRS.has(entry)) return [];
    // Worktrees other sessions open inside the repo are full copies of the tree.
    if (entry === "worktrees" && path.basename(dir) === ".claude") return [];
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return listFiles(full, exts);
    return exts.some((ext) => entry.endsWith(ext)) ? [full] : [];
  });
};

/** Repo-relative, forward slashes — the form every finding is printed in. */
export const relative = (file) => path.relative(ROOT, file).split(path.sep).join("/");

export const lineAt = (text, index) => text.slice(0, index).split("\n").length;

/**
 * `text` with every comment and string body blanked to spaces, newlines kept.
 *
 * Offsets and line numbers survive, so a match found in the stripped text points at the right line
 * of the original. Without it a check reads its own pattern inside a comment explaining the rule —
 * `process.cwd()` in a doc comment — as a violation. A template literal's text is blanked and its
 * `${…}` expressions are scanned as code, nesting included: `src/mastra/commands/beats.ts` writes
 * `` `${xs.map(x => `\`${x}\``)}` ``, and a scanner that ends a template at the next backtick reads
 * the rest of that file inside-out.
 *
 * `keepStrings` leaves string bodies intact and blanks comments only — for C2, whose input IS the
 * import specifier, and which must still skip an import written inside a comment. `keepComments`
 * is the mirror — for C4, where a catch holding only a comment is the allowed shape.
 *
 * Regex literals are blanked always. They have to be recognised at all because a quote or backtick
 * inside one would otherwise open a string: `src/services/telegram.ts` escapes markdown with
 * `/[\\`*_[\]<>~|]/`, and before this the backtick in it blanked the next two hundred lines — C4
 * then reported that file clean while it held a swallowed promise.
 *
 * @limitation A `/` is read as a regex when the code before it cannot end an expression — an
 * operator, an opening bracket, a keyword such as `return`. **Accepted because** that is the rule
 * the language itself uses, and the one case it misreads — a regex directly after `)`, as in
 * `if (x) /re/.test(y)` — appears nowhere in this repo. **The fix** is a real tokenizer, which is
 * what the compiler API was before TypeScript 7 removed it.
 */
export const stripCommentsAndStrings = (text, { keepStrings = false, keepComments = false } = {}) => {
  let out = "";
  let i = 0;
  /** The last character of real code — comments, strings and whitespace excluded. */
  let prev = "";
  let prevAt = -1;

  const blank = (from, to) => {
    out += text.slice(from, to).replace(/[^\n]/g, " ");
  };
  const comment = (from, to) => (keepComments ? (out += text.slice(from, to)) : blank(from, to));

  const REGEX_AFTER_CHAR = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
  const REGEX_AFTER_WORD = /\b(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

  const startsRegex = () => {
    if (prev === "" || REGEX_AFTER_CHAR.has(prev)) return true;
    return /[\w$]/.test(prev) && REGEX_AFTER_WORD.test(text.slice(Math.max(0, prevAt - 10), prevAt + 1));
  };

  /** One entry per open `${…}`: the depth of `{` opened inside it, so its own `}` is told apart. */
  const templates = [];

  /** Template text from `i` up to the closing backtick or the next `${`, which it then enters. */
  const templateText = () => {
    let j = i;
    while (j < text.length && text[j] !== "`" && !(text[j] === "$" && text[j + 1] === "{")) {
      if (text[j] === "\\") j++;
      j++;
    }
    j = Math.min(j, text.length);
    if (keepStrings) out += text.slice(i, j);
    else blank(i, j);

    if (j >= text.length) {
      i = text.length;
    } else if (text[j] === "`") {
      out += "`";
      prev = "`";
      prevAt = j;
      i = j + 1;
    } else {
      out += "${";
      templates.push(0);
      prev = "{";
      prevAt = j + 1;
      i = j + 2;
    }
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (templates.length > 0 && (ch === "{" || ch === "}")) {
      const top = templates.length - 1;
      if (ch === "}" && templates[top] === 0) {
        templates.pop();
        out += "}";
        i++;
        templateText();
        continue;
      }
      templates[top] += ch === "{" ? 1 : -1;
    }

    if (ch === "/" && next !== "/" && next !== "*" && startsRegex()) {
      // Scan to the closing `/`: a `/` inside a character class or after a backslash does not
      // close it, and a regex never spans a line — hitting one means this was division after all.
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) break;
        j++;
      }
      if (text[j] === "/") {
        out += "/";
        blank(i + 1, j);
        out += "/";
        i = j + 1;
        prev = "/";
        prevAt = j;
        continue;
      }
    }

    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      comment(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      comment(i, stop);
      i = stop;
    } else if (ch === "`") {
      out += "`";
      i++;
      templateText();
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") j++;
        // An unterminated quoted string ends at its line rather than eating the file.
        if (text[j] === "\n") break;
        j++;
      }
      const stop = Math.min(j + 1, text.length);
      if (keepStrings) {
        out += text.slice(i, stop);
      } else {
        out += ch;
        blank(i + 1, stop - 1);
        out += stop - 1 > i ? text[stop - 1] : "";
      }
      prev = ch;
      prevAt = stop - 1;
      i = stop;
    } else {
      out += ch;
      if (!/\s/.test(ch)) {
        prev = ch;
        prevAt = i;
      }
      i++;
    }
  }

  return out;
};

/**
 * Prints findings and exits 1 if there are any. Every check reports through here so the output
 * shape is identical across them — the Stop hook and the test harness both rely on the ❌ banner to
 * tell a violation from a crash.
 */
export const report = (checkName, findings) => {
  if (findings.length === 0) {
    console.log(`✅ ${checkName}`);
    return;
  }

  console.error(`\n❌ ${checkName} — ${findings.length} violation(s)\n`);
  for (const { file, line, message, fix } of findings) {
    console.error(`   ${file}${line ? `:${line}` : ""}`);
    console.error(`      ${message}`);
    if (fix) console.error(`      Fix: ${fix}`);
    console.error("");
  }
  process.exit(1);
};
