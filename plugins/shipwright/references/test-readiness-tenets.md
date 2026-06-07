# Test-Readiness Tenets — Universal Baseline

Checklist of diff-checkable test quality tenets. Used by code-reviewer Rule 6 when
`testReadinessContext` is absent (graceful degradation) or as a supplemental baseline.

## Graceful Degradation

When a repo has no `docs/test-readiness/test-system.md` and no Testing section in
CLAUDE.md, Rule 6 applies this universal baseline. The baseline is intentionally conservative:
flag only clear violations with confidence ≥ 75. When test-readiness docs are present, defer
to them first and use this file only for tenets not covered there.

## Activation Gate

Rule 6 fires only when the PR touches files matching `*.test.*`, `*.spec.*`, or `tests/`
directories, OR when the PR adds production logic with no corresponding test additions.

## Universal Baseline Tenets

### T1 — No global mocking

**Violation:** `mock.module()`, overriding `global.fetch`, `global.console`, or any other
global. Bun runs test files in the same process — leaked globals break other test suites.

**Exception:** `global.fetch` mocking is acceptable in client implementation tests that
directly wrap `fetch()` (e.g. `HttpGoogleAuthClient`).

**Signal:** `mock.module(`, `global.fetch =`, `global.console =`, `jest.mock(`

### T2 — Clock injection

**Violation:** Raw `new Date()` or `Date.now()` calls in production code paths under test.
Any code path that references the current time must accept a `Clock` interface. Tests inject
`FixedClock` to make time deterministic; raw calls make snapshots and time-sensitive
assertions flaky.

**Signal:** `new Date()` in service/handler code added by the diff, no `Clock` parameter

### T3 — Recorded-fixture pattern for external clients

**Violation:** External service clients (`GoogleCalendarClient`, `SlackClient`,
`MercuryClient`, etc.) tested via `global.fetch` mocking instead of `RecordedXClient`
test doubles replaying cassettes from `tests/fixtures/<service>/*.json`.

**Signal:** `global.fetch =` in a client test, missing `tests/fixtures/` entry for a new
external client

### T4 — Real-boundary integration tests

**Violation:** Service-layer tests that mock Prisma instead of hitting a real test database.
Services own all DB queries and must be tested against real databases; Prisma mocking is
not the mock boundary.

**Mock boundary is the client layer:** `AccountsClient`, `TimeClient`, and other HTTP
clients get test doubles via dependency injection — not Prisma.

**Signal:** `prisma.$transaction.mockResolvedValue`, `jest.spyOn(prisma`, `vi.mock.*prisma`

### T5 — No-duplicate coverage across layers

**Violation:** The same logic is tested at multiple layers (e.g., business logic covered
in both unit tests and integration tests at the handler level). Each layer should test
what only that layer can verify.

**Signal:** Identical assertion sets appearing in both `*.unit.test.ts` and
`*.integration.test.ts` for the same module

### T6 — Layer and speed mismatch

**Violation:** Tests placed in the wrong speed tier. Unit tests must not spawn real DBs or
external processes; integration tests must not mock the DB. Canary tests must not exceed
60s wall time for the full suite.

**Signal:** `DATABASE_URL` access in a `*.unit.test.ts` file; `mock.module(` in an
`*.integration.test.ts` file

### T7 — Canary safety

**Violation:** A canary-eligible smoke or end-to-end test that:
- Is not wrapped with `runCanaryMode` from `tests/helpers/canary.ts`
- Has write operations without `try { ... } finally { /* delete */ }` teardown

**Signal:** Missing `runCanaryMode` in a test file near `TEST_TARGET_URL`; write operations
without a `finally` cleanup block

### T8 — File naming convention

**Violation:** Test files not following `*.unit.test.ts`, `*.integration.test.ts`, or
`*.smoke.test.ts` naming. Misnamed files may be excluded from the test run or coverage
report.

**Signal:** `*.test.ts` without a layer qualifier in a project that uses the three-tier
naming convention; `*.spec.ts` in a project that has standardized on `.test.ts`

### T9 — New service canary wiring

**Violation:** A new service with a Prisma schema is added but its `prisma generate` step
is not added to `.github/workflows/canary.yml`. This breaks every canary run because the
generated client is not available in CI.

**Signal:** New `prisma/schema.prisma` in a service directory with no corresponding
`bunx prisma generate --schema=<service>/prisma/schema.prisma` in `canary.yml`

### T10 — Untested critical logic

**Violation:** Production logic is added in a critical path (auth, payment, data mutation,
error handling) with no corresponding test additions in the same PR.

**Signal:** New handler, service method, or error path added with no `*.test.*` file
touched in the diff; `onError` / error handler modified with no test coverage added

## Confidence Guidance

| Situation | Recommended Confidence |
|-----------|------------------------|
| Tenet is explicitly named in project's CLAUDE.md or test-readiness docs | 80–90 |
| Tenet violation is clear from the diff, no ambiguity | 75 |
| Possible violation but context from unread files could clear it | 50–65 |
| Minor deviation, low real-world impact | 50 |
| Critical-path violation (auth, payment, data integrity) | 85+ |

Use 75 for most violations. Use 80+ for T1 (global mocking) and T10 (untested critical
logic) on critical paths. Drop to 50–65 when you would need to read files not in the diff
to be sure.
