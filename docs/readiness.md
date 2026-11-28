# Agent Readiness

Shipwright scores each repo from Level 1 to Level 5 on how ready it is for agents to deliver changes autonomously. The org-wide number is the percentage of repos at Level 3 or above, the floor every repo aims for.

The model is open and versioned (catalogue version 1). The source of truth is [`plugins/shipwright/scripts/readiness-catalogue.ts`](../plugins/shipwright/scripts/readiness-catalogue.ts); a content test keeps this page in sync with it.

## How a level is computed

- Each check is a pure function of repo files, the GitHub repo settings API and the task-store run history. It returns `pass`, `fail` or `n/a` (for example a type checker for a language without one).
- `n/a` counts as a pass.
- A repo's level is the highest N where every check at levels 1..N passes. There are no points and no partial credit. A repo failing any Level 1 check is Level 0.
- Each check has exactly one owning system cron. The scorer fixes nothing; the owner closes the gap.

## Levels

- **Level 1** — Basic
- **Level 2** — Reproducible
- **Level 3** — Agent-ready
- **Level 4** — Fast feedback
- **Level 5** — Autonomous

## Checks

### Level 1 — Basic

| Level | Check | Title | Owner |
|---|---|---|---|
| 1 | `readme-present` | README present | docs-freshness |
| 1 | `linter-configured` | Linter configured | entropy |
| 1 | `type-checker-configured` | Type checker configured (where the language has one) | entropy |
| 1 | `unit-tests-exist` | Unit tests exist | test-readiness |

### Level 2 — Reproducible

| Level | Check | Title | Owner |
|---|---|---|---|
| 2 | `agent-instructions-present` | AGENTS.md or CLAUDE.md present | docs-freshness |
| 2 | `build-test-documented` | Build and test commands documented | docs-freshness |
| 2 | `dependencies-pinned` | Dependencies pinned (lockfile) | environments |
| 2 | `formatter-configured` | Formatter configured | entropy |
| 2 | `pre-commit-configured` | Pre-commit hooks configured | entropy |
| 2 | `tool-versions-pinned` | Tool versions pinned (tool-version file, container or devcontainer) | environments |
| 2 | `default-branch-protected` | Default branch protected and requires CI | security |
| 2 | `codeowners-present` | CODEOWNERS present | security |

### Level 3 — Agent-ready

| Level | Check | Title | Owner |
|---|---|---|---|
| 3 | `ci-runs-lint-typecheck` | CI runs lint and type check | entropy |
| 3 | `ci-runs-tests` | CI runs tests | test-readiness |
| 3 | `smoke-e2e-layer-exists` | Smoke or end-to-end test layer exists | test-readiness |
| 3 | `docs-fresh` | Docs fresh (last docs-freshness run ok within 30 days) | docs-freshness |
| 3 | `secret-scanning-ci` | Secret scanning in CI | security |
| 3 | `dependency-automation` | Dependency update/scan automation | security |
| 3 | `no-critical-security-findings` | No open critical security findings | security |
| 3 | `structured-logging` | Structured logging | environments |
| 3 | `error-tracking-configured` | Error tracking configured | environments |
| 3 | `preview-environment` | Preview environment: the stack comes up from a PR's own source, locally and in CI, and the smoke/e2e layer runs against it | environments |

### Level 4 — Fast feedback

| Level | Check | Title | Owner |
|---|---|---|---|
| 4 | `test-suite-speed-budget` | Test suite within its speed budget | test-readiness |
| 4 | `no-high-entropy-findings` | No high-severity entropy findings open | entropy |
| 4 | `large-files-within-limit` | Source files over 500 lines ≤ 5% | entropy |
| 4 | `tracing-metrics-instrumented` | Tracing and metrics instrumented | environments |
| 4 | `staged-canary-deploy` | Staged or canary deploy | environments |

### Level 5 — Autonomous

| Level | Check | Title | Owner |
|---|---|---|---|
| 5 | `owner-crons-running` | Every owning cron enabled for the repo and its latest run ok | operator |
| 5 | `no-stale-consolidation-pattern` | No consolidation pattern ready for over 30 days | consolidation |

## Owners

- **docs-freshness** — README, agent instructions, documented commands, docs freshness
- **entropy** — linter, formatter, type checker, pre-commit, CI lint/type, code-health findings
- **test-readiness** — unit, CI test and smoke/e2e layers, speed budget
- **environments** — lockfile, pinned tool versions, preview environment, observability, staged/canary deploy
- **security** — branch protection, CODEOWNERS, secret scanning, dependency automation, security findings
- **consolidation** — long-ready consolidation patterns
- **operator** — enabling the owning crons for the repo
