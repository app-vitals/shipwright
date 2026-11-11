# Plan: pr-title-prefix (prefix PTP)

Repo: app-vitals/shipwright

## Problem
`pr-title-lint` (amannn/action-semantic-pull-request) requires PR titles to start with a
Conventional-Commit type (feat fix perf revert docs refactor test build ci chore). plan-session tells
planners to write task titles "short, verb-first" with no prefix, and dev-task Step 9 runs
`gh pr create --title "{title}"` with the raw task title. Result: every dev-task PR on a repo with the
lint fails immediately and needs a manual `gh pr edit`. Seen on CBD-1.1 and again on app-vitals/how-to-factory
(PR #3, 2026-10-10). Squash merge also uses the PR title as the commit subject, so the type matters for changelogs.

## Design
Fix at the source, with a safety net at the point of failure:
1. plan-session (PTP-1.1): task `Title` becomes a Conventional-Commit subject (`type: verb-first summary`), type chosen from the allowed list by the nature of the work (docs-only -> docs, tests-only -> test, CI/workflow -> ci, build/deps -> build, behavior change -> feat or fix, refactor -> refactor, other -> chore). Examples updated. Harmless on repos without the lint.
2. dev-task (PTP-1.2): Step 9 PR title = the task title if it already starts with an allowed type (optionally with scope and `!`); otherwise derive `{type}: {title}` where type comes from the branch prefix when it is an allowed type, else `feat`. Covers legacy tasks and tasks from other planners. Also applies when joining an existing PR? No: only at PR creation.
Existing content tests (plugins/shipwright/commands/*.content.test.ts) pin prompt text; update them with the change.

Breaking-change scan: prompt-only changes. Safe to deploy standalone: yes. HITL scan: none. (Neither task touches .claude/**; commands live in plugins/shipwright/commands.)

## Tasks
| ID | Title | Deps | Model |
|---|---|---|---|
| PTP-1.1 | fix: write plan-session task titles as conventional-commit subjects | — | sonnet |
| PTP-1.2 | fix: derive a conventional PR title in dev-task Step 9 | — | sonnet |

## Decision Log
- Two-layer fix (source + fallback) over fallback only: titles also feed the admin UI and plan tables, and other consumers should see the same subject; fallback alone leaves tasks inconsistent.
- Branch prefix as type source for the fallback, default feat: branches are `feat/...` by plan-session convention so most legacy cases land on feat; correct for the common case, never produces an invalid type.
