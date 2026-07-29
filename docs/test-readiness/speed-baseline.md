# Test Speed Baseline (T-002)

> First real per-layer timing measurement for the test-readiness pipeline. Replaces
> "not measured" placeholders with actual wall-clock numbers, measured against the
> per-component speed budgets defined in [`test-system.md`](./test-system.md).

**Note on sourcing:** the task that filed this measurement referenced
`test-inventory.md#t-002`, `test-migration.md#net-new`, and
`test-readiness-plan.md#5-task-list`. As of this measurement, only `naming.md` and
`test-system.md` exist under `docs/test-readiness/` on `main` — `test-inventory.md`,
`test-migration.md`, and `test-readiness-plan.md` (and the latter's "Section 3
speed-delta table") do not. This doc stands alone rather than filling in a table that
doesn't exist yet; once `test-readiness-plan.md` lands, its Section 3 can point here
or copy these numbers in.

## Aggregate (Tier 1)

Per the two-tier measurement model in
[`speed-budgets/SKILL.md`](../../plugins/shipwright/skills/speed-budgets/SKILL.md#two-tier-measurement-model),
this is the primary, continuously-tracked number — pulled fresh from the most recent
green run of the `lint / typecheck / test` CI job, the same way this doc's e2e/site
rows below source their numbers from CI:

- **Run:** [30415213982](https://github.com/app-vitals/shipwright/actions/runs/30415213982)
  (2026-07-29T01:50:45Z), commit `1a6a085d0ccb91db5c29f0899b686c21dd060ece`
- **Job wall-clock:** 2m01s (`lint / typecheck / test`, 01:50:59Z–01:53:00Z) — of which
  the `Test` step (`task test:coverage`) itself ran 35.82s
- **Tests:** 5762 pass / 1 skip / 0 fail — 5763 tests across 258 files
- **vs. budget:** 2m01s against the <15 min Full-PR-pipeline budget — **13% of budget,
  well within.** The escalation formula (aggregate wall-clock >7.5 min, sustained across
  2 consecutive measurements) is nowhere near tripped, so no Tier 2 re-measurement is
  warranted by this reading.

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

## Section 3: Speed-delta table — Tier-2 breakdown

**Last produced 2026-07-15.** This is the conditional per-package/per-layer breakdown
from the two-tier model — it does not refresh on a fixed cadence. Per
[`speed-budgets/SKILL.md`](../../plugins/shipwright/skills/speed-budgets/SKILL.md#two-tier-measurement-model)'s
escalation formula, it is only re-produced when the Tier 1 aggregate above trips the
escalation trigger (wall-clock >7.5 min, sustained across 2 consecutive measurements).
The Tier 1 aggregate is currently at 13% of budget, nowhere near that trigger, so this
table remains supplementary/on-demand context rather than something requiring
perpetual refreshing.

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
| e2e | CI job "e2e (metrics dashboard)", step "Run e2e tests" | 23s | <5 min (E2E suite target, `test-system.md`) | ✅ within budget |

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
| e2e | CI job "e2e (admin UI)", step "Run e2e tests" | 4s | <5 min (E2E suite target, `test-system.md`) | ✅ within budget |

### Site (`site/`)

| Layer | Command | Measured | Suite target | Status |
|---|---|---|---|---|
| e2e (Playwright smoke) | CI job "site build / brand-lint / smoke", step "Playwright smoke" | 40s | <5 min (E2E suite target, `test-system.md`) | ✅ within budget |

## Full suite

Superseded by the [Aggregate (Tier 1)](#aggregate-tier-1) section at the top of this
doc, which now carries the continuously-tracked full-suite number (pulled from live CI
against the current `<15 min` Full-PR-pipeline budget) in place of the one-off local
`bun test` run this section previously cited.

## Summary

Every measured layer across plugin, metrics, agent, admin, and site — including e2e —
is comfortably within the speed budgets `test-system.md` already defines. `test-system.md`'s
consolidated "Speed budgets" table documents an E2E budget (<30s per-test 95p, <90s hard
cap, <5 min suite target); all measured e2e rows above (metrics, admin, and site) fall
well within it. The one gap is per-component granularity: e2e and site aren't yet broken
out in `test-system.md`'s per-component tables the way plugin/metrics/agent/admin are, so
these numbers are checked against the consolidated E2E budget rather than a
component-specific one — worth formalizing once those tables are extended.
