---
slice: tests-first
branch: main
status: active
---

> **Intent before implementation.** This file describes what we agreed to build, not what exists.
> If it disagrees with the repo, **the repo is right and this file should already be gone** —
> see [README.md](./README.md).

# Slice 1 — Tests first

After this lands, every commit runs the ~80 offline assertions that today run only when someone
remembers a script, plus tests for the two mechanisms slice 2 rewrites: the cycle claim and the
cadence it gates.

---

## 1. Problem

**What is broken or missing.** The catch-up decision table, the lead filters and the feed review's
verdict are covered by hand-rolled `check()` harnesses (`check-leads.ts` 49, `check-catchup.ts` 18,
`check-feed-review.ts` 13 — [audit F8](../audit/03-FLAWS.md)) that `pnpm verify` never runs. Slices
2–7 move exactly that logic. `claimCycle`'s release semantics and the leads cadence flaw
([F1](../audit/03-FLAWS.md)) have no test at all, so slice 2 could "fix" F1 with nothing showing it
was broken or that it is now fixed.

**How we would know it worked.**

- `pnpm test` collects every offline assertion the three scripts make — counted before and after,
  same number of cases, none edited.
- `pnpm verify` stays green; the F1 case is present and marked as a known failure (see decision 1).
- `pnpm catchup:check`, `pnpm review:check` and `pnpm leads:check` still exist and still pass — three
  frozen ADRs (0025, 0034, 0038) name them as their `verify:` command.

**Which invariant this sits closest to.** None directly. Invariant 6 (single replica) and
ADR-0034 are what the claim tests pin.

---

## 2. Architecture

**Schema** — none. **Workflows, agents, tools, commands** — none changed. **Telegram surface** —
none. **State a scheduled call may write** — none: nothing here is scheduled or calls a model.

**Test database.** The claim tests need a real SQLite: `claimCycle`'s correctness *is* the guarded
write. Each test file that needs one points `AVA_DATA_DB_URL` at a temp file and sets a dummy
`OPENROUTER_API_KEY` before importing `src/db/*` (env is parsed at import). `migrate()` builds the
schema from `drizzle/` as it does at boot. No network, no `.env`.

---

## 3. Program design

**Files created or changed:**

```
src/services/__tests__/lead-identity.test.ts       from check-leads: normalizeHost, platform hosts, signalId, sameCompany
src/services/__tests__/lead-filter.test.ts         from check-leads: filterLead
src/services/__tests__/lead-scout.test.ts          from check-leads: cleanCompanyName, cleanScoutText, parseEventDate
src/services/__tests__/lead-signals.test.ts        from check-leads: imageUrlsFrom, isNotACompanyHost
src/config/__tests__/leads.test.ts                 from check-leads: the leadScout cap is its own (ADR-0039)
src/mastra/workflows/__tests__/find-leads.test.ts  from check-leads: renderLeadMessage, the ack/answer ordering
src/mastra/__tests__/boot-catchup.test.ts          from check-catchup: the fixture half of decideCatchup
src/mastra/workflows/__tests__/review-feeds.test.ts from check-feed-review: the fixture half of verdictForBeat
src/db/__tests__/cycles.test.ts                    NEW: claim, refuse, release, late release, force
src/db/__tests__/cadence.test.ts                   NEW: F1 — fires × gate over simulated days, both pipelines

scripts/check-catchup.ts       keeps only "Live — what a boot right now would do"
scripts/check-feed-review.ts   keeps only "what a run today would do to the live beats"
scripts/check-leads.ts         deleted; `leads:check` becomes `vitest run` over the lead tests
package.json                   leads:check → vitest; catchup:check / review:check unchanged names
docs/COMMANDS.md               the three entries say what moved and what each script still proves
```

Each moved file lands beside its subject, per [CONVENTIONS §2](../CONVENTIONS.md#2-tests-). Exact
split of `check-leads.ts` follows its imports; any case that tests two subjects goes with the one
whose behaviour it names.

**The new cases:**

```
cycles.test.ts
  first claim on an empty table wins; a second within minGap is refused with lastStartedAt
  a claim past minGap wins
  release after a claim restores the previous stamp (and deletes the row on a fresh volume)
  release after a later run has claimed is a no-op — it does not hand that run's cycle away
  release twice is a no-op the second time
  force claims inside minGap and still stamps the row

cadence.test.ts — fake clock (vi.setSystemTime) through claimCycle with the real config
  jobs:  runHours × intervalHours, on-rhythm → a run every 24h
  jobs:  an off-rhythm run (15:00) → the next run within 48h
  leads: runHour × intervalHours, on-rhythm → a run every 48h
  leads: an off-rhythm run (15:00) → the next run within 48h        ← F1: today 66h
```

**Checks:**

```
pnpm test            all of the above
pnpm verify          before claiming any of it works
pnpm catchup:check   live half still prints, needs .env
pnpm review:check    live half still prints, needs .env
pnpm leads:check     = the lead tests, no .env
```

**Decisions I am least confident about:**

1. **How the F1 case lands while it is red.** AGENTS.md: a bug is pinned by a test *before* it is
   fixed, and verify must stay green. Proposed: `it.fails(...)` for the leads off-rhythm case — it
   passes while the bug exists and turns red the moment slice 2 fixes it, forcing slice 2 to flip
   it to `it(...)`. The alternative, asserting today's 66h, pins the bug as the spec.
2. **`leads:check` becomes a vitest alias rather than being deleted.** Keeps ADR-0038's `verify:`
   line true without editing a frozen ADR. Cost: one script name that no longer names a script.
3. **Cadence tests drive `claimCycle` against a temp database rather than a pure simulator.** Slower
   (milliseconds per fire, ~60 fires) but it tests the real gate rather than my model of it. Slice 2's
   kit may extract a pure function; the test then targets that.

---

## 4. Slices

```
1. move check-leads.ts into its six test files;  leads:check → vitest     → count matches, script gone
2. move the fixture halves of check-catchup / check-feed-review           → live halves still print
3. cycles.test.ts against a temp database                                 → the claim is pinned
4. cadence.test.ts, with the leads off-rhythm case as it.fails            → F1 is visible in verify
5. COMMANDS.md updated                                                    → docs say where each case went
```

One commit per step; `pnpm verify` green on each.

---

## Landing

- [ ] `pnpm verify` green
- [ ] Assertion count before (80) and after recorded in the commit body
- [ ] `pnpm catchup:check` and `pnpm review:check` run with `.env`, output read
- [ ] `invariant-reviewer` spawned and clean, or its findings approved
- [ ] **This file deleted**
