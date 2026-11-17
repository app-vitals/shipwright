# Cross-Repo Coverage Tracking — Product Specification

**Date**: 2026-11-16
**Session**: coverage-tracking
**Status**: Draft

## Overview

Every repository that goes through Shipwright's test-readiness pipeline publishes its test
coverage the same way, whatever language it is written in: its CI uploads the native
coverage report as a workflow artifact named `shipwright-coverage`. Each test-readiness run
reads those artifacts, records one coverage snapshot per default-branch commit in the task
store, and the Metrics dashboard shows coverage % per repo with a trend. It is for anyone
operating a Shipwright installation who wants to see coverage across all their repos in one
place.

## Problem Statement

The test-readiness pipeline already depends on coverage, but the number never leaves the
repo it was measured in and the way it is obtained only works for one repo layout:

- The migration phase obtains line coverage by grepping a `Lines: NN.NN% (…)` line out of
  the logs of a CI job named `lint / typecheck / test` and a step named `Test`. Those names
  exist only in this repository's own workflow, so the step returns `null` everywhere else.
- `scripts/check-coverage.ts` reads only `coverage/lcov.info` and exits non-zero for any
  non-lcov toolchain ("no report-path dispatch exists yet for non-lcov tools"). It lives at
  the repo root, not in the plugin, so it is not available in a target repo.
- No task-store model holds an absolute per-repo coverage percentage. The only coverage
  figure on any dashboard is the per-task `Task.coverageDelta`.

As a result there is no way to answer "what is the coverage of each of my repos, and is it
going up or down?", and repos not written in a JS/TS toolchain cannot participate at all.

## Users & Context

- **Installation operator / engineering lead** — opens the Metrics dashboard to see current
  coverage per repo and how it has moved, without visiting each repo's CI.
- **Repo maintainer** — adds one upload step to their existing test job. They keep their own
  language's coverage tool and do not adopt any Shipwright-specific script or secret.
- **The test-readiness agent run** — consumes the same number for the roadmap's coverage
  gate, replacing the log-scraping path.

Shipwright is open source: every part of this must work on any installation, against any
GitHub host the `gh` CLI is configured for, with no organisation, repository, workflow, job
or step name baked in.

---

## Features

### Feature 1: Coverage report reader (plugin)

**Priority**: High
**Description**: A plugin script that finds a repo's `shipwright-coverage` artifacts on its
default branch, normalizes whatever report format is inside to covered/total counts, and
optionally records the result in the task store. Includes the written contract a repo
follows to publish the artifact.

**User Stories**:
- As a repo maintainer, I want to publish coverage by uploading the report my test tool
  already writes, so that I do not have to add or maintain a conversion script.
- As the test-readiness run, I want a single command that returns a cited coverage number
  for any repo, so that I never guess or scrape logs.

**Requirements**:
- New `plugins/shipwright/scripts/coverage-summary.ts`, invoked with `bun run` like the
  other plugin scripts. Arguments: `--repo {owner}/{repo}` (required), `--record`,
  `--max-backfill {n}` (default 50).
- Resolve the repo's default branch from the GitHub API; list artifacts named
  `shipwright-coverage`; keep those that are unexpired and whose workflow run is on the
  default branch.
- Select every artifact newer than the repo's latest stored snapshot (queried from the task
  store), oldest first. With no stored snapshot, or more candidates than `--max-backfill`,
  take the newest `--max-backfill`. When several artifacts share a commit SHA (re-runs),
  use the newest.
- Detect each file's format from its content, not its name or extension:
  - lcov — `SF:` / `LF:` / `LH:` records (also `BRF`/`BRH`, `FNF`/`FNH` when present)
  - Cobertura XML — root `<coverage>` element with `line-rate`
  - JaCoCo XML — `<report>` element with report-level `<counter type="LINE">`
  - Go coverprofile — first line `mode: set|count|atomic`
  - `shipwright-coverage.json` — recognised by file name; already in normalized shape
- Normalized shape: `{ lines: {covered, total}, branches?: {covered, total},
  functions?: {covered, total}, tool }`. `lines` is required; `branches` and `functions`
  are omitted when the report does not carry them. Percentages are always computed from
  covered/total and never read from the report.
- An artifact may contain several report files (monorepo); counts are summed across files.
  Files that match no format are ignored; an artifact with no recognised file is skipped.
- Output is JSON on stdout: an array of per-commit results, each with the normalized counts
  plus `commitSha`, `branch`, `runUrl`, `measuredAt` (the artifact's creation time). The run
  URL comes from the GitHub API response, never from a hard-coded host.
- With `--record`, POST each result to the task store using `SHIPWRIGHT_TASK_STORE_URL` and
  `SHIPWRIGHT_TASK_STORE_TOKEN`. Without those env vars, `--record` reports
  `record_skipped` and still prints the results.
- When there is no artifact, only expired artifacts, or nothing parseable, exit 0 with
  `{"status":"not_reporting","reason":"…"}`. A number is never estimated or carried forward.
- Parsers live as small single-purpose files under `plugins/shipwright/scripts/coverage/`
  (`lcov.ts`, `cobertura.ts`, `jacoco.ts`, `go-cover.ts`, `detect.ts`, `normalize.ts`).
- New `plugins/shipwright/references/coverage-output.md`: the contract (artifact name,
  accepted formats, the JSON escape hatch, "CI must run on pushes to the default branch"),
  an example upload step, and a per-language recipe table giving the native reporter command
  and report path for at least JS/TS (Bun, Jest, Vitest), Python, Go, Rust, Java/Kotlin,
  .NET, Ruby and PHP.

**Acceptance Criteria**:
- [ ] Given fixture reports in lcov, Cobertura, JaCoCo and Go coverprofile format for the
      same known counts, each parser returns the expected `lines.covered` / `lines.total`
- [ ] A fixture artifact containing two lcov files returns the sum of both
- [ ] A Go coverprofile result has no `branches` or `functions` keys
- [ ] A `shipwright-coverage.json` file is accepted as-is and a file with `covered > total`
      or a missing `lines` object is rejected as unparseable
- [ ] With injected GitHub responses containing artifacts on the default branch and on a
      feature branch, only default-branch artifacts are processed
- [ ] With a stored latest snapshot, only artifacts created after it are processed, oldest
      first; with none, at most `--max-backfill` newest are processed
- [ ] Two artifacts for one commit SHA produce one result, from the newer artifact
- [ ] No artifact, expired-only, and unparseable-only inputs each exit 0 and print
      `status: "not_reporting"` with a distinct `reason`
- [ ] `--record` issues one POST per result; a failed POST is reported per commit and does
      not abort the remaining commits
- [ ] The script source contains no organisation, repository, workflow, job or step name
- [ ] `task ci` passes

**Technical Considerations**: Follow the existing plugin-script pattern (pure logic plus an
injected command runner and HTTP client, as in `scripts/is-ci-green.ts` and
`scripts/check-helpers.ts`) so tests need no `mock.module()` or `global.fetch` override.
Use `gh api` for artifact listing and `gh run download --name shipwright-coverage` for
download, which handles unzipping without an extra dependency. Cobertura and JaCoCo need
only root-level attributes and report-level counters, so no XML library is required; when a
Cobertura root lacks `lines-covered` / `lines-valid`, count `<line hits=…>` elements. The
plugin must not import from the repo-root `scripts/` directory (the plugin ships
standalone); port the lcov record parsing from `scripts/check-coverage.ts` rather than
importing it.

**Source Map**:
- `plugins/shipwright/scripts/is-ci-green.ts` — pattern for a `gh`-driven plugin script
- `plugins/shipwright/scripts/check-helpers.ts` — shared helpers for plugin scripts
- `scripts/check-coverage.ts` — existing lcov parsing to port (not modified)
- `scripts/coverage-tool-dispatch.ts` — existing toolchain names to stay consistent with
- `plugins/shipwright/references/` — home for the new `coverage-output.md`

**Testing Strategy**: Layer: unit — parsers, detection, selection and backfill logic are
pure; GitHub and task-store calls go through injected doubles with recorded responses.

---

### Feature 2: Coverage snapshot storage (task store)

**Priority**: High
**Description**: A task-store record and endpoints that hold one coverage snapshot per repo
per commit, so coverage has a durable, queryable history.

**User Stories**:
- As the coverage reader, I want to record a snapshot idempotently so that re-running a
  test-readiness run never creates duplicates.
- As the metrics service, I want the latest snapshot per repo and each repo's history so
  that I can render a table and a trend.

**Requirements**:
- New Prisma model `CoverageSnapshot`: `id`, `accountId`, `repo` (`owner/repo`), `branch`,
  `commitSha`, `linesCovered`, `linesTotal`, `linesPct`, optional
  `branchesCovered`/`branchesTotal`/`branchesPct`, optional
  `functionsCovered`/`functionsTotal`/`functionsPct`, `tool`, optional `runUrl`,
  `measuredAt`, `createdAt`. Unique on `(accountId, repo, commitSha)`; index on
  `(repo, measuredAt)`. Shipped with a migration.
- `POST /coverage-snapshots` — body carries counts, not percentages; the server computes
  each percentage. Upserts on `(accountId, repo, commitSha)`. Returns 201 on create and 200
  on update.
- `GET /coverage-snapshots?repo=&since=&limit=&offset=` — history for one repo, newest
  first, returning `{ snapshots, total, limit, offset }`.
- `GET /coverage-snapshots/latest` — the most recent snapshot for each repo visible to the
  caller.
- Validation: `linesTotal > 0`, `covered <= total` for every pair, `commitSha` non-empty,
  `repo` in `owner/repo` form; violations return 400.
- Token scoping matches the existing routes: an agent token may write only for repos in its
  scope (else 403) and reads only its own account's rows; admin tokens are unrestricted and
  may pass `accountId`.
- Routes are OpenAPI-described like the existing routers; `task-store/openapi.json` and the
  generated `docs/mcp-tools.md` are regenerated; `docs/task-store.md` documents the model
  and endpoints.

**Acceptance Criteria**:
- [ ] POST with valid counts returns 201 and a body whose `linesPct` equals
      `covered / total * 100`
- [ ] A second POST for the same repo and commit returns 200, updates the row, and the
      table still holds one row for that commit
- [ ] POST with `linesTotal: 0`, with `covered > total`, or with a malformed `repo` returns
      400
- [ ] An agent token POSTing for a repo outside its scope receives 403
- [ ] `GET /coverage-snapshots?repo=X` returns only repo X, ordered newest first, and
      honours `since` and `limit`
- [ ] `GET /coverage-snapshots/latest` returns exactly one row per repo, each the newest by
      `measuredAt`
- [ ] An agent token's GET never returns another account's rows
- [ ] The OpenAPI document includes the three routes and `task ci` passes

**Technical Considerations**: Model the router and service on
`task-store/src/routes/verification-checks.ts` and its service. Unlike a verification
check, a snapshot has no parent task or PR to inherit `accountId` from, so the account
comes from the token's resolved scope (agent tokens) or the request (admin tokens).

**Source Map**:
- `task-store/prisma/schema.prisma` — adds `CoverageSnapshot`
- `task-store/src/app.ts` — registers the new router
- `task-store/src/routes/verification-checks.ts` — pattern to follow
- `task-store/src/verification-check-service.ts` — service and scope pattern to follow
- `task-store/src/openapi-schemas.ts` — adds request/response schemas
- `task-store/openapi.json` — regenerated
- `docs/task-store.md`, `docs/mcp-tools.md` — documentation

**Testing Strategy**: Layer: smoke — HTTP route contracts exercised in-process via
`app.request()`, as `verification-checks.smoke.test.ts` does.

---

### Feature 3: Test-readiness pipeline integration (plugin skills)

**Priority**: High
**Description**: The test-readiness pipeline records coverage on every run, uses the reader
for its own coverage figure, and makes sure a repo that is not yet publishing gets a task
to start.

**User Stories**:
- As an operator, I want coverage recorded whenever test-readiness runs for a repo, so that
  the dashboard fills in without a separate job.
- As a maintainer of a repo new to test readiness, I want the roadmap to tell me exactly
  which CI step to add for my language.

**Requirements**:
- `skills/test-readiness/SKILL.md` (orchestrator): a new step that runs
  `coverage-summary.ts --repo {repo} --record` before the phase loop. It runs on every
  invocation regardless of phase staleness, and its failure or a `not_reporting` result
  never stops the phases.
- `skills/test-migration/SKILL.md` Step 4c: replace the job-name / step-name log grep with
  the reader's output for line (and, when present, function and branch) coverage. Keep the
  "never guess" rule and the explicit citation of run URL and commit SHA; `not_reporting`
  yields `null`.
- `skills/test-design/SKILL.md` Step 6: alongside the coverage toolchain, record the native
  report path and the artifact upload step.
- `assets/templates/test-system.md.tmpl`: add the `**Coverage toolchain:**` and report-path
  fields the skill already expects.
- `skills/test-roadmap/SKILL.md`: when the reader returns `not_reporting`, auto-emit a task
  "Publish the `shipwright-coverage` artifact from CI" whose body contains the upload step,
  the native reporter command for the recorded toolchain, and a check that the workflow
  runs on pushes to the default branch. No such task is emitted when the repo is reporting.
- `skills/repo-config/SKILL.md` coverage-check lifecycle: add "CI publishes
  `shipwright-coverage`" as the step before "coverage must not decrease".
- All skill text references `references/coverage-output.md` instead of restating the
  contract, and names no specific repository, workflow, job or step.
- Plugin version bumped per the repo's plugin release checklist.

**Acceptance Criteria**:
- [ ] The orchestrator skill contains the record step ahead of the phase loop and states
      that it runs even when all phases are fresh and never blocks them
- [ ] `test-migration` Step 4c no longer contains the strings `lint / typecheck / test` or
      a `Test` step-name instruction, and instructs use of `coverage-summary.ts`
- [ ] `test-system.md.tmpl` contains a `**Coverage toolchain:**` field and a report-path
      field
- [ ] `test-roadmap` documents emitting the publish-artifact task on `not_reporting` and
      not emitting it otherwise
- [ ] `repo-config` lists publishing the artifact as the first coverage lifecycle step
- [ ] Content tests assert each of the above and pass under `task ci`
- [ ] `task check-version-sync` passes after the version bump

**Technical Considerations**: The roadmap's coverage gate (`scripts/check-coverage-gate.ts`)
keeps its current inputs; only the source of `line_coverage_pct` changes. The test-readiness
system cron is seeded `enabled: false` and this work does not change that or add a cron, so
no agent migration is needed.

**Source Map**:
- `plugins/shipwright/skills/test-readiness/SKILL.md` — new record step
- `plugins/shipwright/skills/test-migration/SKILL.md` — Step 4c rewritten
- `plugins/shipwright/skills/test-design/SKILL.md` — Step 6 extended
- `plugins/shipwright/skills/test-roadmap/SKILL.md` — auto-emitted task
- `plugins/shipwright/skills/repo-config/SKILL.md` — lifecycle step
- `plugins/shipwright/assets/templates/test-system.md.tmpl` — new fields
- `plugins/shipwright/.claude-plugin/plugin.json` and marketplace entry — version bump

**Testing Strategy**: Layer: content — the changes are skill and template Markdown;
`*.content.test.ts` assertions on required sections and wording.

---

### Feature 4: Coverage by repo on the Metrics dashboard

**Priority**: High
**Description**: A metrics endpoint and a dashboard section that show each repo's current
coverage and its history.

**User Stories**:
- As an operator, I want one table of every reporting repo with its current line coverage
  and recent change, so that I can spot low or falling coverage at a glance.
- As an operator, I want a trend per repo so that I can see direction over time.

**Requirements**:
- `GET /metrics/coverage` returns
  `{ repos: [{ repo, linesPct, branchesPct, functionsPct, commitSha, measuredAt,
  deltaVsPrevious, stale }], trend: [{ repo, measuredAt, commitSha, linesPct }] }`.
  `deltaVsPrevious` is the line-percentage difference from the repo's previous snapshot
  (`null` when there is none). `stale` is true when `measuredAt` is more than 14 days old.
- Same authentication as the other `/metrics/*` routes. Not exposed under `/public/*`.
- The task-store provider fetches latest snapshots and history; `fixtures` mode serves
  fixture data so the dashboard works offline.
- Dashboard section "Coverage by repo":
  - a table with repo, lines %, change since previous snapshot, and last measured date;
    stale rows are visibly marked
  - a trend line chart with a repo picker (all repos, or one), one point per snapshot
  - an empty state explaining how a repo starts reporting when no snapshots exist
- The section is omitted from the public read-only dashboard.
- The existing per-task "Coverage" delta panel is unchanged.
- `docs/metrics.md` documents the endpoint and section.

**Acceptance Criteria**:
- [ ] With fixture snapshots for two repos, `GET /metrics/coverage` returns two `repos`
      entries with correct `linesPct` and `deltaVsPrevious`
- [ ] A repo whose only snapshot is the first has `deltaVsPrevious: null`
- [ ] A repo whose latest snapshot is older than 14 days (by the injected clock) has
      `stale: true`
- [ ] An unauthenticated request to `/metrics/coverage` is rejected like other
      `/metrics/*` routes, and `/public/metrics/coverage` does not exist
- [ ] The dashboard renders the "Coverage by repo" table with one row per fixture repo and
      a trend chart canvas
- [ ] Selecting a repo in the picker restricts the chart to that repo's series
- [ ] With no snapshots, the section shows the empty state and no chart error is logged to
      the console
- [ ] The public dashboard page does not contain the section
- [ ] `task ci` and `task e2e` pass

**Technical Considerations**: Reuse the "Merged PRs by repo" implementation: the repo
picker (`populateMergedPrsRepoSelect` / `initMergedPrsRepoSelect`), the per-repo filtered
trend chart (`drawMergedPrsTrendChart`) and `makeDataset` in `metrics/src/dashboard/app.js`.
The metrics service has no storage; everything is derived from the task store per request.
Use the injected `Clock` for the stale calculation.

**Source Map**:
- `metrics/src/providers/task-store-provider.ts` — fetch snapshots
- `metrics/src/providers/task-store-recorded.ts` — recorded fixtures
- `metrics/src/select-provider.ts` — provider interface
- `metrics/src/api.ts` — new route
- `metrics/src/dashboard/dashboard-page.ts` — new section markup
- `metrics/src/dashboard/app.js` — table and chart rendering
- `metrics/e2e/dashboard.e2e.ts` — e2e assertions
- `docs/metrics.md` — documentation

**Testing Strategy**: Layer: e2e for the rendered section (Playwright against the metrics
test server), with unit tests for the provider aggregation and a smoke test for the route
contract.

---

### Feature 5: This repository publishes its own coverage artifact

**Priority**: Medium
**Description**: The repository's own CI uploads its existing lcov report as the
`shipwright-coverage` artifact, making it the first reporting repo and the end-to-end proof.

**User Stories**:
- As a Shipwright contributor, I want the project to follow its own contract so that the
  dashboard has real data and the recipe is proven.

**Requirements**:
- The CI job that runs `task test:coverage` uploads `coverage/lcov.info` as an artifact
  named `shipwright-coverage`, on every run, including when the coverage gate fails (the
  report still exists).
- No new secret, permission scope beyond what the upload action needs, or third-party
  service.
- Artifact retention left at the repository default.

**Acceptance Criteria**:
- [ ] A CI run on the default branch lists an artifact named `shipwright-coverage`
      containing `lcov.info`
- [ ] Running `coverage-summary.ts --repo` against this repository after such a run returns
      `lines.covered` / `lines.total` equal to the sums of the `LH:` / `LF:` records in
      that run's `lcov.info`
- [ ] The workflow still passes the repository's workflow lint and least-privilege checks

**Technical Considerations**: The workflow already triggers on `push` to the default branch
and on pull requests. `check-coverage.ts` applies path excludes before gating, so its
printed total can differ from the raw report total; see Resolved Decisions.

**Source Map**:
- `.github/workflows/ci.yml` — adds the upload step to the `ci` job

**Testing Strategy**: Layer: smoke — verified by a real CI run and one reader invocation;
no new automated test beyond existing workflow checks.

---

## Technical Constraints

- **Installation-agnostic.** No organisation, repository, workflow, job, step or host name
  in plugin scripts, skills, services or docs examples. `task check-strings` must pass.
- **Plugin stays standalone and repo-agnostic.** Plugin scripts must not import from the
  repo-root `scripts/` directory, and must run with only `bun` and `gh` available.
- **Test isolation.** No `mock.module()`, no `global.fetch` or other global overrides;
  inject time via `Clock`; external clients via injected doubles or recorded fixtures.
- **Tests land with the code, at the layer named by the file suffix** (`.unit.test.ts`,
  `.smoke.test.ts`, `.content.test.ts`, e2e).
- **Metrics service has no database.** All coverage data is read from the task store.
- **Never guess a coverage number.** Absent or unparseable data is reported as
  `not_reporting` / `null`.
- **Env var namespacing.** Any new variable follows `SHIPWRIGHT_<SUBSERVICE>_<THING>`; this
  work is expected to need none.
- **No new system cron**, and no change to the `enabled: false` default of the existing
  test-readiness cron.
- **Small, focused files** — one parser per file; router and service separate.
- **Conventional Commits**; `task ci` green before each PR.

## Scope

**In Scope**:
- The `shipwright-coverage` artifact contract and its reference doc
- Plugin reader with lcov, Cobertura, JaCoCo, Go coverprofile and JSON support
- Task-store `CoverageSnapshot` model, migration and three endpoints
- Test-readiness skill and template changes, including the auto-emitted publish task
- `/metrics/coverage` and the "Coverage by repo" dashboard section
- This repository's CI publishing the artifact

**Out of Scope**:
- Reconciling the differing coverage targets (80% floor, tiered table, 90% gate, per-repo
  thresholds)
- Making the repo-root `scripts/check-coverage.ts` CI gate multi-language
- A CI-push transport or a deterministic sweep; near-real-time updates
- Exposing coverage on the public dashboard, or an admin UI page
- Per-file, per-package or per-PR coverage; coverage on pull-request runs
- Adding the upload step to any other repository (each adopts through its own
  test-readiness roadmap task)
- CI systems other than GitHub Actions

## Priorities & Sequence

1. Feature 2 (task store) and Feature 1 (reader) have no dependency on each other and can
   be built in parallel. The reader's `--record` path is tested against an injected client,
   so it does not wait on Feature 2.
2. Feature 3 (skills) depends on Feature 1.
3. Feature 4 (dashboard) depends on Feature 2.
4. Feature 5 (own CI) depends on Feature 1 for its verification step; the workflow change
   itself can land any time.

End-to-end verification needs Features 1, 2, 4 and 5 merged.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| Coverage report reader | unit | Pure parsing and selection logic; GitHub and task-store access injected |
| Coverage snapshot storage | smoke | HTTP route contracts via in-process `app.request()` |
| Test-readiness pipeline integration | content | Markdown skill and template changes asserted by content tests |
| Coverage by repo dashboard | e2e (+ unit, smoke) | Browser-rendered section; provider aggregation unit-tested; route contract smoke-tested |
| Own CI publishes the artifact | smoke | One real CI run plus one reader invocation |

## Resolved Decisions

- **Language support**: All common languages, by accepting native report formats (lcov,
  Cobertura, JaCoCo, Go coverprofile) plus a JSON escape hatch. — Rationale: every major
  ecosystem can emit at least one of these without extra tooling.
- **Repo-side contract**: Upload the native report as a workflow artifact named
  `shipwright-coverage`; conversion happens in the plugin. — Rationale: one CI step, no
  per-repo script, no secret, no shared action tied to any organisation.
- **Transport**: The test-readiness run reads and records coverage. — Rationale: chosen by
  the product owner; no new sweep, endpoint exposure or CI credential.
- **Granularity**: One snapshot per default-branch commit, recorded in batches on each
  test-readiness run, capped at 50 on first run or after a long gap. — Rationale: per-commit
  history without changing the transport; the cap bounds downloads.
- **Display surface**: Metrics dashboard, internal only. — Rationale: it already has charts
  and a per-repo view; the public surface is scoped to a single repo.
- **Headline metric**: Line coverage; branch and function coverage stored and returned when
  the report has them. — Rationale: line coverage is the only figure every format provides.
- **Which repos appear**: Any repo with at least one snapshot; there is no enable flag.
  — Rationale: no per-repo test-readiness flag exists today, and the roadmap task brings
  each test-readiness repo into reporting.
- **Percentages**: Computed by Shipwright from covered/total, in both the reader and the
  task store. — Rationale: report-supplied rates differ in rounding and definition.
- **Parser ownership**: Parsers live in the plugin; the repo-root `check-coverage.ts` is not
  refactored to share them. — Rationale: the plugin cannot depend on repo-root code, and
  changing the CI gate is out of scope. _(Can be revisited before plan-session.)_
- **Path excludes**: The reader reports the raw total of the uploaded report and applies no
  excludes. A repo that wants excludes applied configures them in its coverage tool so they
  are reflected in the report. — Rationale: keeps the reader language-neutral; for this
  repository the dashboard figure may differ slightly from the gate's figure, which is
  documented in `coverage-output.md`. _(Can be revisited before plan-session.)_
- **Stale threshold**: A repo's row is marked stale after 14 days without a new snapshot.
  — Rationale: long enough to ignore a quiet week on a daily schedule, short enough to
  catch a broken upload step. _(Can be revisited before plan-session.)_
- **Account for a snapshot**: Taken from the token's resolved scope for agent tokens, from
  the request for admin tokens. — Rationale: a snapshot has no parent task or PR to inherit
  it from.
- **Cron default**: The test-readiness cron stays disabled by default. — Rationale: plugin
  rule that crons ship disabled; operators opt in. Coverage is recorded only for repos
  where test readiness is run.

## Success Criteria

- On a fresh installation with the test-readiness run executed for two repos in different
  languages (one lcov, one non-lcov) that publish the artifact, the Metrics dashboard shows
  both repos in "Coverage by repo" with correct line percentages and a trend point per
  default-branch commit.
- A repo that does not publish the artifact gets a roadmap task telling it how, and shows
  no fabricated number anywhere.
- The test-migration phase obtains its coverage figure through the reader for any repo,
  with no reference to a specific workflow, job or step name.
- Re-running test readiness for the same repo creates no duplicate snapshots.
- This repository's own coverage appears on its installation's dashboard.
- `task ci` and `task e2e` pass, and a search of the change for organisation- or
  repository-specific identifiers finds none.
