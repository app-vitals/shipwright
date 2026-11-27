<!-- shipwright: session=agent-readiness repos=app-vitals/shipwright spec=0001 -->
# Agent Readiness — Product Specification

**Date**: 2026-11-27
**Session**: agent-readiness
**Repos**: app-vitals/shipwright
**Status**: Draft

## Overview

Give every repo a simple, open readiness level from 1 to 5. The level says how ready the repo is for agents to deliver changes autonomously, and the org-wide number is "% of repos at Level 3 or above". A daily `agent-readiness` system cron scores each repo with a deterministic script and records the result, and it fixes nothing itself. Every failing check names the system cron that owns closing it. Two owners cover the checks nothing owned before. Entropy gains built-in code-quality tooling checks (linter, formatter, type checker, pre-commit, CI lint/type). A new `environments` system cron owns how code is built and run: pinned dependencies and tools, the preview environment, staged/canary deploy and the observability baseline. The score is the measure, and the other system crons are the machinery that moves it.

## Problem Statement

Shipwright already has crons that improve repos (tests, docs, security, code quality), but nothing measures whether a repo is ready for autonomous delivery or whether those crons are moving it. An operator cannot answer "how many of our repos can agents work in safely today, and what is blocking the rest?" Several basics have no owner at all: linting, formatting, type checks, pre-commit hooks, a documented build, a reproducible dev environment, and structured logging/error tracking. Without a score there is no target, and without owners some gaps never close.

## Users & Context

- **Operators and engineering leaders** read one number (% of repos at Level 3+) and a per-repo breakdown on the admin page, to see readiness and what's blocking it.
- **Coding agents** pick up the fix tasks that the owning crons (including entropy's new tooling checks and the new `environments` cron) queue. Agents never act on the score directly.
- **Humans** step in only through the standard three-way routing (unblock a review task, or run a plan session for a plan task).

---

## Features

### Feature 1: Readiness model and check catalogue

**Priority**: High
**Description**: An open, versioned definition of the 5 levels and their pass/fail checks. Each check has exactly one owning system cron.

**Requirements**:
- The levels are **1 Basic**, **2 Reproducible**, **3 Agent-ready** (the floor every repo aims for), **4 Fast feedback** and **5 Autonomous**.
- A repo's level is the highest N where every check at levels 1..N passes. There are no points and no partial credit.
- Each check is a pure function of repo files, the GitHub repo settings API and the task-store run history. It returns `pass` | `fail` | `n/a` (e.g. a type checker for a language without one). `n/a` counts as a pass.
- Initial catalogue, with owners (plan-session may refine the exact detection, but not the owners):

  | Level | Check | Owner cron |
  |---|---|---|
  | 1 | README present | docs-freshness |
  | 1 | Linter configured | entropy |
  | 1 | Type checker configured (where the language has one) | entropy |
  | 1 | Unit tests exist | test-readiness |
  | 2 | AGENTS.md or CLAUDE.md present | docs-freshness |
  | 2 | Build and test commands documented | docs-freshness |
  | 2 | Dependencies pinned (lockfile) | environments |
  | 2 | Formatter configured | entropy |
  | 2 | Pre-commit hooks configured | entropy |
  | 2 | Tool versions pinned (tool-version file, container or devcontainer) | environments |
  | 2 | Default branch protected and requires CI | security |
  | 2 | CODEOWNERS present | security |
  | 3 | CI runs lint and type check | entropy |
  | 3 | CI runs tests | test-readiness |
  | 3 | Smoke or end-to-end test layer exists | test-readiness |
  | 3 | Docs fresh (last docs-freshness run ok within 30 days) | docs-freshness |
  | 3 | Secret scanning in CI | security |
  | 3 | Dependency update/scan automation | security |
  | 3 | No open critical security findings | security |
  | 3 | Structured logging | environments |
  | 3 | Error tracking configured | environments |
  | 3 | Preview environment: the stack comes up from a PR's own source, locally and in CI, and the smoke/e2e layer runs against it | environments |
  | 4 | Test suite within its speed budget | test-readiness |
  | 4 | No high-severity entropy findings open | entropy |
  | 4 | Source files over 500 lines ≤ 5% | entropy |
  | 4 | Tracing and metrics instrumented | environments |
  | 4 | Staged or canary deploy | environments |
  | 5 | Every owning cron enabled for the repo and its latest run ok | operator |
  | 5 | No consolidation pattern ready for over 30 days | consolidation |

- The catalogue lives in the plugin as one TypeScript module (the source of truth) plus one human-readable docs page (`docs/readiness.md`) that a test keeps in sync with it.
- Product, docs and UI copy never reference any competitor. Comparisons belong only on a future marketing compare page.

**Acceptance Criteria**:
- [ ] The catalogue module exports every check with level, id, title and exactly one owner from the allowed set (unit test).
- [ ] `docs/readiness.md` lists exactly the catalogue's checks, levels and owners (content test that fails on drift).
- [ ] The level calculation returns the highest fully passing level, treats `n/a` as pass, and returns 0 when a Level 1 check fails (unit tests over fixtures).
- [ ] No file added by this session contains a competitor name (content test using a small banned-word list).

**Source Map**:
- `app-vitals/shipwright`: `plugins/shipwright/scripts/`: new catalogue module, following `check-helpers.ts` conventions
- `app-vitals/shipwright`: `docs/`: new `readiness.md`
- `app-vitals/shipwright`: `CLAUDE.md`: Reference list entry for the new doc

**Testing Strategy**: Layer: unit for the catalogue and level calculation (pure logic). Content for the doc-sync and no-competitor checks.

---

### Feature 2: `agent-readiness` system cron (score only)

**Priority**: High
**Description**: A daily per-repo system cron that runs every check, computes the level, and records the run. It queues no tasks and writes no repo files.

**Requirements**:
- New skill `/shipwright:agent-readiness --repo org/repo` that runs the deterministic scorer script, with no model judgment in scoring.
- It records one `RepoCronRun` (from `patrol-system-crons`) per run: `outcome`, `commitSha`, and `metrics` = `{level, checks: [{id, level, result, owner}]}`.
- Seeded disabled as system-cron `agent-readiness`, daily `0 8 * * *` (after the other crons' early-morning slots), with `repoScope` `all`.
- It follows the system-cron contract from `patrol-system-crons` with two noted exemptions. It queues no fix tasks (rule 5 doesn't apply), and it writes no repo doc (all of its output is numbers, so it lives in the run record).
- Scorer runtime target is under 60 seconds per repo, excluding the clone.

**Acceptance Criteria**:
- [ ] The scorer run against a fixture repo produces the expected level and per-check results (integration test with a fixture repo and recorded GitHub API responses).
- [ ] A scorer run creates zero tasks and modifies zero files in the repo (integration test).
- [ ] A fresh task store seeds `agent-readiness` disabled with schedule `0 8 * * *` (integration test).
- [ ] The skill prints a usage error without `--repo` (content test).

**Source Map**:
- `app-vitals/shipwright`: `plugins/shipwright/skills/`: new `agent-readiness` skill
- `app-vitals/shipwright`: `task-store/src/system-cron-service.ts`: seed definition

**Testing Strategy**: Layer: integration, because the scorer reads a real fixture repo plus recorded GitHub and task-store responses. Content for the skill contract.

---

### Feature 3: Entropy owns code-quality tooling; new `environments` system cron

**Priority**: High
**Description**: Two owners cover the checks nothing owned before. Entropy (already a weekly system cron after `patrol-system-crons`) gains built-in code-quality tooling checks. A new `environments` system cron owns how code is built and run. Both follow the full system-cron contract.

**Requirements**:
- **Entropy, built-in tooling checks.** Alongside each repo's own principles, `entropy-scan` always checks: linter configured, formatter configured, type checker configured (where the language has one), pre-commit hooks, and CI running lint and type check. These are a fixed baseline that needs no per-repo config. Routing: adding a config that matches the detected toolchain, pre-commit hooks, or wiring existing commands into CI is **auto**. Turning on a stricter mode that may break the build is **review**. The findings go in entropy's existing `docs/patrols/entropy.md`, with no new file.
- **New `environments` cron.** New skills `environments-scan --repo` and `environments-fix --repo`, chained in one task. They own: lockfile, pinned tool versions, the preview environment, structured logging, error tracking, tracing/metrics, and staged/canary deploy. Routing:
  - **Auto:** adding a lockfile, or a tool-version file matching the detected toolchain.
  - **Review:** choosing a logging library or error-tracking setup.
  - **Plan:** a preview environment from scratch, tracing/metrics instrumentation, and staged/canary deploy (which builds on the preview environment's canary suite).
- **Environments build on Shipwright's preview environment.** The plan task for a missing preview environment models it on Shipwright's own: one bring-up script used both locally and by a CI composite action, which brings the whole stack up from the PR's source in a throwaway cluster with no real credentials, then runs the smoke/canary and e2e suites against it. Detection looks for an equivalent bring-up entry point plus a CI job that runs tests against it.
- One concise repo doc `docs/patrols/environments.md` (current open items only, 150-line cap). Machine state goes in `machineState`. A PR opens only on material change.
- Seeded disabled as system-cron `environments`, weekly `0 3 * * 1` (Monday 03:00, ahead of the other Monday crons).
- Both reuse the existing toolchain detection used by plan-session/prd (`package.json`+lockfile, `Cargo.toml`, `go.mod`, Maven/Gradle, Python, Ruby, Make).

**Acceptance Criteria**:
- [ ] `entropy-scan --repo` on a fixture repo with no repo-specific principles still reports a missing formatter and missing pre-commit hooks, and `entropy-fix` routes both as auto (integration test).
- [ ] `environments-scan --repo` on a fixture repo with no preview environment routes it as a plan task (`kind: prd`, `hitl: true`) whose description references the preview-environment pattern, and an error-tracking choice routes as a blocked review task (integration test against the task store).
- [ ] `docs/patrols/environments.md` stays under 150 lines and has no count tables (unit test on the renderer).
- [ ] Re-running either cron on an unchanged repo opens no PR and queues no duplicate tasks (integration test).
- [ ] A fresh task store seeds `environments` disabled with schedule `0 3 * * 1` (integration test).

**Source Map**:
- `app-vitals/shipwright`: `plugins/shipwright/skills/entropy-scan/SKILL.md`, `entropy-fix/SKILL.md`: built-in tooling checks
- `app-vitals/shipwright`: `plugins/shipwright/skills/`: new `environments-scan` and `environments-fix` skills, modelled on `entropy-scan`/`entropy-fix` and `test-readiness`
- `app-vitals/shipwright`: `plugins/shipwright/commands/plan-session.md`, `prd.md`: toolchain-detection logic to reuse
- `app-vitals/shipwright`: `docs/preview-environment.md`, `scripts/preview-env.ts`, `.github/actions/preview-env`, `preview/canary/`: the preview-environment pattern the plan task builds on
- `app-vitals/shipwright`: `task-store/src/system-cron-service.ts`: seed definition

**Testing Strategy**: Layer: integration (fixture repos plus a task store for routing). Unit for the doc renderer.

---

### Feature 4: Org readiness summary API

**Priority**: Medium
**Description**: A task-store endpoint that turns the latest `agent-readiness` runs into the org view.

**Requirements**:
- `GET /readiness/summary` returns:
  - `percentAtOrAboveFloor` (Level 3+) and `repoCount`
  - `levelDistribution` (count per level 0–5)
  - `repos`: per repo, the latest level, failing checks with owner, and `scoredAt`
  - `trend`: weekly `percentAtOrAboveFloor` for the last 12 weeks
- It counts only repos whose latest scoring run is within 7 days. Older ones are listed as `stale` and excluded from the percentage.
- Scope rules match the other read routes: agent tokens see only their repos, and admin tokens see everything.

**Acceptance Criteria**:
- [ ] With fixture runs for 4 repos at levels 1, 3, 3 and 4, `percentAtOrAboveFloor` is 75 and `levelDistribution` matches (smoke test).
- [ ] A repo whose latest run is 8 days old appears as `stale` and is excluded from the percentage (smoke test).
- [ ] `trend` returns 12 weekly points computed from each week's latest run per repo (integration test).

**Source Map**:
- `app-vitals/shipwright`: `task-store/src/routes/`: new readiness route, reading the `RepoCronRun` model from `patrol-system-crons`
- `app-vitals/shipwright`: `task-store/openapi.json`, `docs/task-store.md`, `docs/mcp-tools.md`

**Testing Strategy**: Layer: smoke for the route contract. Integration for the trend aggregation against the database.

---

### Feature 5: Admin readiness page

**Priority**: Medium
**Description**: An admin page showing the headline number, each repo's level, what's failing and who owns it, and the trend.

**Requirements**:
- Headline "N% of repos at Level 3+", with repo count and a 12-week trend line.
- A per-repo table showing level, failing checks (lowest level first), and each failing check's owner cron.
- An owner cron that is **disabled or not scoped to that repo** is flagged "no owner running", so a gap nobody is closing is visible.
- Read-only. It links each owner cron to its row on the system-crons settings page.

**Acceptance Criteria**:
- [ ] The page renders the headline percentage, level per repo, and failing checks with owners from a fixture summary (smoke test).
- [ ] A failing check whose owner cron is disabled shows "no owner running" (smoke test).
- [ ] The page text contains no competitor names (covered by Feature 1's content test).

**Source Map**:
- `app-vitals/shipwright`: `admin/src/coding/`: new readiness page plus a nav entry in `coding-settings-nav.ts`
- `app-vitals/shipwright`: `admin/src/coding/task-store-fetchers.ts`, `task-store-types.ts`

**Testing Strategy**: Layer: smoke, because it's an in-process admin route render.

---

## Technical Constraints

- **Depends on `patrol-system-crons`:** `RepoCronRun`, the system-cron contract, three-way routing and the patrol migrations must land first.
- Follow the storage rule. Scores and check results live only in the task store, and the one repo file is `docs/patrols/environments.md`.
- Scoring is deterministic: no LLM calls in the scorer, and the same repo state gives the same result.
- The plugin stays repo-agnostic. Checks detect the toolchain and fall back to `n/a` rather than assuming the stack is TypeScript.
- Test isolation rules apply: fixture repos, recorded GitHub and task-store responses, injected clock and fetch.
- No competitor names in product code, docs or UI.

## Scope

**In Scope**:
- The readiness model and check catalogue, the `agent-readiness` score-only cron, entropy's built-in code-quality tooling checks, the new `environments` cron, the summary API and the admin readiness page.

**Out of Scope**:
- Any fixes queued by `agent-readiness` itself.
- Changes to what the existing owner crons fix, beyond what `patrol-system-crons` already specifies.
- Deeper deployment automation (progressive rollouts, automatic rollback). A future `deployment` system cron may take over the staged/canary check from `environments` and add more checks.
- Outcome metrics (cycle time, autonomy ratio, cost per change). That's a separate, later session.
- Public or shareable readiness reports, badges, and a marketing compare page.
- Per-repo custom floor levels (every repo targets Level 3).

## Priorities & Sequence

1. Session `patrol-system-crons` lands first.
2. Feature 1 (model and catalogue) comes next, because everything else reads it.
3. Feature 2 (scorer cron) and Feature 3 (entropy tooling checks + environments cron) run in parallel after Feature 1.
4. Feature 4 (summary API) follows Feature 2, and Feature 5 (admin page) follows Feature 4.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| 1. Model and catalogue | unit + content | Pure level logic, plus doc-sync and no-competitor content checks |
| 2. agent-readiness cron | integration + content | Scorer reads fixture repos and recorded APIs; skill contract in prose |
| 3. Entropy tooling + environments cron | integration + unit | Fixture repos plus task-store routing; pure doc renderer |
| 4. Summary API | smoke + integration | Route contract plus DB trend aggregation |
| 5. Admin page | smoke | In-process admin route render |

## Resolved Decisions

- **Readiness model**: Our own open model (5 levels, pass/fail checks, versioned in the plugin), kept simple. No competitor is referenced anywhere except a future compare page. — Rationale: Dan, 2026-11-27.
- **Score only**: `agent-readiness` queues no fixes. Every check names one owning cron, and the owners fix. — Rationale: Dan, 2026-11-27. One owner per gap means no duplicate tasks, and the score measures whether the owners work.
- **Owners for the unowned basics**: Code-quality tooling (linter, formatter, type checker, pre-commit, CI lint/type) folds into entropy as built-in checks. A new `environments` cron owns how code is built and run (lockfile, tool versions, preview environment, observability baseline, staged/canary deploy). — Rationale: Dan, 2026-11-27: a single `environments` cron was too generic, and code quality could fold into entropy. Entropy already enforces code standards weekly, and the tooling checks are small auto-routed fixes.
- **Level calculation**: Highest level where every check at that level and below passes, with no points. — Rationale: Dan accepted defaults, 2026-11-27. Easy to explain and act on.
- **Floor**: Level 3 for every repo. — Rationale: Dan accepted defaults, 2026-11-27.
- **Output home**: Scores only in the run record, with no repo file. — Rationale: The storage rule (numbers belong in the task store).
- **Schedules**: `agent-readiness` daily at 08:00 and `environments` weekly on Monday at 03:00, both seeded disabled. No system cron runs less often than weekly. — Rationale: Dan, 2026-11-27: "Nothing is monthly. Weekly is the max for these for now." Daily scoring reflects the other crons' overnight work.
- **Dev environment = preview environment**: The Level 3 dev-environment check is a preview environment built on Shipwright's preview-env pattern. Level 2 only asks for pinned tool versions. — Rationale: Dan, 2026-11-27: "Dev environment should build on our preview environments."
- **Deployment**: The Level 4 staged/canary deploy check stays, owned by `environments` for now. A future `deployment` cron may take it over. — Rationale: Dan, 2026-11-27: "If you already had deployment we can keep it."
- **Staleness**: Scores older than 7 days are excluded from the org percentage. — Rationale: A disabled scorer must not leave a stale, flattering number on the page.

## Success Criteria

- With `agent-readiness` enabled, the admin page shows "N% of repos at Level 3+" for every in-scope repo within a day, each with its level and failing checks with owners.
- Every catalogue check has an owner, and a failing check whose owner isn't running is visibly flagged.
- Enabling `environments` and entropy on a repo missing basics queues correctly routed tasks, and once they merge, that repo's next daily score rises.
- `task ci` is green, and no competitor name appears in product code, docs or UI.
