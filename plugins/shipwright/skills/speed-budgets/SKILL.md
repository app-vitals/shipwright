---
name: speed-budgets
description: >
  Cross-cutting contract for the test-readiness pipeline. Specifies per-layer test speed budgets (unit / integration / smoke / E2E) as 95p targets, per-test hard caps, and per-layer suite-wall targets. Used by system-design as a Phase 2 output and by migration as a Phase 3 bucketing criterion — a test that violates its layer's hard cap is almost certainly mis-layered and goes to the `rebuild` bucket.
---

# speed-budgets skill

## Purpose

Encode speed as a first-class design constraint, not an emergent property. Slow tests are not run; tests not run are not coverage.

## The default budgets

| Layer | Per-test 95p target | Per-test hard cap | Full-layer suite target |
|---|---|---|---|
| Unit | <50 ms | <200 ms | <30 s |
| Integration | <2 s | <10 s | <3 min |
| Smoke | <5 s | <15 s | <30 s sequential / <60 s full |
| E2E | <30 s | <90 s | <10 min |
| Full PR pipeline | — | — | **<15 min** |
| Canary suite | — | — | **<60 s** |

A repo may tighten budgets in Phase 2 (`test-system.md`). It may never loosen them below these defaults — that's the point of "default."

**Source of truth:** the per-layer speed budgets below are this skill's own content, but the testing-domain principle that justifies them — `t6_layer_speed_mismatch` — lives in `references/principles.md`. Tests must sit in the correct speed tier; a test exceeding its layer's hard cap is at the wrong layer regardless of correctness. Treat `references/principles.md` as canonical.

## Rationale baked in

### Why speed = trust

The closer to the keystroke, the more trustworthy the validation:

- Unit suite <30s → runs on every save
- Layer suite <3min → runs before every commit
- Pipeline <15min → runs before every push
- Pipeline >20min → engineers route around it

Autonomous programming cannot tolerate "route around." The feedback loop must be tight enough that the agent gets a verdict in seconds, not minutes.

### Why speed flags mis-layered tests

A test's actual runtime is one of the most reliable signals of what layer it's doing:

- A "unit" test taking >200ms is almost certainly booting a framework, opening a DB connection, or doing I/O. It's integration in disguise.
- A "smoke" test taking >15s is doing E2E work — driving multi-step flows.
- A "unit" test taking 3 seconds is the canonical example of false-confidence coverage: it's slow because it touches real boundaries, but the assertion is at a level too high to actually validate them.

This is why **the hard cap is a guillotine**, not a guideline. A test exceeding its layer's hard cap fails the audit regardless of correctness — it's at the wrong layer.

### Why parallelization is prescribed, not assumed

A suite that hits its target only with 16-way parallelism but fails serially is fragile:
- CI may run with 2 workers, not 16
- Local re-run is often serial
- Flaky tests cascade differently under parallelism

Phase 2 must output the parallelization plan (worker count, sharding strategy). Per-test budgets stay tight so the suite hits its target without requiring heroic parallelism.

See `test-design/SKILL.md` Step 6 for the explicit threshold on when per-workspace matrix sharding (vs. one combined job per layer) is justified — the same proportionality question applies here: parallelism only pays off once its fixed overhead is outweighed by the wall-clock it saves.

## How other skills reference this

- **`test-inventory`** does not measure speed (no tests exist for some items). It only assigns layer.
- **`test-design`** copies the budget table into `test-system.md` and adds the parallelization plan.
- **`test-migration`** measures existing tests against the table. Hard-cap violation → `rebuild`. Soft 95p violation → `promote`.
- **`test-roadmap`** includes a mandatory **speed delta** section: current per-layer p95 vs. target.

## Measuring speed (for Phase 3)

If actually running the suite is feasible, capture per-test timings via the test runner's reporter:

- Vitest / Jest: `--reporter=json` or `--reporter=verbose`
- bun test: built-in timing output
- pytest: `--durations=0`
- Go: `go test -v` (per-test timing in output)

Aggregate to:
- Per-layer count and 95p
- Per-layer suite wall-time
- Top N slowest tests in each layer

These numbers populate the speed-delta section in Phase 4.

## Ongoing CI enforcement

Phase 3 audits speed once. Phase 5 cleans up the existing suite. But **new tests added after M5 can drift past hard caps with no signal** unless CI enforces the budgets continuously.

Add both layers:

### Suite-level enforcement (GitHub Actions)

Cap each layer job with `timeout-minutes`. A job that exceeds the cap fails, surfacing a drift violation immediately:

```yaml
jobs:
  test-unit:
    timeout-minutes: 3        # 30s budget + headroom for CI startup
    runs-on: ubuntu-latest
    steps:
      - run: bun test --coverage src/

  test-integration:
    timeout-minutes: 8        # 3min budget + headroom
    runs-on: ubuntu-latest

  test-e2e:
    timeout-minutes: 20       # 10min budget + headroom
    runs-on: ubuntu-latest
```

Headroom rule: set `timeout-minutes` to the layer's suite target × 1.5, rounded up to the nearest minute. This absorbs CI startup variance without masking real regressions.

### Per-test enforcement (test runner)

Configure the native runner's per-test timeout to match the layer's hard cap:

| Layer | Hard cap | Runner config |
|---|---|---|
| Unit | 200 ms | Vitest: `testTimeout: 200` · Jest: `testTimeout: 200` · bun test: `--timeout 200` |
| Integration | 10 s | Vitest: `testTimeout: 10000` · pytest: `--timeout=10` · Go: `go test -timeout=10s` |
| Smoke | 15 s | Same per runner |
| E2E | 90 s | Playwright: `timeout: 90000` in `playwright.config.ts` |

A per-test timeout failure is a mis-layered test signal, not a flakiness signal. Treat it like a lint error: fix the root cause, don't raise the cap.

## Anti-patterns

- **"Just run tests in parallel" as the answer to slow tests.** Parallelism reduces wall-time, not work. A 30-second "unit" test is 30 seconds of work no matter how many workers run alongside it. Fix the test.
- **"We need more powerful CI runners."** Sometimes true, but usually a smell. Faster runners don't fix mis-layered tests; they hide them.
- **Coverage > 90% with slow tests.** A coverage number doesn't tell you if the test ran today. Speed budgets are the precondition for coverage to be meaningful.
- **"Raise the timeout to make it pass."** Timeout failures indicate a layering violation. The fix is to move or rewrite the test, not to extend the budget.
