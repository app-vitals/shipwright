---
name: test-design
description: >
  Phase 2 of the test-readiness pipeline. Given the Phase 1 inventory, designs the ideal test system greenfield — framework per layer, local execution architecture, canary execution contract, test-data strategy, CI pipeline shape, coverage targets, and speed budgets. Does not look at existing tests (that's Phase 3). Writes `docs/test-readiness/test-system.md`. Invoke when the `/test-design` command runs.
---

# test-design skill

## Purpose

Design the **target** test system. Greenfield. The blueprint Phase 3 reconciles existing tests against.

## When invoked

By the `/test-design` command. Requires `docs/test-readiness/test-inventory.md` from Phase 1.

## Process

### Step 1 — load the inventory

Read `docs/test-readiness/test-inventory.md`. If missing, abort with a clear "run /test-inventory first" message. Extract:
- Stack profile
- Per-layer test counts (how many unit, integration, smoke, E2E)
- External dependencies named (DBs, queues, third-party APIs)
- Canary suite candidates (canary-eligible roster)

### Step 2 — recommend frameworks per layer

Based on the stack profile, select one framework per layer. Use the matrix below as the default; override only if the inventory reveals a specific reason (e.g., existing build infra makes one choice radically cheaper).

| Stack | Unit | Integration | Smoke | E2E |
|---|---|---|---|---|
| TypeScript (Bun) | `bun test` | `bun test` + testcontainers | supertest / Hono test client | Playwright |
| TypeScript (Node) | Vitest | Vitest + testcontainers | supertest | Playwright |
| Python | pytest | pytest + testcontainers / docker-compose | httpx / FastAPI TestClient | Playwright (Python) |
| Go | `go test` | `go test` + testcontainers-go | `httptest` | Playwright |
| Ruby | RSpec | RSpec + database_cleaner | Rack::Test | Capybara / Playwright |

### Step 3 — local execution architecture

For every external dependency named in the inventory, prescribe a **local substitute**. Tests that require a hosted external service with no local substitute are categorically forbidden in this system design.

| Dependency type | Preferred local substitute |
|---|---|
| Postgres / MySQL | Real DB per test run (testcontainers or a dedicated test DB). **Pattern:** wrap ORM calls in a typed service layer (interface + implementation); integration tests hit a real DB through that interface; unit tests mock the interface. Never mock the DB itself at the SQL or ORM level — that mocks the wrong thing. |
| Redis | testcontainers / in-memory shim |
| S3 / blob storage | localstack / minio |
| Internal HTTP service | Recorded fixture doubles (msw / nock / hand-authored JSON) by default — they're faster and require no service infra. If the service ships a Go/TS client interface, prefer mocking that interface over mocking the wire protocol. Inline service or docker-compose only when recorded fixture doubles are impractical (e.g., bidirectional streaming). |
| Third-party HTTP API | Recorded fixture doubles (msw / nock / hand-authored JSON) — never live. Requires a recorded-fixture maintenance loop (see `repo-config/SKILL.md` — deferred, not yet implemented) — without periodic re-recording, recorded fixtures go stale silently. |
| SMTP / email | mailhog / capture-only |
| Webhook receiver | local HTTP listener (e.g., smee / ngrok-recorded) |

**Rule:** no recommendation may rely on the developer manually starting an external service. If `docker-compose up` is required, the system design lists the exact compose file path the implementation phase will create.

### Step 4 — canary execution contract

Reference `${CLAUDE_PLUGIN_ROOT}/skills/canary-execution/SKILL.md` and include its contract verbatim in the artifact. Specifically:
- `TEST_TARGET_URL` env var as the local/canary mode switch
- Canary tests must be read-only OR self-cleaning
- Canary suite hard budget: <60s wall time
- Auth strategy for canary mode (token-scoped, not production credentials)
- Canary suite runs zero DB-dependent local tests (eligibility rule 6)

**Prescribe a dedicated canary entry point.** The artifact must specify a separate npm script (`test:canary`) or Playwright project (e.g., `playwright.canary.config.ts`) for running the canary suite. This entry point must never reuse `test:smoke`. CI wires two distinct jobs: `smoke` (pre-merge, runs `test:smoke`, boots local deps) and `canary` (post-deploy, sets `TEST_TARGET_URL`, runs `test:canary`). Document both the script name and the CI job name in the artifact.

### Step 5 — test-data strategy

Decide and document:
- **Per-service DBs vs. shared** — prefer per-service (matches modern microservice convention).
- **Real DB per test run vs. transaction rollback** — depends on parallelism. Document the choice.
- **Factories vs. fixtures** — factories preferred for variability; fixtures for stable golden cases.
- **Seed strategy** — explicit, named seed sets, not "whatever's in the migration."
- **API-first seeding** — seed through the public API wherever the API exists, not via direct DB writes. Direct DB writes bypass business rules (validations, side effects, derived fields) that accumulate over time, causing seeds to diverge from what the application actually produces. DB writes are an explicit fallback for seeding state that the API cannot express (e.g., legacy data, corrupt-state tests).
- **Eventual consistency** — seeding via API may trigger async workers (queues, webhooks, event buses). Tests that assert on state produced by async workers must use a wait/poll pattern: retry the assertion with exponential backoff up to a hard timeout (e.g., 5 retries, 500ms base, 5s cap). Document the specific async paths in the repo and which tests need this pattern.

### Step 6 — CI pipeline shape

Document:
- **Layer order**: unit → integration → smoke. E2E and canary run post-merge / post-deploy.
- **Fail-fast**: unit failures skip integration. Integration failures skip smoke.
- **Parallelism**: per-layer worker count.
- **Budget**: <15min total per PR (agent-readiness checklist Condition 4).

**Naming convention and runner-exclusion config (required):** The artifact must specify both a file-naming convention and the runner-exclusion config that enforces it. These two items are inseparable — a naming convention without matching exclusion config is not enforced, and exclusion config without a naming convention is unauditable. Document:

1. **File-naming convention** — one suffix rule per entry point:
   - `.canary.ts` / `.canary.spec.ts` — canary entry point only
   - `.smoke.ts` / `.smoke.spec.ts` — smoke layer (pre-merge)
   - `.integration.ts` / `.integration.spec.ts` — integration layer (testcontainers / docker-compose)
   - `.unit.ts` / `.unit.spec.ts` or default — unit layer

2. **Runner-exclusion config** — each runner explicitly excludes other layers:
   - **Jest / Vitest** `testMatch` / `include` — exclude `.canary.`, `.smoke.`, `.integration.` from the unit runner
   - **Playwright** `testMatch` — scope to `.canary.spec.ts` or the canary project directory; exclude `.unit.`, `.integration.` files
   - **Coverage config** `exclude` — exclude test helpers, fixtures, factory files, and non-source files from line/branch coverage reports
   - **bun test `--filter`** or equivalent — use path-based filters aligned with the naming convention

3. **Verification** — for each runner, a command that confirms it picks up only its layer's files (e.g., `bun test --filter integration --dry-run | grep -v .integration.` should return nothing).

### Step 7 — coverage targets

Enforce a **single coverage floor** (≥80% line and branch) enforced by standard coverage tooling — no per-tier thresholds in CI. Criticality drives *prioritization* (write critical tests first), not enforcement: the CI gate does not need to know which files are critical.

| Layer | Minimum CI floor | Notes |
|---|---|---|
| unit | ≥80% line, ≥80% branch | Critical-path files should reach ≥90%, but enforced via team practice, not separate CI gates |
| integration | every named boundary covered | Measured by code path, not line count |
| smoke | every public route 200/4xx covered | Route coverage, not code coverage |
| E2E | every top-5 journey covered | Journey coverage |

**Why a single floor:** per-tier thresholds require a maintained criticality mapping in CI. As files are added, moved, or grow in importance, the mapping decays silently. A single floor enforced by the language's built-in coverage reporter avoids this maintenance burden while still directing attention to critical paths during planning.

### Step 8 — speed budgets

Reference `${CLAUDE_PLUGIN_ROOT}/skills/speed-budgets/SKILL.md` and include the default budget table. May tighten per repo; never loosen.

Also output the **parallelization plan**: worker count and sharding strategy per layer that makes the suite targets achievable.

### Step 9 — shared helpers / utilities inventory

List the test-support code the implementation will need:
- HTTP request builders (auth tokens, default headers)
- Test-user factory / auth fixture
- DB reset helper (truncate or migrate-rollback)
- Time freezer (for deterministic time-dependent tests)
- Recorded-fixture loader

### Step 10 — repo configuration

Reference `${CLAUDE_PLUGIN_ROOT}/skills/repo-config/SKILL.md` and include a **Repo configuration** section in the artifact covering:

- **Branch protection** rule definition for `main` — required status checks (every layer-relevant CI job from the pipeline shape above), required reviews, conversation resolution, admin enforcement decision
- **Required secrets** — `TEST_CANARY_API_KEY`, per-external service auth tokens (for recorded-fixture recording), staging/prod deploy credentials
- **Required GitHub Environments** — `staging`, `production` with reviewer gates
- **PR template recommendation** — `.github/pull_request_template.md` with a Closing Checklist that requires the verification-command output

Without this section, the test pipeline is advisory. The Phase 4 roadmap will auto-pair workflow tasks with branch-protection tasks per the **pairing rule** in `repo-config/SKILL.md`.

### Step 11 — write the artifact

Load template at `${CLAUDE_PLUGIN_ROOT}/assets/templates/test-system.md.tmpl`. Fill in. Write to `docs/test-readiness/test-system.md`.

## Failure modes to avoid

- **Don't look at existing tests.** That's Phase 3's job. Anchoring here makes Phase 3 cosmetic.
- **Don't recommend mocks for boundaries the inventory marked as integration-canonical.** A mocked DB is not an integration test.
- **Don't skip the parallelization plan.** "Suite finishes in 8 minutes" is meaningless without "with N workers running in parallel."
- **Don't recommend a stack the team can't actually run locally.** If the inventory names a dependency you can't suggest a local substitute for, flag it as a *blocker* in the artifact rather than hand-waving.
