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

### Step 4 — measure speed (optional but recommended)

If the user opted in (or it's cheap to do so), actually run the test suite once and capture per-test timings. A unit test taking 3 seconds is doing integration work. Speed is a strong layer-mismatch signal — flag for rebuild.

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
