# Plan: coverage-tracking

Repo: app-vitals/shipwright
Spec: planning/coverage-tracking/PRODUCT-SPEC.md

## Technical Design

**Business logic (plugin)** — `plugins/shipwright/scripts/coverage-summary.ts` plus one-parser-per-file
modules under `plugins/shipwright/scripts/coverage/` (`lcov`, `cobertura`, `jacoco`, `go-cover`,
`detect`, `normalize`). Follows the `is-ci-green.ts` / `check-helpers.ts` pattern: pure logic plus an
injected command runner and HTTP client. No imports from repo-root `scripts/`; lcov parsing is ported
from `scripts/check-coverage.ts`, not shared.

**DB / API (task-store)** — new `CoverageSnapshot` model (unique `(accountId, repo, commitSha)`, index
`(repo, measuredAt)`) with migration; `coverage-snapshot-service.ts` and `routes/coverage-snapshots.ts`
modelled on the verification-check service/router. `accountId` comes from `resolveAccountScope`
(agent tokens) or the request (admin tokens), since a snapshot has no parent task/PR. Percentages are
computed server-side. Routes: `POST /coverage-snapshots` (201/200 upsert), `GET /coverage-snapshots`,
`GET /coverage-snapshots/latest`. `openapi.json` and `docs/mcp-tools.md` regenerated in the same PR.

**Metrics** — new `coverage` query kind on `TaskStoreProvider` (next to `mergedPrsByRepo`), fixtures
in `task-store-recorded.ts`, `GET /metrics/coverage` in `api.ts` (same auth as other `/metrics/*`,
not under `/public/*`), stale = >14 days via injected `Clock`.

**Views** — "Coverage by repo" section in `dashboard-page.ts` / `app.js`, reusing the merged-PRs repo
picker and trend-chart helpers; omitted from the public dashboard.

**Skills** — orchestrator records coverage before the phase loop (never blocks phases);
`test-migration` Step 4c and `test-roadmap` Process step 8 source line coverage from the reader;
`test-design` / template record report path + upload step; `test-roadmap` auto-emits a publish-artifact
task on `not_reporting`; `repo-config` lifecycle gains "CI publishes `shipwright-coverage`". All
reference `references/coverage-output.md`. One plugin version bump (bundled branch).

**CI** — `ci.yml` `ci` job uploads `coverage/lcov.info` as `shipwright-coverage` with `if: always()`;
existing `contents: read` suffices.

## Test strategy
Reader: unit. Storage: smoke (`app.request()`). Skills: content. Dashboard: e2e + unit (provider) +
smoke (route). CI: one real run plus one reader invocation.

## Tasks

| Task | Title | Layer | Depends on | Blocks | Branch | Model | HITL |
|------|-------|-------|-----------|--------|--------|-------|------|
| CVT-1.1 | feat: coverage report parsers | Shared | — | 1.2 | feat/cvt-1-1-coverage-report-parsers | sonnet | |
| CVT-1.2 | feat: coverage-summary.ts artifact reader | CLI | 1.1 | 1.3, 4.x, 5.2 | feat/cvt-1-2-coverage-summary-reader | sonnet | |
| CVT-1.3 | docs: coverage-output.md contract | Shared | 1.2 | 4.1, 4.2, 4.3 | docs/cvt-1-3-coverage-output-reference | haiku | |
| CVT-2.1 | feat: coverage snapshot storage | API | — | 3.1, 5.2 | feat/cvt-2-1-coverage-snapshot-storage | sonnet | |
| CVT-3.1 | feat: /metrics/coverage endpoint | API | 2.1 | 3.2 | feat/cvt-3-1-metrics-coverage-endpoint | sonnet | |
| CVT-3.2 | feat: Coverage by repo dashboard section | Frontend | 3.1 | 5.2 | feat/cvt-3-2-coverage-dashboard-section | sonnet | |
| CVT-4.1 | feat: test-readiness records coverage | Shared | 1.2, 1.3 | — | feat/cvt-coverage-skills | sonnet | |
| CVT-4.2 | feat: test-migration/roadmap use reader | Shared | 1.2, 1.3 | — | feat/cvt-coverage-skills | sonnet | |
| CVT-4.3 | feat: test-design fields + publish task | Shared | 1.3 | — | feat/cvt-coverage-skills | sonnet | |
| CVT-5.1 | ci: publish shipwright-coverage artifact | Shared | — | 5.2 | ci/cvt-5-1-publish-coverage-artifact | haiku | |
| CVT-5.2 | chore: verify own coverage end to end | Shared | 1.2, 2.1, 3.2, 5.1 | — | chore/cvt-5-2-verify-own-coverage | haiku | |

## Dependency Map

```
[START]
  ├─ CVT-1.1 parsers
  │     └─ CVT-1.2 reader
  │           └─ CVT-1.3 coverage-output.md
  │                 ├─ CVT-4.1 orchestrator + repo-config  ┐
  │                 ├─ CVT-4.2 migration + roadmap gate     ├ one bundled PR
  │                 └─ CVT-4.3 design + template + publish  ┘  (4.1/4.2 also need 1.2; 4.3 needs 1.3)
  ├─ CVT-2.1 snapshot storage
  │     └─ CVT-3.1 /metrics/coverage
  │           └─ CVT-3.2 dashboard section
  └─ CVT-5.1 CI uploads artifact
CVT-5.2 verify end to end (needs 1.2, 2.1, 3.2, 5.1)
```

## Breaking Change Safety
All tasks are additive (new files, new model, new endpoints, new CI step). The only edits to existing
behavior are skill text (CVT-4.x). Safe to deploy standalone: yes for every task. The new migration adds
a new table only — no constraint on existing rows.

## Assumptions
- The reader reads the latest snapshot via `GET /coverage-snapshots?repo=&limit=1`; CVT-1.2 and CVT-2.1
  both cite that contract and test it through injected doubles.
- The metrics service's existing task-store credential can read `/coverage-snapshots`; CVT-3.1 verifies
  this first and blocks if not.
- CVT-5.2 needs a task store reachable from the agent; flip to HITL if not.

## Not carried
- "`task ci` / `task e2e` pass" — enforced by the repo merge gate on every PR.
- `test-migration` Step 4a and `speed-budgets` Tier 1 still name the CI job for wall-clock timing —
  outside the coverage scope of the spec; follow-up not queued.
