---
name: test-roadmap
description: >
  Phase 4 of the test-readiness pipeline. Synthesizes the three prior artifacts (inventory, system design, migration) into a single executable roadmap `test-readiness-plan.md` with five sequenced milestones and an agent-executable task list. Includes mandatory sections on where we are now, where we want to be, the gap, the speed delta, and open risks. Output is suitable for handoff to an engineer or to `shipwright /dev-task`. Invoke when the `/test-roadmap` command runs.
---

# test-roadmap skill

## Purpose

Synthesize. Take the three phase artifacts and produce the single document that drives execution.

## When invoked

By the `/test-roadmap` command. Requires:
- `docs/test-readiness/test-inventory.md`
- `docs/test-readiness/test-system.md`
- `docs/test-readiness/test-migration.md`

## Output structure

`docs/test-readiness/test-readiness-plan.md` has six sections:

### 1. Where we are now

Distilled from Phase 3:
- Layer coverage map (counts: how many tests at each layer, how many ought to be there)
- Local-runnable status: % of tests that run locally with no network
- Canary status: size of current canary suite vs. target (from Phase 2 critical-path roster)
- Speed status: current p95 per layer vs. budget
- "Rebuild" debt: count by layer and effort
- "Delete (redundant)" count and what it implies about false-confidence coverage

### 2. Where we want to be

Distilled from Phase 2:
- Framework matrix per layer
- Local-substitute map
- Coverage targets per tier
- Canary suite definition (critical-path roster)
- Speed budgets per layer

### 3. The gap

The concrete diff between sections 1 and 2:
- Missing layers (e.g., "no integration tests at all")
- Wrong-layer tests (count and severity)
- External-only deps with no local substitute (blockers)
- Canary suite size vs. target
- **Speed delta** — current per-layer p95 vs. target, expressed as ratio or time-to-close

### 4. Roadmap — five milestones

Always five, in this order. Each milestone has a clear definition-of-done (DOD) that gates the next.

#### Milestone 1: Infrastructure baseline
Set up runners, local substitutes, CI pipeline shape. No new tests written yet — just the rails.
- DOD: `bun test` (or stack equivalent) runs at every layer with the Phase 2 framework. Docker-compose / testcontainers boot all named deps. CI runs the unit + integration + smoke layers under budget.

**Mandatory M1 task — naming convention + runner-exclusion config:** Milestone 1 must always include an explicit task to establish the test file naming convention and runner-exclusion configuration. File-discovery collisions (the canary config picking up local tests, or Jest running Playwright specs) cause cascading failures across the roadmap. Establish the rules before writing any tests.

This task covers:
1. **File-naming convention** — define the suffix rules for each entry point:
   - `.canary.ts` / `.canary.spec.ts` — canary-only tests (Playwright project or filtered script)
   - `.smoke.ts` / `.smoke.spec.ts` — smoke layer (pre-merge local run)
   - `.integration.ts` / `.integration.spec.ts` — integration layer (testcontainers / docker-compose)
   - `.unit.ts` / `.unit.spec.ts` or default (no suffix) — unit layer
   Use one consistent convention across the repo; document it in a `docs/test-readiness/naming.md` or equivalent.
2. **Runner-exclusion config** — each runner must explicitly exclude the other layers' files:
   - **Jest / Vitest `testMatch` / `include`** — exclude `.canary.`, `.smoke.`, `.integration.` files from the unit runner
   - **Playwright `testMatch`** — scope to `.canary.spec.ts` or the canary project directory only; exclude all `.unit.`, `.integration.` files
   - **Coverage config `exclude`** — exclude test helpers, fixtures, and non-source files from coverage reports
   - **bun test `--filter`** — use path-based filters that respect the naming convention
3. **Verification** — run each entry point in isolation and confirm it picks up only its layer's files (e.g., `bun test --filter integration` finds zero unit files).

#### Milestone 2: Critical-path coverage
Write or rebuild every `critical` tier test across all layers.
- DOD: 100% of inventory items tagged `critical` have a passing test at the prescribed layer. `delete (redundant)` tests in this tier are gone.

#### Milestone 3: Canary suite live
Smoke + E2E canary-eligible tests run green against a freshly deployed environment.
- DOD: CI job runs the canary suite against a staging URL post-deploy. Suite completes in <60s. All canary tests pass.

#### Milestone 4: High-tier coverage
Fill `high` tier gaps.
- DOD: 100% of `high` tier inventory items have coverage at the prescribed layer.

#### Milestone 5: Cleanup
Delete or refactor remaining `rebuild` and `delete (redundant)` tests; remove false-confidence coverage. This milestone comes LAST because deletions are safer once new coverage is in place.
- DOD: zero tests in `rebuild` bucket remain. Zero tests in `delete (redundant)` bucket remain. CI passes.

### 5. Task list

Flat, ordered. Each task has:
- **ID** (sequential, e.g., `T-001`)
- **Milestone** (1–5)
- **Files to touch** (paths)
- **Layer** (unit / integration / smoke / E2E / infra)
- **Bucket origin** (reuse / promote / rebuild / delete / net-new)
- **Expected outcome** (one line)
- **Verification command** (the exact CLI invocation that proves it's done)

This format is designed to be consumed by `shipwright /dev-task` as a queue.

**Task sizing for agent execution:** a task is agent-executable as written iff all three of:
1. **Independently deployable** — the PR for this task can merge without the next task. No "part 1 of 2" that leaves the system in a broken intermediate state.
2. **Single concern** — one functional unit per task. A task touching auth middleware AND a user factory AND two smoke tests is three tasks. **Single concern ≠ one operation repeated across N services.** Applying the same change to N services is N tasks — each service has its own files, its own verification command, and its own PR surface area.
3. **Hard cap: ~1000 lines changed.** Larger PRs slow review, increase merge conflict risk, and reduce the agent's confidence in its own output. If a task exceeds this, break it at a natural seam — usually by layer (infra task, then unit task, then integration task) or by feature area.

**Fan-out rule for refactor and migration tasks (non-negotiable):** Never emit a single task that touches more than one service or primary file as a refactor or migration. Apply deterministically:

- **One service/file per refactor or migration task** — hard cap, no exceptions.
- **N-service refactors become N child tasks** under a single parent summary task. The parent (`P-NNN`) carries the title (e.g., "Migrate auth middleware across all services") with no verification command of its own — it closes when all N children close. Each child (`T-NNN`) targets one service, lists its own files, and has its own verification command.
- Emit the parent task first, then its children in sequence, each marked `depends_on: P-NNN`.

**Example — 6-service auth middleware refactor:**

Instead of one oversized task:
```
T-042 | M2 | services/*/src/middleware/auth.ts (6 files) | infra | rebuild
      | Migrate auth middleware to new token format
      | bun test --filter auth
```

Emit a parent and 6 children:
```
P-042 | M2 | —                                              | infra | rebuild
      | Migrate auth middleware to new token format (6 services)
      | (closes when T-042a–T-042f all close)

T-042a | M2 | services/payments/src/middleware/auth.ts      | infra | rebuild
       | Migrate auth middleware — payments
       | bun test --filter payments/auth

T-042b | M2 | services/users/src/middleware/auth.ts         | infra | rebuild
       | Migrate auth middleware — users
       | bun test --filter users/auth

T-042c | M2 | services/notifications/src/middleware/auth.ts | infra | rebuild
       | Migrate auth middleware — notifications
       | bun test --filter notifications/auth

T-042d | M2 | services/billing/src/middleware/auth.ts       | infra | rebuild
       | Migrate auth middleware — billing
       | bun test --filter billing/auth

T-042e | M2 | services/catalog/src/middleware/auth.ts       | infra | rebuild
       | Migrate auth middleware — catalog
       | bun test --filter catalog/auth

T-042f | M2 | services/search/src/middleware/auth.ts        | infra | rebuild
       | Migrate auth middleware — search
       | bun test --filter search/auth
```

The fan-out rule is not advisory — do not emit the oversized task and place it in Open risks. Apply the split during task generation. Open risks is for genuinely ambiguous human calls, not for tasks the sizing algorithm knows are too large.

### 6. Open risks

Anything the audit couldn't determine without a human call. Common entries:
- Tests in the `delete (redundant)` bucket where the canonical owner is itself untested (don't delete until owner exists)
- External dep with no clean local substitute (does the team accept a recorded-fixture-only approach?)
- Tests at the wrong layer that may be doing important work the inventory didn't capture (human verification needed)

## Process

1. Read all three prior artifacts. Abort if any missing.
2. Extract metrics: layer counts, speed numbers, bucket counts.
3. Compute the gap (section 3 math).
4. Generate the task list by walking the migration buckets in this order:
   - Milestone 1: all `infra` items + **paired repo-config tasks** (see pairing rule below)
   - Milestone 2: all `critical` tier items (net-new + rebuild + promote)
   - Milestone 3: all canary-eligible items needing canary plumbing
   - Milestone 4: all `high` tier items (net-new + rebuild + promote)
   - Milestone 5: all `delete (redundant)` items + remaining `rebuild` cleanup + plugin feedback collector
5. **Apply the pairing rule** from `${CLAUDE_PLUGIN_ROOT}/skills/repo-config/SKILL.md`: every task that creates or modifies a CI workflow file MUST emit a paired branch-protection task that `depends_on` the workflow task. Without this, the audit ships as advisory rather than enforced. The pairing rule is non-negotiable; skipping it is the failure mode the user will catch and the plugin will be blamed for.
6. Load `${CLAUDE_PLUGIN_ROOT}/assets/templates/test-readiness-plan.md.tmpl`. Fill. Write to `docs/test-readiness/test-readiness-plan.md`.

## Failure modes to avoid

- **Don't sequence Milestone 5 (cleanup) before Milestone 2 (critical-path).** Deleting a "redundant" test before its canonical owner exists creates a coverage hole. Always build before deleting.
- **Don't skip the speed delta.** It's the most actionable single number for "are we converging."
- **Don't write a roadmap that's a copy of the migration table.** The roadmap is sequenced and milestone-gated; the migration is unsorted bucketing. The synthesis is the value.
