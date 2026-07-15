# Shipwright Test System Design

> Gating deliverable for the test-readiness pipeline. Defines the five test layers,
> per-component run commands, and speed budgets that `plan-session` and `dev-task`
> Step 2 enforce across Phases B and C.

## Layer definitions

Every test in this repository must be placed in exactly one layer. The layer
boundary determines which dependencies are permitted in that test.

| Layer | Boundary rule | Framework | When to use |
|---|---|---|---|
| **unit** | Pure logic — no I/O of any kind. No filesystem reads, no network calls, no process spawning. | `bun test` | Functions, parsers, validators, data-transformation utilities, any code whose only inputs/outputs are in-memory values. |
| **integration** | Real dependency behavior via recorded fixtures or injected doubles. Exercises the integration seam without a live external service. | `bun test` + recorded-fixture clients injected via DI | Service classes, client wrappers, anything that reads/writes to an external system — tested via recorded fixture doubles (`RecordedXClient`) instead of the real service. |
| **smoke** | Hono endpoints exercised via in-process `app.request()`. No real socket, no port allocation. | `bun test` + Hono `app.request()` | HTTP route contracts: status codes, response shapes, auth checks, error handling. Full middleware + routing pipeline without spinning up a server. |
| **e2e** | Full browser-driven flows against a real running server. | `@playwright/test` | Multi-step user journeys through the metrics dashboard and admin UIs: navigation, rendering, data display, interaction flows. Phase B+. |
| **content** | Markdown/prompt-content-assertion tests — no real I/O boundary, just asserting on static content (e.g. `existsSync`/`readFileSync` against a command's or skill's Markdown body). | `bun test` | Verifying a command's, skill's, or reference doc's Markdown body contains expected sections/instructions/wording, or that plugin directory structure matches an expected layout. Distinct from unit: the assertion target is prose/structure, not executable logic. |

### Boundary violations

These patterns indicate a test is in the wrong layer:

- A unit test that reads a file, opens a socket, or spawns a subprocess → move to integration, or to content if the file read is a static Markdown/prompt-content assertion with no logic under test.
- An integration test that boots a real HTTP server → move to smoke.
- A smoke test that opens a real browser → move to e2e.
- A unit test that takes >200 ms → likely a hidden integration test; investigate.
- A smoke test that takes >15 s → likely an e2e test in smoke's clothing; rebuild.

### Forbidden patterns (all layers)

- No `mock.module()` — Bun runs test files in the same process; module-level mocks leak across suites.
- No `global.fetch` overrides or any other `global.*` mutation in tests — same reason.
- No raw `new Date()` / `Date.now()` in tested code paths — inject a `Clock` interface and use `FixedClock(t)` in tests for deterministic time.
- No live external calls — everything runs offline by default. Live calls only when env explicitly enables them for manual testing.

## Per-component run commands and speed budgets

### Plugin (`@shipwright/plugin`) — Phase A

The plugin is pure TypeScript — no server, no database, no external HTTP in production code. Tests are unit, integration, and content.

| Layer | Local run command | Per-test 95p | Per-test hard cap | Suite target |
|---|---|---|---|---|
| unit | `bun test --filter plugins/shipwright` | <50 ms | <200 ms | <15 s |
| integration | `bun test --filter plugins/shipwright` | <500 ms | <2 s | <30 s |
| content | `bun test --filter plugins/shipwright` | <50 ms | <200 ms | <15 s |

**Notes:**
- Integration tests inject `RecordedGithubClient` (a recorded fixture double) for any GitHub API calls (issue reads/writes, label operations).
- Content tests assert on static Markdown bodies (commands, skills, reference docs) via `existsSync`/`readFileSync` — no I/O boundary beyond local file reads, no logic under test.
- No smoke or e2e layer — the plugin has no HTTP surface.
- Plugin code must remain repo-agnostic; tests must not hardcode paths to any external repository.

### Metrics dashboard (`@shipwright/metrics`) — Phase B

The metrics service is a stateless Hono app backed by task-store/fixture providers. No database.

| Layer | Local run command | Per-test 95p | Per-test hard cap | Suite target |
|---|---|---|---|---|
| unit | `bun test --filter metrics` | <50 ms | <200 ms | <15 s |
| integration | `bun test --filter metrics` | <500 ms | <2 s | <30 s |
| smoke | `bun test --filter metrics` | <2 s | <10 s | <30 s |

**Notes:**
- Integration tests inject `RecordedTaskStoreClient` (a recorded fixture double) for task and PR queries. Fixture data lives in `metrics/src/fixtures/task-store-fixtures.ts`.
- Smoke tests drive the Hono app via `app.request()` — no real socket, no `fetch()` to localhost. Import the app factory and call `app.request(new Request(...))` directly.
- No e2e layer until Phase B ships a browser-rendered dashboard. E2e layer added then via Playwright.
- Tests run offline by default with no external service URLs configured.

### Shipwright agent (`@shipwright/agent`) — Phase C

The agent is a thin runner with a Prisma-backed PostgreSQL database and a Hono HTTP surface for health and admin endpoints. Integration tests cover the task-pick, PR-ship, and DB seams; smoke tests cover the Hono route contracts.

| Layer | Local run command | Per-test 95p | Per-test hard cap | Suite target |
|---|---|---|---|---|
| unit | `bun test --filter agent` | <50 ms | <200 ms | <15 s |
| integration | `bun test --filter agent` | <500 ms | <2 s | <30 s |
| smoke | `bun test --filter agent` | <2 s | <10 s | <30 s |

**Notes:**
- Integration tests inject `RecordedGithubClient` for issue/PR operations and a `RecordedMetricsClient` for forwarding calls.
- **DB integration tests** (added in SHE-1.2) run against real Postgres databases: `DATABASE_URL_ADMIN_TEST="postgresql://user:password@localhost:5432/shipwright_admin_test"` for admin service tests and `DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST="postgresql://user:password@localhost:5432/shipwright_task_store_test"` for task-store tests. Each test suite provisions the schema via `prisma migrate deploy` and tears down after. No Prisma mocking — service classes own all DB queries.
- **Smoke tests** drive the Hono app via `app.request()` — no real socket, no port allocation. Import the app factory and call `app.request(new Request(...))` directly. Covers health endpoints, agent CRUD routes, and auth checks.
- The agent's execution loop must accept a `Clock` injection for deterministic scheduling tests.
- `DATABASE_URL_ADMIN_TEST` must be set to a Postgres connection string (e.g. `postgresql://user:password@localhost:5432/shipwright_admin_test`) for admin DB integration tests to run; `DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST` for task-store DB integration tests. Suites skip automatically when the respective var is absent.

## Full suite commands

| Scope | Command | Speed budget |
|---|---|---|
| All layers, all packages | `bun test` | <2 min |
| Single package | `bun test --filter <package-name>` | see per-component above |
| CI gates (lint → check-strings → typecheck → check-config-docs → check-version-sync → test → secret-scan) | `task ci` | <5 min |

## CI pipeline shape

```
┌─────────┐
│  Lint   │  bunx biome lint .
└────┬────┘
     │
┌────▼──────┐
│ Typecheck │  bun run --filter="*" --sequential typecheck
└────┬──────┘
     │
     ├──────────────┬──────────────┐
     │              │              │
┌────▼──────┐ ┌─────▼─────┐ ┌─────▼─────┐   ← parallel, per-package
│ plugin    │ │ metrics   │ │ agent     │
│ unit+intg │ │ unit+intg │ │ unit+intg │
└────┬──────┘ └─────┬─────┘ └─────┬─────┘
     │              │              │
     └──────────────┼──────────────┘
                    │
         ┌──────────┴──────────┐
         │                     │
   ┌─────▼─────┐         ┌─────▼─────┐   ← parallel, per-package
   │  Smoke    │         │  Smoke    │
   │ (metrics) │         │  (agent)  │   Phase C+
   │ app.req() │         │ app.req() │
   └─────┬─────┘         └─────┬─────┘
         │                     │
         └──────────┬──────────┘
                    │
              ┌─────▼─────────┐
              │   E2E         │  Playwright; Phase B+ only
              │(metrics+admin)│  <5 min
              └─────┬─────────┘
                    │
              merge → main
```

- **Layer order:** unit → integration → smoke → e2e. A lower-layer failure skips higher layers (fail-fast). Content tests run alongside unit tests in the same `bun test` package job — no separate CI stage.
- **Parallelism:** unit, content, and integration run in parallel across packages. Smoke layers (metrics + agent) run in parallel with each other, sequentially after all integration jobs pass.
- **Test-DB service container:** CI provisions a real `postgres:16` service container (see `.github/workflows/ci.yml`) for any DB-backed integration/smoke test (e.g., the agent's DB integration suite) — never a mocked or in-memory Postgres substitute.

## Speed budgets (consolidated)

| Layer | Per-test 95p | Per-test hard cap | Suite target |
|---|---|---|---|
| Unit | <50 ms | <200 ms | <30 s |
| Integration | <500 ms | <2 s | <60 s |
| Smoke | <2 s | <10 s | <30 s |
| E2E | <30 s | <90 s | <5 min |
| Content | <50 ms | <200 ms | <15 s |
| **Full CI pipeline** | — | — | **<5 min wall** |

**Speed-violation handling:**

- Unit test >200 ms → suspect hidden integration test; audit imports for any I/O. Phase 3 candidate: `rebuild` (re-layer as integration, or extract pure-logic core).
- Smoke test >10 s → suspect e2e in smoke's clothing; audit for real HTTP or browser interaction. Phase 3 candidate: `rebuild`.

## Test isolation contract

**Time:** Any production code path that calls `new Date()` or `Date.now()` non-trivially must accept a `Clock` interface. Tests inject `FixedClock(t)`. Raw `Date.now()` in a code path under test is a bug — it makes time-sensitive assertions flaky.

**External HTTP:** External service clients (`SlackClient`, `GithubClient`, etc.) are defined as interfaces with an `Http*Client` production implementation. Tests inject `Recorded*Client` recorded fixture doubles that replay fixture data from `tests/fixtures/<service>/*.json`. Fixture files are versioned JSON committed to the repository.

**No global state:** Tests must not mutate module-level globals, override built-in globals, or rely on test-execution order. Each test is independently runnable.

## Classifying a new test

When `dev-task` Step 2 asks "which layer does this test belong in?", apply in order:

1. Does the code under test perform any I/O? If no → **unit**.
2. Does it call an external service (Slack, GitHub, etc.)? → **integration** (inject a recorded double).
3. Does it test an HTTP route contract? → **smoke** (use `app.request()`).
4. Does it test a multi-step browser flow? → **e2e** (Playwright).
5. Is it a static Markdown/prompt-content assertion (a command's or skill's body, plugin directory structure) with no logic under test? → **content**.

If none of these fit, escalate — do not invent a sixth layer.
