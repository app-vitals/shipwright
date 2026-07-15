# Test Speed Baseline (T-002)

> First real per-layer timing measurement for the test-readiness pipeline. Replaces
> "not measured" placeholders with actual wall-clock numbers, measured against the
> per-component speed budgets defined in [`test-system.md`](./test-system.md).

**Note on sourcing:** the task that filed this measurement referenced
`test-inventory.md#t-002`, `test-migration.md#net-new`, and
`test-readiness-plan.md#5-task-list`. As of this measurement, only
`test-inventory.md` and `test-system.md` exist on `main` — `test-migration.md` and
`test-readiness-plan.md` (and their "Section 3 speed-delta table") do not. This doc
stands alone rather than filling in a table that doesn't exist yet; once
`test-readiness-plan.md` lands, its Section 3 can point here or copy these numbers in.

## Methodology

- **unit / integration / smoke / content** — measured locally via
  `bun test --coverage`, scoped per package and per layer using the `*.unit.test.ts` /
  `*.integration.test.ts` / `*.smoke.test.ts` / `*.content.test.ts` naming convention
  (see "Layer definitions" in `test-system.md`). Each cell below is a real `time`-wrapped
  run, not an estimate.
- **e2e** — Playwright cannot launch headless Chromium in this agent's sandbox
  (missing system shared libraries, no root to install them), so e2e timing was not
  measured locally. Instead it's pulled from the per-step timing of a recent green CI
  run on `main`: [run 29412708469](https://github.com/app-vitals/shipwright/actions/runs/29412708469)
  (2026-07-15T11:44:46Z, commit `093e9223`), reading each job's "Run e2e tests" /
  "Playwright smoke" step duration directly from the Actions API — this excludes
  browser-install and dependency-install overhead bundled into the same CI job.
- Some **integration** tests are DB-backed and skip automatically when
  `DATABASE_URL_ADMIN_TEST` / `DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST` are unset (no
  Postgres in this sandbox) — skip counts are noted per row. This does not affect the
  measured wall-clock of the tests that did run.

## Section 3: Speed-delta table

### Plugin (`@shipwright/plugin`)

| Layer | Command | Measured | Suite target | Status |
|---|---|---|---|---|
| unit | `bun test --coverage <25 *.unit.test.ts files>` | 1.12s (476 tests / 25 files) | <15s | ✅ within budget |
| integration | `bun test --coverage <1 *.integration.test.ts file>` | 0.15s (6 tests / 1 file) | <30s | ✅ within budget |
| content | `bun test --coverage <12 *.content.test.ts files>` | 0.68s (241 tests / 12 files) | <15s | ✅ within budget |

### Metrics dashboard (`@shipwright/metrics`)

| Layer | Command | Measured | Suite target | Status |
|---|---|---|---|---|
| unit | `bun test --coverage <8 *.unit.test.ts files>` | 1.05s (195 tests / 8 files) | <15s | ✅ within budget |
| integration | `bun test --coverage <5 *.integration.test.ts files>` | 4.93s (72 tests / 5 files) | <30s | ✅ within budget |
| smoke | `bun test --coverage <5 *.smoke.test.ts files>` | 4.62s (45 tests / 5 files) | <30s | ✅ within budget |
| e2e | CI job "e2e (metrics dashboard)", step "Run e2e tests" | 23s | not yet budgeted | — |

### Shipwright agent (`@shipwright/agent`)

| Layer | Command | Measured | Suite target | Status |
|---|---|---|---|---|
| unit | `bun test --coverage <24 *.unit.test.ts files>` | 1.77s (454 tests / 24 files) | <15s | ✅ within budget |
| integration | `bun test --coverage <16 *.integration.test.ts files>` | 5.35s (468 tests / 16 files, DB-gated cases skip without Postgres) | <30s | ✅ within budget |
| smoke | (no smoke-layer tests in this package yet) | — | <30s | n/a |

### Admin UI (`@shipwright/admin`)

Not yet formally documented in `test-system.md`'s per-component tables, but measured
here for completeness since it carries real unit/integration/smoke/e2e layers today.

| Layer | Command | Measured | Suite target (assumed same as agent/metrics) | Status |
|---|---|---|---|---|
| unit | `bun test --coverage <19 *.unit.test.ts files>` | 2.50s (705 tests / 19 files) | <15s | ✅ within budget |
| integration | `bun test --coverage <17 *.integration.test.ts files>` | 1.50s (111 pass, 158 skip — DB-gated, no Postgres in sandbox) | <30s | ✅ within budget |
| smoke | `bun test --coverage <12 *.smoke.test.ts files>` | 3.24s (349 tests / 12 files) | <30s | ✅ within budget |
| e2e | CI job "e2e (admin UI)", step "Run e2e tests" | 4s | not yet budgeted | — |

### Site (`site/`)

| Layer | Command | Measured | Suite target | Status |
|---|---|---|---|---|
| e2e (Playwright smoke) | CI job "site build / brand-lint / smoke", step "Playwright smoke" | 40s | not yet budgeted | — |

## Full suite

Verification command run at the repo root, exactly as specified in the T-002 task:

```
$ NODE_ENV=test bun test --coverage --coverage-reporter=lcov 2>&1 | tail -20

 3842 pass
 242 skip
 0 fail
 5 snapshots, 7873 expect() calls
Ran 4084 tests across 198 files. [34.23s]
```

34.23s wall-clock, well within the `<2 min` full-suite budget documented in
`test-system.md`. The 242 skips are the DB-gated agent/admin/task-store integration
tests noted above — expected in a sandbox with no Postgres, not a regression.

## Summary

Every measured layer across plugin, metrics, agent, and admin is comfortably within
the speed budgets `test-system.md` already defines for it. The only rows without a
target are e2e (no documented per-layer budget yet, since e2e was added after
`test-system.md`'s Phase B commitment) and site (not yet covered by the per-component
table at all) — both are real numbers now, ready to seed a budget once one is proposed.
