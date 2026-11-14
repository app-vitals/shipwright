# Plan: system-crons

Repo: app-vitals/shipwright · Session: `system-crons` · Initiative: SWI-2 · Requested by Dan

## Summary
Move the docs-freshness and test-readiness crons from per-agent system crons to admin-run
system crons. Admin fires each cron on schedule, lists repos through the GitHub lookup App,
and queues one task per repo. Any agent with access to the repo picks the task up.

## Requirements (from Dan)
- Runs in the admin service, safe at N replicas, exactly once per trigger.
- Missed triggers catch up on restart.
- Needs the GitHub lookup App configured in settings; it supplies the repo list.
- One task per repo. Task description is the cron definition's description template with a `{repo}` param.
- Skills take a required repo input; the agent-level crons are removed (reconcile deletes the seeded rows).

## Design
**task-store** — new `SystemCronDefinition` (id, name, schedule, timezone, enabled, title and
description templates) and `SystemCronTrigger` with a unique key on `(cronId, scheduledFor)`.
`POST /system-crons/:id/fire {scheduledFor, repos}` inserts the trigger row and bulk-creates
one task per repo in a single transaction. Losing the unique-key race returns `claimed: false`.
Task ids are deterministic: `SC-{cron}-{slot}-{owner}-{repo}`. Tasks are `kind: dev`,
`hitl: false`, no assignee. Rendering is plain `{repo}` substitution only.

**admin** — `system-cron-scheduler` background pass (60s tick) via the `AdminExtension`
`backgroundPasses` seam. For each enabled definition it fires every slot between the last
claimed trigger and now, oldest first (catch-up). The repo list comes from the GitHub lookup
App; with no lookup App configured the tick is skipped and nothing is recorded. The trigger
row is only written after the repo list is fetched. Settings page lists definitions with an
enable toggle and editable template, plus a banner when the lookup App is missing.
Seeded definitions (disabled by default):
- `docs-freshness`: `/shipwright:research-docs --auto --repo {repo}`
- `test-readiness`: `/shipwright:test-readiness --repo {repo} --full --publish`

**skills** — `research-docs --auto` and `test-readiness` gain `--repo org/repo` (optional first,
required in SCR-1.5). With a repo they skip the scan and precheck, find or clone the clone under
`repos/`, and rely on their own freshness gates (no-op when fresh). The `docs/test-readiness/`
opt-in check does not apply to an explicit repo.

## Tasks
| Task | Title | Layer | Depends on | Model | Branch |
|---|---|---|---|---|---|
| SCR-1.1 | feat: add idempotent system-cron fire endpoint and trigger table to task-store | API | — | opus | feat/scr-fire-endpoint |
| SCR-1.2 | feat: add optional `--repo` input to research-docs and test-readiness | CLI | — | sonnet | feat/scr-skill-repo-input |
| SCR-1.3 | feat: add system-cron-scheduler background pass with catch-up | Background | 1.1, 1.2 | opus | feat/scr-scheduler-pass |
| SCR-1.4 | feat: add system-crons settings page with enable toggles and lookup-App banner | Frontend | 1.1 | sonnet | feat/scr-settings-page |
| SCR-1.5 | refactor: require `--repo` in both skills and remove the agent-level crons | CLI | 1.3 (deployed) | sonnet | feat/scr-remove-agent-crons |

## Breaking Change Safety
Add, migrate, remove. 1.1, 1.2, 1.3, 1.4 are additive. SCR-1.5 removes the agent-level crons,
their prechecks and the skills' scan fallback in one task, and runs only after 1.3 is deployed,
so no old cron calls a skill that now rejects it. Reconcile deletes the seeded rows.

## Risks
- The pinned `@app-vitals/agent-admin@0.16.0` may lack a repo-listing method for the lookup
  App. SCR-1.3 verifies this first; if missing, add a producer task in app-vitals/agent plus a
  release gate before the scheduler.
- Tasks run through dev-task; the skills open their own worktree and PR, so dev-task must defer
  to the skill. SCR-1.3 includes a test of this flow.

## Decision Log
- Ledger location: task-store, not admin DB — avoids a cross-repo schema chain; claim and task creation share a transaction.
- Catch-up: unbounded, per Dan's "catch up"; no window cap (kept simple).
- Custom crons: supported only as definition rows with a template; no per-cron code.
- Precheck: dropped; skills' own freshness gates replace it.
