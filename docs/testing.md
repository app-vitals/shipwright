# Testing

> Shipwright uses a four-layer test model (unit / integration / smoke / e2e). Tests land **with** the code, at the correct layer, in the same PR — there are no "add tests later" tasks. This doc is a digest of the authoritative blueprint at [`test-readiness/test-system.md`](./test-readiness/test-system.md).

## Layers

| Layer | Framework | Boundary rule | Suffix |
|---|---|---|---|
| **Unit** | `bun test` | Pure logic — no I/O of any kind (no filesystem, network, or subprocess). | `*.unit.test.ts` |
| **Integration** | `bun test` + injected recorded doubles | Real dependency behavior via recorded fixtures / injected doubles — exercises the seam without a live external service. | `*.integration.test.ts` |
| **Smoke** | `bun test` + Hono `app.request()`, or `Bun.serve()` + `fetch()` | HTTP route contracts (status, shape, auth, errors). Prefer in-process `app.request()` (no real socket) for Hono apps; a real `Bun.serve()` boot with live `fetch()` is permitted when there's no in-process request seam (e.g. a bare-`Bun.serve()` server with no Hono app factory). | `*.smoke.test.ts` |
| **E2E** | `@playwright/test` | Full browser-driven flows against a real running server. Marketing site home page (`site/*.spec.ts`); metrics dashboard (`metrics/e2e/*.e2e.ts`); admin UI (`admin/e2e/*.e2e.ts`). | `*.spec.ts` (in `site/`), `*.e2e.ts` (in `metrics/e2e/`, `admin/e2e/`) |

The layer is encoded in the filename suffix. When adding a test, classify in order: no I/O → **unit**; calls an external service → **integration** (inject a recorded double); tests an HTTP route → **smoke** (`app.request()`, or a real `Bun.serve()` boot only if there's no in-process seam); multi-step browser flow → **e2e**. If none fit, escalate — don't invent a fifth layer.

## Running tests

go-task (`Taskfile.yml`) is the single local entrypoint:

```bash
task setup        # bun install across all workspaces
task ci           # lint → check-strings → typecheck → check-config-docs → check-version-sync → test:coverage → secret-scan (the merge-blocking gate)
task test         # bun test (all packages)
task test:coverage  # bun test --coverage --coverage-reporter=lcov, then gate on aggregate 80/80 lines/functions (scripts/check-coverage.ts)
```

Run a single package or file directly:

```bash
bun test --filter metrics            # one workspace
bun test --filter agent
bun test --filter plugins/shipwright
bun test path/to/file.test.ts        # one file
```

The marketing site is **not** part of the root `bun test` scan — run its Playwright suite separately:

```bash
cd site && npm test                  # playwright (*.spec.ts)
```

> `bunfig.toml` excludes `site/**`, `metrics/e2e/**`, and `admin/e2e/**` from the root runner. Keep site tests as `*.spec.ts` and E2E tests as `*.e2e.ts` to stay isolated — Bun would otherwise try to execute Playwright specs and crash.

### Per-component layers

| Component | Layers in use | Run command |
|---|---|---|
| Plugin (`plugins/shipwright`) | unit, integration | `bun test --filter plugins/shipwright` |
| Metrics (`metrics`) | unit, integration, smoke, e2e | `bun test --filter metrics` (unit/integration/smoke); `task e2e` (e2e) |
| Agent (`agent`) | unit, integration, smoke | `bun test --filter agent` |
| Admin (`admin`) | unit, integration, smoke, e2e | `bun test --filter admin` (unit/integration/smoke); `cd admin && bunx playwright test` (e2e) |
| Task Store (`task-store`) | integration | `bun test --filter task-store` |

The plugin has **no smoke/e2e layer** (no HTTP surface). Task Store is a pure Prisma package (library, no HTTP surface). E2E (Playwright) covers the marketing site (`site/tests/home.spec.ts`, `site/tests/docs-platform.spec.ts`, `site/tests/docs-search.spec.ts`), the metrics dashboard UI (`metrics/e2e/dashboard.e2e.ts`), and the admin UI (`admin/e2e/agents-page.e2e.ts`, `admin/e2e/login-page.e2e.ts`).

## Speed budgets

| Layer | Per-test 95p | Per-test hard cap | Suite target |
|---|---|---|---|
| Unit | <50 ms | <200 ms | <30 s |
| Integration | <500 ms | <2 s | <60 s |
| Smoke | <2 s | <10 s | <30 s |
| E2E | <30 s | <90 s | <5 min |
| **Full CI pipeline** | — | — | **<5 min wall** |

A unit test over 200 ms is a suspected hidden integration test (audit its imports for I/O). A smoke test over 10 s is a suspected e2e test in disguise (rebuild).

## Test isolation contract (hard rules)

- **Time:** any production code path that calls `new Date()` / `Date.now()` non-trivially must accept a `Clock` interface; tests inject `FixedClock(t)`. Raw `Date.now()` in code under test is a bug.
- **External HTTP:** service clients (`TaskStoreClient`, `GithubClient`, …) are interfaces with an `Http*Client` production impl; tests inject `Recorded*Client` recorded fixture doubles replaying fixture data from `tests/fixtures/<service>/*.json` (versioned JSON committed to the repo).
- **No global state:** **no `mock.module()`**, **no `global.fetch` / `global.*` overrides.** Bun runs test files in the same process, so module-level mocks and global mutation leak across sibling suites. Each test must be independently runnable, order-independent.
- **Offline by default:** no live external calls. Live external service credentials must be absent for metrics unit/integration/smoke tests; `DATABASE_URL_ADMIN_TEST` must be set to a Postgres connection string for admin DB integration tests, and `DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST` for task-store DB integration tests (suites skip automatically when the respective var is absent).

## CI gates

CI runs the exact `task ci` chain: **lint → check-strings → typecheck → check-config-docs → check-version-sync → test:coverage → secret-scan**, layer order unit → integration → smoke → e2e (a lower-layer failure fails fast and skips higher layers). Unit and integration run in parallel across packages; smoke (metrics + agent) runs after all integration jobs pass; e2e (Playwright — metrics dashboard + admin UI) runs last and only in Phase B+. The coverage gate (80% lines + 80% functions on an aggregate basis) is enforced by `scripts/check-coverage.ts` on the LCOV report produced by `task test:coverage`.

## References

- **[test-readiness/test-system.md](./test-readiness/test-system.md)** — the full blueprint: layer definitions, boundary-violation patterns, per-component budgets, the CI pipeline diagram, and the complete isolation contract. (Read-only — produced by the test-readiness plugin pipeline.)
