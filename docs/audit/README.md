# Audit — the method the refactor starts from

This repo's rule tooling — the C-checks, the git hooks, the `Stop` hook, [CONVENTIONS.md](../CONVENTIONS.md)
— was imported from a production-ready boilerplate. That boilerplate was not designed from a blank
page: it was built from an **audit of the project before it**, written down in five documents and
then turned into an architecture. This folder is where the same audit of *this* repo gets written,
before the refactor changes anything.

**01–04 were written at `f6c2b89`.** They were derived by reading the code, in order, and the
refactor is planned from them — not from memory, and not from the existing docs. Start with
[04-BLUEPRINT.md](04-BLUEPRINT.md); it links back to the evidence.

---

## What the boilerplate's audit found

The predecessor's architecture was sound. **What failed was enforcement.** Every rule with a
mechanical backstop held perfectly; every rule that relied on discipline eroded, and the
documentation kept describing the intent rather than the result.

| Held | Why |
| --- | --- |
| UI isolated from the backend — 0 violations in 75 files | Compliance was the path of least resistance: everything a UI file needed was importable from the UI layer. |
| Auth wrappers centralised | One import gave you the user. Cheaper to comply than to bypass. |

| Eroded | Why |
| --- | --- |
| "Never import the generated server module" — 58 files broke it | A correct rule dropped after a misdiagnosis; 41 of the 58 had no legal alternative. |
| An export-naming contract — 22% broke it | A legitimate case had no sanctioned name, so people invented 26. |
| "i18n everywhere" — used in 1 file of 332 | Nothing enforced it. |

**Three lessons, which are the spine of everything imported here:**

1. **A rule is only as strong as the affordance behind it.** Before writing "never do X", verify that
   "always do Y" is possible for every case X covers. This repo's success story is
   `resolveFromRoot()`: the right path was one import away, so it held — and C3 now makes it the only path.
2. **Scope a constraint precisely before generalising from it.** "This import causes a cycle" and
   "nothing may import this" are different claims, and only the first was true.
3. **Without a mechanical check, nothing signals when a rule stops holding.** The 58 violations
   accumulated silently over months. The first run of C1 here found 42 dead references the same way.

## The five principles

| | Principle | In this repo |
| --- | --- | --- |
| P1 | A rule needs an affordance, or it will be broken | `resolveFromRoot()`, `withRetry`, `claimCycle()` |
| P2 | A rule needs a machine check, or it will decay | [CONVENTIONS §1](../CONVENTIONS.md#1-rule-to-mechanism-map) — most of the Never table is still 👁 |
| P3 | Make the safe path the only path — capability over convention | A delivery is claimed before it is sent ([ADR-0033](../decisions/0033-a-delivery-is-claimed-before-it-is-sent.md)) |
| P4 | Fail loudly at boot, never silently at runtime | `src/config/env.ts` throws on a missing variable |
| P5 | Documentation describes what is, not what was intended | C1 checks every link, path, script and `applies_to` |

---

## The documents, in order

Each is written into this folder. Each is derived **from the code**: behavioural claims anchored to
`file:line`, counts produced by a script and re-run at the end, claims about a dependency checked
against its installed source in `node_modules` — not its docs, and not memory.

| # | File | What it holds |
| --- | --- | --- |
| 01 | `01-EXTRACTION.md` | The architecture **as implemented**: layers, what calls what, where state lives, which conventions the code actually follows (often better than the written ones). No judgement yet. |
| 02 | `02-DIVERGENCE.md` | Every point where a doc — AGENTS.md, an ADR, a gotcha, a comment — contradicts the code. `D1…`, graded below. **This is why `docs/` gets rebuilt the way it does.** |
| 03 | `03-FLAWS.md` | Defects, `F1…`, each with evidence, the mechanism that produced it, and a fix written to be transplantable. |
| 04 | `04-BLUEPRINT.md` | The target architecture: layer contracts, the rule-to-mechanism map, and the build order. Becomes `docs/ARCHITECTURE.md` and the refactor's plans. |
| 05 | — | Not a file: the delta to [CONVENTIONS.md](../CONVENTIONS.md) and the ADRs the blueprint needs. |

**Severity, divergence** — 🔴 **Breaking**: following the doc produces code that fails or is wrong ·
🟠 **Misleading**: the doc describes something that does not exist · 🟡 **Stale**: wrong but harmless.

**Severity, flaws** — 🔴 **Critical**: loses or corrupts data, or sends what it must not · 🟠 **High**:
fails under realistic conditions · 🟡 **Medium**: degrades correctness or maintainability at scale ·
🔵 **Low**: hygiene.

**Downgrade in writing.** A finding that turns out latent, or a design question rather than a defect,
stays in the document with its downgrade and the reason — a finding that silently disappears reads
as one that was never checked.

**Divergence already found**, by C1 on its first run, as a start for 02: thirty ADR links into an
AGENTS.md heading that had been renamed; a gotcha sending readers to a README procedure the setup
wizard had deleted; an AGENTS.md header naming three nested `AGENTS.md` files that never existed;
`docs/COMMANDS.md` linking to an AGENTS.md section that no longer exists. All fixed in the commit
that added C1 — but each is a sample of a drift the audit should look for systematically.

---

## The build order this produces

From the boilerplate, unchanged, because it is what made the difference:

1. **Enforcement first.** Nothing after it is safe without it. *Done for C1–C4 and the hooks;* the
   ⏳ rows in [CONVENTIONS §1](../CONVENTIONS.md#1-rule-to-mechanism-map) are what remains.
2. **One vertical slice, through every layer** — schema, repository, service, workflow or tool, the
   Telegram surface — done to the blueprint. It becomes the template every later slice copies.
3. **Then replicate**, one slice at a time, each with a plan ([plans/](../plans/README.md)).

**Step 1 is not skippable, and step 2 is one slice, not four.** The predecessor built breadth-first
and got twenty dialects of the same architecture.

## When the refactor lands

These documents describe this repo at the commit they were audited against, and the refactor will
make them wrong — that is the point of it. So each opens with `audited_at: <commit>` frontmatter and
is then **frozen**: never updated to match the new code. C1 still checks their links but not their
backticked paths, which belong to the code as it was.

**One exception, decided 2026-10-13:** a slice may add an *As built (slice N):* note under the
part it landed, and correct a Part 7 check row with *Corrected when it landed:* — never rewrite the
audited text. No date: `git log --grep "slice N"` finds the commits, and with them when. Those notes record
where the build departed from the plan, and they are what
`docs/ARCHITECTURE.md` is assembled from. The blueprint's durable content moves to
`docs/ARCHITECTURE.md` and the ADRs; the rest stays as the evidence the new rules cite. An ADR saying
"this prevents F3" is checkable only while F3 is readable.
