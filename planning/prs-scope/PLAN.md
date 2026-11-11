# Plan: prs-scope — enforce agent-token repo scope on /prs routes

Repo: app-vitals/shipwright

## Problem
`task-store/src/routes/prs.ts` scopes only `claim`, `claim-next`, `census`, `census/cursor`
and `PATCH /prs/:id` to the agent token's repos. `GET /prs`, `GET /prs/:id`,
`GET /prs/:id/events` and the lifecycle writes (`heartbeat`, `complete`, `patch`, `release`,
`skip`, `skip-reset`, `findings`) take no scope check, so any agent token can read or mutate
PRs in repos outside its scope.

## Design
- **List:** new `repoScope` filter in `PullRequestService.list()`, ANDed with caller `?repo`/`?org`.
  Out-of-scope filters yield an empty list (mirrors `/tasks`).
- **`:id` routes:** shared helper does `prService.get(id)`, checks `repos` (agent tokens only;
  admin `repos === null` bypasses) and returns 404 "pr not found" for missing OR out-of-scope
  (no existence leak). Applied to all `:id` routes including `PATCH /:id`.
- **`repos: []`:** zero access (auth.ts documents `[]` as fail-safe restrictive). Fails closed on
  scope-resolver outage.
- **Unchanged:** `claim` stays 400, `census` stays 403.

## Breaking-change scan
Consumers of `GET /prs` / `GET /prs/:id`: agent (already scoped), metrics task-store client,
admin UI. Metrics/admin must be confirmed to use admin-type tokens (PRG-1.1) before enforcement
lands. Safe to deploy standalone after PRG-1.1.

## Tasks
| Task | Layer | Depends on | Branch | Model |
|---|---|---|---|---|
| PRG-1.1 Verify metrics/admin token types for /prs reads | Shared | — | feat/prg-1-1-verify-token-types | haiku |
| PRG-1.2 Scope GET /prs list by token repos | API | 1.1 | feat/prg-prs-repo-scope (bundle) | sonnet |
| PRG-1.3 Scope all :id routes via shared guard | API | 1.1 | feat/prg-prs-repo-scope (bundle) | sonnet |
| PRG-1.4 Update OpenAPI + scoping docs | Shared | 1.2, 1.3 | feat/prg-1-4-prs-scope-docs | haiku |

## Decision Log
- Out-of-scope `:id` status: 404 (confirmed by Dan) — avoids existence leak; claim/census codes unchanged.
- `repos: []`: zero access (confirmed by Dan).
- Task split: 4 tasks (confirmed by Dan).
