# Conventions — the enforceable rulebook

Read before writing a file. The imperatives live in [AGENTS.md](../AGENTS.md); the reasons in
[decisions/](decisions/README.md). This file says **which of those rules a machine holds, and which
only a reader does** — because that is the difference between a rule and a hope.

**Every rule carries an enforcement tag.**

| Tag | Meaning |
| --- | --- |
| 🔬 **TYPE** | `pnpm typecheck` makes the violation an error |
| 🧪 **TEST** | a test under `__tests__/` asserts it, in `pnpm test` |
| 📐 **SCRIPT** | a rule check — C1–C11 — in `pnpm verify:rules` |
| 🔒 **HOOK** | a git hook refuses the commit |
| 👁 **REVIEW** | judgement — the invariant-reviewer and you. A guideline, and it will drift |
| ⏳ | 👁 today, mechanisable, and a candidate for the refactor ([§1](#1-rule-to-mechanism-map)) |

**A rule with no tag does not exist.** If it cannot be tagged, write it as 👁 and accept that it will
drift. Writing it in bold and treating it as binding is how documentation becomes untrustworthy while
the code drifts underneath it — the failure the boilerplate this repo's tooling comes from was built
against ([audit/](audit/README.md)).

`pnpm verify` runs everything mechanical: typecheck, C1–C11, the tests. It runs in two places: on
demand, and in the `pre-commit` / `pre-merge-commit` hooks, so a failing commit cannot be created.
**There is no CI** — this repo has no remote yet — so a `--no-verify` commit is caught by nothing.
A third place is advisory: the `Stop` hook in `.claude/` runs the same C checks against the working set at the
end of an agent turn. **Adding a check means adding it there too**; nothing links the two lists.

---

## 1. Rule-to-mechanism map

Every Never rule in AGENTS.md — under the nine numbered invariants and in the domain rules after
them — and the patterns stated beside them, with what holds it.

**The point of this table is the 👁 column.** Before this file, every rule here was 👁. A ⏳ marks one
where a check could assert it from the source alone, and is the backlog for the refactor; a bare 👁
needs a judgement no script can make, and is settled.

| Rule | Held by |
| --- | --- |
| Docs, ADR `applies_to`, and `pnpm` commands point at things that exist | 📐 C1 |
| No import cycles | 📐 C2 |
| No path in `src/` resolved against cwd — `resolveFromRoot()` | 📐 C3 |
| No error swallowed silently — empty `catch {}`, `.catch(() => {})` | 📐 C4 (a ratchet: [§3](#3-known-debt--baselines)) |
| An agent is built only in `src/mastra/agents/`, and a model is asked only through `structured()`, its `attempts` written at the call site | 📐 C5 |
| The database is read and written only in `src/db/` — no `drizzle-orm`, `db()` or table outside it; `rawClient` only for Mastra's store | 📐 C6 |
| The code written once for every bot names no bot — a bot is a file in `src/bots/`, and the shared layers take it as an argument | 📐 C7 |
| A pipeline claims and schedules through `definePipeline` — no `claimCycle` outside the kit, every other `schedule:` marked `// C8: maintenance — <why>` | 📐 C8 |
| Commit titles open `(feat)` `(fix)` `(hotfix)` `(clean)` | 🔒 `commit-msg` |
| No AI-attribution trailer on a commit | 🔒 `commit-msg` |
| A branch other than `main` is `<type>/<kebab-summary>` | 🔒 `pre-commit` |
| `pnpm verify` is green before a commit exists | 🔒 `pre-commit`, `pre-merge-commit` |
| Env is validated at boot and names what is missing | 🧪 `src/config/__tests__/env.test.ts` — the core schema at import, a bot's when it is built, an empty value counted as missing |
| A pipeline's catch-up bar clears its healthy ceiling (gate + widest fire gap) | 🧪 `definePipeline` throws at load, so every test importing a pipeline fails and so does boot — every scheduled pipeline is on the kit |
| `pnpm db:generate` after a schema edit | 📐 C10 — the real `drizzle-kit generate` into a scratch copy of `drizzle/` writes nothing; the `SessionStart` hook still warns on mtimes, earlier |
| Never require an inbound port, tunnel or webhook | 📐 C9 — no `mode: 'auto'`/`'webhook'`, the agent's adapter says `mode: 'polling'`, every port in `docker-compose.yml` on `127.0.0.1` |
| Never give an outbound Telegram instance a `mode`, never `mode: 'auto'` | 📐 C9 |
| Never start `curateAll` from a conversation | 📐 C9 — no `curateAll` or `'curate-all'` in the code of `tools/` or `commands/` |
| Never write `lead_signals` from the jobs workflow | 📐 C9 — `find-jobs.ts` imports nothing from `db/leads` |
| Never let anything conversational write what a run produced | 📐 C11 — every `src/db/` function a tool, command, chat agent or `discover-feeds` imports is listed, each write beside why ADR-0043 allows it; the answer itself stays 👁 |
| Never let drizzle own `mastra_*` | 📐 C9 — no `mastra_` table in `src/db/schema.ts` |
| Never hand-write a migration `db:generate` can emit | 👁 — each hand-written one says why in its header |
| Never run two replicas | 📐 C9 — no `replicas:`/`scale:` in `docker-compose.yml` |
| Never commit `.history/` | 🔒 `.gitignore` |
| Never give a scheduled model call control flow it can choose | 👁 — a shape, not a call site ([ADR-0042](decisions/0042-a-scheduled-model-call-has-a-shape-not-a-list.md)) |
| Never correct a memory, a beat or a rubric — supersede it | 👁 |
| Never add a beat in code; never edit a seed to change one | 👁 |
| Never dedupe per-beat | 👁 |
| Never poll one bot token from two adapters | 👁 |
| Never answer Newy outside the Chat tab; never mix traffic in a tab | 👁 |
| Never filter on a source's own tags; never let a skill decide a domain | 👁 |
| Never add an ATS host to `jobScout.excludedHosts` | 👁 |
| Never re-probe X/Twitter for a feed | 👁 |
| A failed model call leaves its batch untouched | 👁 — C5 makes `structured()` the only shape, so a failure is always `null` or a throw; whether a caller then settles its batch on `null` is still read |
| Tunables in `src/config/`, secrets in `.env` | 👁 |
| pnpm only | 👁 — `packageManager` pins it for Corepack, nothing refuses npm |

**Do not promote a tag ahead of its mechanism.** A 👁 claiming to be 📐 is worse than no rule: a
green `pnpm verify` then certifies something nobody checked.

---

## 2. Tests 🧪

**`__tests__/` beside the subject, and nowhere else.** `scripts/checks/c2-import-cycles.mjs` →
`scripts/checks/__tests__/c2-import-cycles.test.ts`. Given a path there is one legal place for its
test, so nobody needs an opinion. `vitest.config.ts` collects only that shape.

**A test runs offline.** Anything that reaches a feed, a model or Telegram is a `pnpm <thing>:check`
script, not a test: a test runs on every commit and costs nothing; a check costs money or a rate
limit and runs when a change warrants it ([COMMANDS.md](COMMANDS.md)). A hand-run test that must
sit beside its subject is `*.manual.test.ts`, which no automatic run collects.

**Existing tests are the specification.** A fix adds tests; it never edits an assertion to make
itself pass. The rule, and what to do when a fix turns a test red, is in
[AGENTS.md](../AGENTS.md#tests).

**A reported bug is pinned before it is fixed — the rule that broke, not the instance.** Write it
around what the reader saw: the message, the tab, the count. Assert the invariant ("a story is sent
once") over intermediate values. Watch it fail on the old code; a test only a revert can turn red
pins nothing. **A pin that lands before its fix is `it.fails`** — green while the bug exists, red
the moment it is fixed, which forces the fixer to make it a plain `it`. Its comment names the fix
that will flip it (`src/db/__tests__/cadence.test.ts`, F1).

**A test that needs a database has one, empty and its own.** `vitest.setup.ts` points both
databases at a fresh temp file per test file and sets a placeholder model key, so a test never
needs `.env` and can never reach `.data/ava.db`. Give each test its own row ids rather than
resetting tables.

Coverage targets are not a rule ([§5](#5-rules-deliberately-not-made)). What replaces them is
altitude: a pure function is tested against plain values, and a test that needs a database earns
it by asserting what only the database can show.

---

## 3. Known debt — baselines

A rule landing on a codebase that already breaks it has three honest options: fix every case first,
document it as 👁, or **ratchet**. A ratchet makes the rule binding for new code and lists the
existing cases as debt that may only shrink: more than the baseline fails (a new case), fewer fails
too until the entry is lowered — so a fix is recorded in the commit that makes it, and the list never
claims debt that is gone.

| Baseline | Rule | Cases at adoption |
| --- | --- | --- |
| `scripts/checks/c4-baseline.json` | no swallowed promise | 15, in 8 files — mostly best-effort Telegram notices |

**Never raise a baseline.** A new case is fixed or it does not land. Raising one is a decision that
the rule no longer holds — supersede it in writing instead.

---

## 4. Known limitations — `@limitation` 👁

**A known choice, taken with its downside and accepted**, is declared with an `@limitation` tag in
the doc comment of the code that makes it. It is not always a flaw; it is always deliberate.
`grep -rn "@limitation"` lists every one.

**Two kinds, told apart by their first words:**

- **a trade we would reverse if it got cheap** — carries the four parts below.
- **a design choice we mean to keep** — opens with `Design choice:`, so nobody reads it as waiting on
  a fix, and needs only what it costs and why.

```ts
/**
 * Strips comments and strings so a check reads only code.
 *
 * @limitation A `/` directly after `)` is read as division, so `if (x) /re/.test(y)` is misread.
 * **Accepted because** the shape appears nowhere in this repo. **Until fixed**, write the regex
 * on its own line. **The fix** is a real tokenizer.
 */
```

- **the downside**, from the outside — the first sentence, readable alone;
- **why it is accepted** — the cost of the alternative, or the worse failure it avoids;
- **the workaround** until it changes, if there is one;
- **the fix**, when known, so reversing it starts from a plan rather than a rediscovery.

**The tag goes last in the comment** — a TSDoc block tag runs until the next tag. **Pin it where you
can:** a test named `"limitation: …"` asserting today's accepted behaviour turns red the day someone
changes it, which makes the change a stated decision rather than a surprise.

---

## 5. Rules deliberately not made

So nobody re-litigates them, and the omissions read as decisions rather than oversights.

| Not a rule | Why |
| --- | --- |
| ESLint | `typescript-eslint` needs TypeScript's JS compiler API, and TypeScript 7 ships none — `require("typescript").createSourceFile` is `undefined` here. The rules worth having are C-scripts instead, reading source as text. Revisit when a TS-7-native linter exists. |
| Conventional Commits | This repo's history is `(feat) scope — subject`, 58 of 59 titles. The hook enforces what is, not a standard nothing here parses. |
| "No `word:` at the start of a body line" | The boilerplate refuses it because commitlint's parser reads such a line as a footer. Nothing here parses commit bodies, so the rule would cost without protecting anything. |
| A coverage target | Coverage targets produce tests that assert nothing. |
| A header comment on every file | Comment density matches the surrounding code — and this code is dense on purpose. |
