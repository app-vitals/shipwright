---
name: test-migration
description: >
  Phase 3 of the test-readiness pipeline. Reconciles existing tests against the Phase 1 inventory and Phase 2 blueprint, bucketing each existing test and each inventory item into reuse / promote / rebuild / trim (redundant assertions) / net-new. Same bucketing applies to test infrastructure. Enforces the canonical-layer rule — a test whose assertions are already owned by a lower-layer test gets redundant assertions trimmed, not the test deleted. Writes `docs/test-readiness/test-migration.md`. Invoke when the `/test-migration` command runs.
---

# test-migration skill

## Purpose

Reconcile reality against the blueprint. Bucket every existing test and every inventory item.

## When invoked

By the `/test-migration` command. Requires both prior artifacts:
- `docs/test-readiness/test-inventory.md` (Phase 1)
- `docs/test-readiness/test-system.md` (Phase 2)

## The five buckets

### 1. Reuse as-is

ALL of:
- Right layer (matches inventory's canonical layer for that functionality)
- Right framework (matches Phase 2 blueprint)
- Adequate depth (asserts behavior, not just syntax)
- Runs locally with no external network call
- Canary-eligible if required (smoke/E2E + critical/high tier + read-only/self-cleaning)
- Within speed budget for its layer
- Is the **canonical owner** of its functionality (no lower-layer test already proves the same property)

### 2. Promote / deepen

Right shape, fixable gap:
- Right layer, right framework, but shallow assertions or missing edge cases
- Missing canary mode (needs `TEST_TARGET_URL` env var plumbing)
- Marginally over speed budget but fixable via fixture-level setup, parallelization tuning, or removing redundant beforeEach work

### 3. Rebuild

Wrong fundamentals:
- Wrong layer (e.g., mocked integration where the inventory says real-DB integration is required)
- Wrong framework (Phase 2 recommends a different runner and the migration cost is justified)
- Requires non-local external service with no available substitute
- So slow it cannot be made budget-compliant at its current layer — often a sign the test is doing integration work in a unit test slot, or E2E work in a smoke slot

### 4. Trim (redundant assertion)

A test contains assertions that re-assert functionality already covered at a lower (canonical) layer. Layer hierarchy: **unit > integration > smoke > E2E**. Higher-layer tests are kept — they prove wiring and user-visible outcomes that lower layers cannot — but redundant *assertions* inside them are trimmed.

The no-duplicate-coverage principle (`t5_no_duplicate_coverage` in `references/principles.md`) is the authoritative source for this rule: each layer tests only what that layer can verify; don't re-assert business rules already covered by lower-layer unit tests. Treat `references/principles.md` as canonical.

**Do not delete E2E tests.** E2E tests prove what unit and integration tests cannot: that pieces connect, that state persists correctly across requests, that the system delivers the user-visible outcome end-to-end. A unit test for a business rule does not make the E2E redundant — the E2E still validates the wire.

**Check git history before any trim.** E2E tests added after production outages often document seam failures that unit tests missed — a DB constraint that wasn't tested, a middleware that dropped a header, a race condition across services. If a test has an outage-linked commit, its assertions are intentional. Mark it `reuse` and leave it.

Examples of assertions to trim (within an otherwise valid test):
- An E2E step that re-asserts a business rule calculation already tested at unit — remove the assertion, keep the test
- An integration test that re-asserts a pure-logic property already tested at unit — remove the redundant assertion
- A smoke test that re-asserts DB-state shape already proved at integration — remove that specific check

**This is the most contentious bucket.** Every `trim` entry MUST include:
- The specific assertion(s) being removed (not the test file)
- The canonical test that owns this property (file:line if possible)
- Why the trim is safe (the lower test covers it)

### 5. Net-new

Inventory items with zero existing coverage. Sorted by inventory criticality (critical first).

## Process

### Step 1 — load prior artifacts

Read inventory + system design. Abort if either missing.

### Step 2 — discover existing tests

Glob patterns from the Phase 2 framework matrix:
- Vitest/Jest/bun: `**/*.{test,spec}.{ts,tsx,js,jsx}`
- pytest: `**/test_*.py`, `**/*_test.py`
- Go: `**/*_test.go`
- RSpec: `**/*_spec.rb`
- Playwright: `**/e2e/**/*.{spec,test}.{ts,js}`

Exclude `node_modules/`, `dist/`, `build/`, vendored deps.

### Step 3 — classify each test file

For each existing test, read enough to determine:
1. **What it tests** — the functional unit (matches an inventory entry?)
2. **What layer it's actually at** — based on what it imports, what services it touches, what it mocks
3. **Whether it matches its claimed layer** — a `.test.ts` next to a route handler that spins up a DB connection is doing integration work even if filed as unit
4. **Whether it's the canonical owner of that functionality** — search for other tests that exercise the same property

### Step 4 — measure speed

Speed measurement is aggregate-first, split into an always-on aggregate pull and a
conditional per-layer breakdown. This mirrors `speed-budgets/SKILL.md`'s two-tier model —
treat that skill's escalation formula as canonical.

#### Step 4a — pull the aggregate (always)

Pull the aggregate wall-clock and pass/fail/skip counts from the most recent green CI run of
the `lint / typecheck / test` job, via `gh run list` / `gh run view --log`. No local Postgres
or per-layer infra is needed for this step — it's always obtainable from CI history alone.
Compare the aggregate wall-clock against speed-budgets' <15 min Full PR pipeline budget. This
step is mandatory and runs on every `/test-migration` invocation.

#### Step 4b — per-layer breakdown (conditional)

Only run this step if Step 4a's aggregate wall-clock trips the Tier 2 escalation trigger
defined in `speed-budgets/SKILL.md` (aggregate exceeds 50% of the <15 min budget, sustained
across 2 consecutive measurements). When triggered, actually run the suite and capture
per-test timings via the runner's reporter; a unit test taking 3 seconds is doing integration
work — speed is a strong layer-mismatch signal, flag for rebuild.

A suite that's comfortably in budget after Step 4a alone is a valid, complete outcome for this
step — do not treat the absence of local per-layer infra (e.g. no Postgres in the sandbox) as
a gap requiring escalation. The infra gap is not a speed problem unless Step 4a's aggregate
actually breaches the Tier 2 trigger.

#### Step 4c — pull real coverage percentages (always)

Mirrors Step 4a's mechanism exactly, applied to coverage instead of wall-clock: locate the
most recent green CI run of the `lint / typecheck / test` job via the same `gh run list` /
`gh run view --log` pull, but scope the log read to that run's `test:coverage` step
specifically. That step runs `scripts/check-coverage.ts`, which prints a summary block in
this exact shape:

```
Lines:     88.84% (12345/13897) — threshold: 80%
Functions: 88.00% (2200/2500) — threshold: 80%
```

Grep the step's log for these `Lines:` / `Functions:` lines and parse `line_coverage_pct` and
`function_coverage_pct` from them. No local coverage run is needed — like Step 4a, this is
always obtainable from CI history alone. This step is mandatory and runs on every
`/test-migration` invocation.

Carry `feature_coverage_pct` forward rather than recomputing it: read it from
`docs/test-readiness/test-inventory.md`, the Step 1 prerequisite artifact already loaded for
this run (Phase 1's `test-inventory` skill computes and writes it).

**Cite sources explicitly, every time:**
- `line_coverage_pct` / `function_coverage_pct` — cite the CI run URL and the commit SHA it
  ran against (both available from `gh run view`).
- `feature_coverage_pct` — cite that the value was carried forward from
  `docs/test-readiness/test-inventory.md`.

**Never guess.** If no green CI run can be found, the run has no `test:coverage` step, or
`docs/test-readiness/test-inventory.md` is missing or lacks the field, the corresponding
percentage is `null` — never a guessed or estimated value. This mirrors Step 4a's
verify-before-cite rule: a percentage without a citable CI run URL + commit (or, for
`feature_coverage_pct`, a citable test-inventory.md reference) does not get reported as a
number.

### Step 5 — assign buckets

Walk the matrix:

```
For each existing test:
  has-assertions-already-owned-by-lower-layer? → if so, → TRIM (remove those assertions; keep the test)
  right-layer? → if not, → REBUILD
  right-framework? → if not, → REBUILD
  within-speed-budget? → if not, hard-cap? → REBUILD; if soft, → PROMOTE
  local-runnable? → if not, → REBUILD
  canary-required-and-missing? → PROMOTE
  shallow-or-missing-edge-cases? → PROMOTE
  else → REUSE

For each inventory item with no existing test → NET-NEW
```

### Step 6 — bucket the infrastructure

Same five buckets, applied to:
- Test runner configs
- CI workflow files
- Test database / fixture setup
- Shared helpers
- Recorded fixtures (HTTP cassettes etc.)

### Step 7 — effort estimate per bucket

For each entry, assign small / medium / large effort. These feed Phase 4's milestone sequencing.

### Step 8 — risk callouts

**Mandatory**: any test that currently passes but gets a `delete` or `rebuild` verdict must have an explicit risk callout. Deleting a green test is the highest-stakes call in this audit — false-confidence coverage is exactly what kills autonomous programming, but a wrongly-deleted test is also a regression vector. Every such call needs reasoning.

### Step 9 — write the artifact

Load `${CLAUDE_PLUGIN_ROOT}/assets/templates/test-migration.md.tmpl`. Write to `docs/test-readiness/test-migration.md`.

## Failure modes to avoid

- **Don't auto-delete based on filename or directory.** Read the test. A `unit/foo.test.ts` that spins up a DB is integration, not unit. The file-naming convention principle (`t8_file_naming_convention` in `references/principles.md`) is about correctly encoding the layer in the filename, not inferring the layer from it; the code is the truth.
- **Don't mark "passes locally" as reuse-grade.** It must pass locally AND assert behavior AND be at the canonical layer AND meet speed budget.
- **Don't accept "we already have an E2E for that" as canary coverage.** Canary requires read-only or self-cleaning; most E2E tests are not.
- **Don't skip the risk callout on `delete` verdicts.** A test currently flagged green being recommended for deletion is the single most reviewable judgment call in the report.
- **Don't let a carried-forward measurement-only item hide behind a clean file-bucketing pass.** A repo can reach a "clean" steady state — zero rebuild/delete/net-new test files — for several consecutive `/test-migration` runs while a real, load-bearing measurement-only item (not a test file — e.g. a per-layer speed measurement gated behind Step 4b) stays carried forward unactioned, typically because Step 4a's aggregate has never actually breached speed-budgets' escalation formula and so Step 4b's per-layer infra (live DB/service access) was never exercised. That is not, by itself, a gap requiring escalation — Tier 2 infra being unavailable on a suite that's otherwise in budget is an expected, valid state, not a finding. Track any measurement-only item across cycles, but gate the mandatory-M1 trigger on an actual **Tier 1 budget breach**: only when Step 4a's aggregate has tripped speed-budgets' escalation formula (aggregate exceeds 50% of the <15 min budget, sustained across 2 consecutive measurements) AND the resulting Tier 2 item remains carried forward unactioned does it need to be surfaced explicitly in this artifact so `/test-roadmap` can act on it. Do not rely on the roadmap author noticing the streak in prose — when the Tier 1 budget breach gate is hit, `/test-roadmap` must place the item as the first Milestone 1 (M1) task by construction, the same way the naming-convention task is guaranteed a Milestone 1 slot.
