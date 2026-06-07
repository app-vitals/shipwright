# Postmortem — `test-readiness` v0.3.0, first real-world run

> **What this is.** The `test-readiness` plugin was run end-to-end against a real multi-service
> codebase for the first time, producing 43 GitHub issues (`T-001`…`T-043`) across 5 milestones.
> All shipped and closed. This document examines what the plugin got right, what it got wrong, and
> what to change — grounded in commit hashes, issue numbers, and the live CI config.
>
> **Status:** discovery only. No plugin changes were made; the recommendations are for a future revision.
>
> **Note on identifiers.** The target repo is referred to generically as "the app." Infra-specific
> secrets (cluster names, registry paths, identity-provider IDs) have been redacted to `<...>` since
> this plugin repo is public. Commit hashes and `T-` issue numbers are retained for traceability.

---

## Executive summary

The plugin's **intellectual model is sound** — the five-phase pipeline, the layer taxonomy, the
canonical-layer rule, and speed-as-a-bucketing-criterion all did real work and produced a traceable
artifact chain. The failures were not in *what to test* but in **how the work was packaged and how the
testing infrastructure was wired**:

| Area | Verdict | One-line diagnosis |
|---|---|---|
| Phase structure & taxonomy | ✅ Worked | Coherent, traceable, drove real cleanups |
| **Ticket sizing** | ❌ Broke | The sizing rule *flags* oversized tasks but never *splits* them |
| **Smoke tests** | ⚠️ Churned | Right model, but the runner/CI boundary was under-specified |
| **Canary deploys** | ❌ Fragile / likely still broken | No deploy→canary→promote contract; the gate has real holes |

Roughly **1 in 5 commits** in the execution window were corrective `fix` commits, plus reverts —
concentrated exactly in the sizing/smoke/canary areas below.

---

## What the plugin got right

1. **The five-phase shape held under real load.** Inventory → system design → migration → roadmap →
   publish produced a coherent artifact chain. Published issues link back to inventory / blueprint /
   migration anchors, so a developer picking up `T-029` could trace *why* it existed.
2. **The layer taxonomy + canonical-layer rule drove genuine cleanups.** `fe41a4e` (T-035) split
   mixed-layer tests into proper unit + integration files; `2ca2a87` (#1109) added explicit layer
   suffixes across the suite. "Lowest sufficient layer" is a rule people actually followed.
3. **Speed budgets as bucketing criteria** were applied, not just stated — `T-027` validated the
   canary suite under its 60s cap; `T-039` refreshed the speed report after cleanup (M5).
4. **Dependency-aware publish** (`ready` / `blocked` labels, milestone gating) sequenced the work in a
   sane order: infra first, critical-path coverage next, cleanup last.
5. **The repo-config pairing instinct is correct** — every CI-workflow task auto-pairs with a
   branch-protection task, and the guidance to *land the workflow, watch it green, then enforce* avoids
   the chicken-and-egg lockout.

---

## What broke

### A. Ticket sizing — the rule *flags* but never *splits*

The `test-roadmap` skill defines good criteria — independently deployable, single concern, ~1000-line
cap — but then instructs the agent to:

> *"Flag any tasks that violate these criteria in the Open risks section rather than silently producing
> an oversized task."*

**Flagging is not splitting.** The pipeline was explicitly permitted to emit a known-oversized ticket
as long as it noted the violation. So it did. Examples that shipped:

| Issue | Task | Scope that should have been split |
|---|---|---|
| `#991` | **T-028** — promote external integrations to recorded fixtures | **12 test files across 5 services**, 4 acceptance criteria. A mass refactor in one PR. |
| `#986` | **T-023** — wrap smoke suites with `runCanaryMode` | **6 services**, the same mutation repeated 6× under 4 generic criteria. |
| `#999` / `#1075` | **T-036** — audit single-page Playwright E2Es | **9 files across 5 services**, each needing an independent keep/delete/reclassify decision, but no per-file decision table. |
| `#988` | **T-025** — canary journey specs | **3 distinct journeys** (login, booking, time-entry) bundled under 2 generic criteria. |

This reveals **two failure modes the plugin doesn't distinguish**:

- **Wide refactors** (N files, one operation). The "single concern" rule is ambiguous — is "wrap 6
  services in a helper" *one* concern or *six*? As written, it reads as one, so the rule permits it.
- **Multi-decision audits** ("review N files, decide per file"). With no per-file acceptance criteria,
  "done" is unverifiable — you can't tell from the issue whether all 9 decisions were actually made.

### B. Smoke tests — right model, under-specified wiring

The smoke/canary *contract* is good: smoke proves the wire contract (full boot, single request);
canary reuses the same code via `TEST_TARGET_URL`. The breakage was all at the **runner / CI boundary**,
which the plugin leaves to the implementer.

1. **Test-runner file-discovery collisions.** Five separate fixes in `T-024` alone —
   `22fac9b`, `73a6987`, `d4ebce3`, `75a4229`, `3550e42` — existed only to stop `bun test` from
   picking up Playwright `.canary.ts` files and to keep coverage from scanning `e2e/`. The plugin
   never prescribes a naming convention **plus** the matching runner-exclusion config as an explicit
   task, so this was discovered the hard way.
2. **The smoke suite carried tests that can't run in canary.** `6fe7fcc` removed a web-server smoke
   test because it required a database secret (`DATABASE_URL_<svc>`) that the canary job doesn't have.
   Root cause: the **same `test:smoke` script** runs in two environments — PR CI (databases
   provisioned; the `test.yml` smoke job `needs: unit-integration`) and canary (no database at all,
   only `prisma generate`). Reusing one entry point across two environments is the bug.
3. **Prod-write paths reached canary specs.** `f85dcd2` had to strip canary branches that could write
   to production and reclassify handler tests duplicated from the integration layer. The plugin *states*
   canary must be read-only / self-cleaning but supplies **no verification or lint step**, so unsafe
   specs shipped and were caught later.

### C. Canary deploys — assembled, fragile, and likely still broken

The `repo-config` skill correctly says "canary is a deploy-gate, not a merge-gate" and covers branch
protection — but it gives **no contract or template for the deploy → canary → promote handoff**. So the
app hand-rolled it, and it broke repeatedly: **7 corrective commits**, including `contents:read` being
added *twice* by two different people (`a0ece4f`, `7a0ef62`) → a duplicate YAML key → a cleanup commit.

Beyond the historical churn, the *current* live config (read 2026-05-25) still carries real defects:

1. **`test:canary` reuses the local smoke script.**
   `test:canary = bun run test:smoke && playwright --project=canary-smoke`. The `test:smoke` half runs
   local smoke files inside the canary job, which provisions **no database**. It only works if *every*
   `.smoke.test.ts` short-circuits to canary mode when `TEST_TARGET_URL` is set. A single new smoke test
   that forgets the wrapper silently breaks canary → which blocks **all** prod promotion. This exact
   failure was already fixed once (`ac27967` removed smoke from canary) and then re-introduced — the
   repo is back in the fragile state.
2. **Silent `latest` fallback in promotion.** Both `canary.yml` and `promote.yml` fetch the `image-tag`
   artifact via `gh api … select(.name=="image-tag")`. If that fetch fails for any reason (artifact
   retention, naming, an API hiccup), `promote.yml` falls back to `IMAGE_TAG="latest"` with no guard —
   so the image promoted to prod may differ from the one canary just verified.
3. **A skipped job counts as success.** `promote.yml` triggers on the Canary `workflow_run` with
   `if: conclusion == 'success'`. But the canary *job* is itself guarded `if: deploy succeeded`. If the
   deploy fails, the canary job is **skipped**, the Canary workflow still concludes `success`, and
   promote can fire anyway — against the `latest` fallback. That's a promotion with no real canary run.
4. **`TEST_TARGET_URL` prod/staging ambiguity.** `canary.yml`'s own comment says it "runs against prod
   after every successful deploy," yet the only coherent gate semantics are: *deploy → staging; canary
   tests staging; promote ships that tag to prod.* If `TEST_TARGET_URL` actually points at prod, canary
   validates the **old** prod and promote then ships an unverified image. *(This one needs a human to
   confirm what the deploy job targets and what the secret resolves to — flagged, not asserted.)*

---

## Root-cause table

| # | Symptom | Root cause | Where the plugin let it through |
|---|---|---|---|
| 1 | Oversized PRs (12-file, 6-service tickets) | Sizing rule flags but doesn't split | `test-roadmap` "flag in Open risks" instruction |
| 2 | Unverifiable audit tickets | No per-item decision criteria | `test-roadmap` task template |
| 3 | 5 fixes for test-runner file pickup | No naming + exclusion-config task | `test-system-design` / `test-roadmap` (missing infra task) |
| 4 | Smoke test broke canary (missing DB secret) | One script reused across two environments | `canary-execution` assumes "same code" ⇒ "same entry point" |
| 5 | Prod-write paths in canary specs | No read-only enforcement | `canary-execution` states but doesn't verify the rule |
| 6 | Canary gate has fallback / skip holes | No deploy→canary→promote contract | `repo-config` covers branch protection, not the deploy chain |

---

## Recommended plugin changes (for a future revision)

1. **Sizing: split, don't flag.** In `test-roadmap`, replace "flag oversized tasks" with a deterministic
   split:
   - Hard cap of **one service (or one file) per task** for refactor/migration buckets; fan an
     N-service refactor into N child tasks under a parent.
   - Multi-decision audits must emit a **per-item decision row** (file → decision → criterion) or split
     per item.
   - Add an explicit note: *"single concern ≠ one operation repeated across N services."*
2. **Separate the canary entry point.** `test-system-design` should prescribe a **dedicated canary
   script / Playwright project** that never reuses the local `test:smoke` script in the canary job, and
   make *"the canary suite runs zero DB-dependent local tests"* an acceptance criterion.
3. **Make runner-discovery a first-class infra task.** Add a Milestone-1 task that establishes both the
   file-naming convention (`.canary.ts`, layer suffixes) **and** the runner-exclusion config (test-runner
   excludes, coverage excludes, Playwright `testMatch`). This single gap caused 5 fixes in `T-024`.
4. **Add a canary safety lint.** A verification step (acceptance criterion + suggested check) that
   asserts canary specs contain no writes / no prod-write branches — enforce read-only / self-cleaning
   instead of merely stating it.
5. **Ship a deploy→canary→promote reference contract.** `repo-config` should include reference wiring
   (or at minimum a checklist) covering: artifact handoff with a **non-empty-tag guard** (fail rather
   than fall back to `latest`); the skipped-job-success hole (promote must confirm canary actually
   *ran*, not just "didn't fail"); and an explicit rule that `TEST_TARGET_URL` is the freshly-deployed
   env (staging), not prod.
6. **Emit a churn metric.** Extend the `metrics` skill with a post-execution **corrective-commit ratio
   per milestone**. The ~21% fix-commit rate here would have been an early red flag that M3–M4 tickets
   were under-specified.

---

## Appendix

### A1. Corrective-commit timeline (sizing / smoke / canary)

| Commit | What it fixed | Area |
|---|---|---|
| `5651d38` | Reverted `T-003` factories — type mismatch + out-of-scope tests | scope |
| `cf83af6` | Add `--schema` flags to canary prisma generate | canary |
| `22fac9b` | Remove empty `extraHTTPHeaders` from Playwright config | smoke/runner |
| `73a6987` | Wrap canary tests in describe block; exclude `e2e/` from coverage | runner |
| `d4ebce3` | Exclude `e2e/` from the test runner via config | runner |
| `75a4229` | Rename to `.canary.ts` to avoid test-runner pickup | runner |
| `3550e42` | Remove unused baseURL; guard missing canary API key | canary |
| `a0ece4f` | Grant `contents:read` to canary workflow | canary |
| `7a0ef62` | Add `contents:read` (duplicate of the above) | canary |
| `ac27967` | Canary runs only prod-targeting suite, not local smoke | canary |
| `13f44e2` | Scope `test:canary` Playwright to canary projects only | canary |
| `6fe7fcc` | Remove smoke test needing a DB secret unavailable in canary | smoke |
| `7450469` | Remove canary journey tests; add smoke job | canary |
| `f85dcd2` | Strip prod-write canary paths; reclassify smoke suite | smoke/canary |

### A2. Oversized-ticket table

| Issue | Task | Files | Services | Acceptance criteria | Should have been |
|---|---|---|---|---|---|
| `#991` | T-028 | 12 | 5 | 4 | ~5 (per service) |
| `#986` | T-023 | 6 | 6 | 4 | 1 helper + 6 apply tasks |
| `#999` | T-036 | 9 | 5 | 4 | per-file decision rows or 9 micro-tasks |
| `#988` | T-025 | 3 | — | 2 | 3 (per journey) |

### A3. Sanitized live-config quotes (read 2026-05-25)

```jsonc
// package.json — one script, two environments
"test:smoke":  "bun test ./**/*.smoke.test.ts",
"test:canary": "bun run test:smoke && bunx playwright test --config playwright.config.ts --project=canary-smoke",
```

```yaml
# promote.yml — silent fallback + skipped-job-as-success gate
on:
  workflow_run:
    workflows: ["Canary"]
    types: [completed]
jobs:
  promote:
    if: github.event.workflow_run.conclusion == 'success'   # a skipped canary job still yields "success"
    steps:
      - name: Resolve image tag
        run: |
          # ... fetch image-tag artifact ...
          if [ -n "$ARTIFACT_ID" ]; then
            IMAGE_TAG=$(cat /tmp/image-tag.txt)
          else
            IMAGE_TAG="latest"          # <-- unguarded fallback: may differ from the canaried image
          fi
```
