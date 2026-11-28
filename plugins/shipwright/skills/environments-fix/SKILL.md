---
name: environments-fix
description: "Route a repo's environment readiness findings as task-store tasks (auto / review / plan), one task per check, and record the patrol run. Requires --repo org/repo and /environments-scan first. Flags: --dry-run (preview without queueing or recording)."
argument-hint: "--repo org/repo [--dry-run]"
---

# Environments Fix

Read the handoff `/environments-scan` left for one repo and queue one task per open check,
routed auto / review / plan per the finding-routing contract in
[docs/task-store.md](../../../../docs/task-store.md) ("Finding routing" and "System-cron
contract"). Records exactly one `environments` run for the task. Findings never become direct PRs.

> If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke
> `/shipwright:task-store` for setup.

## Setup: Parse Arguments

`--repo org/repo` is **required**. If missing, print this and stop without touching the task store:

```
Usage: /shipwright:environments-fix --repo org/repo [--dry-run]
```

`--dry-run` prints what would be queued; it neither queries nor writes the task store and records no run.

## Step 1: Locate the handoff

Use the most recently modified `{dirname}-docs-environments-patrol-{YYYYMMDD}` worktree under
`$SHIPWRIGHT_WORKTREE_DIR` and read `.environments-patrol/findings.json`. If it is missing,
print `No environments scan handoff found for {org/repo}. Run /environments-scan --repo {org/repo} first.`
and stop. If the handoff's repo differs from `--repo`, stop with an error.

## Step 2: Routes

| Route | Checks | Task shape |
|---|---|---|
| **auto** | lockfile, tool-versions | `kind: dev`, `pending`, `hitl: false` |
| **review** | structured-logging, error-tracking | `kind: dev`, created `blocked`, `blockedReason` starting `needs-review:` with the choice (for error tracking, which provider) |
| **plan** | preview-environment, tracing-metrics, staged-canary | `kind: prd`, `hitl: true`, draft problem statement plus the finding |

`hitl: true` is used only on plan-route `kind: prd` tasks. Every task carries
`originKind: "cron"`, `originRef: "environments"` and `repo`. The scan already planned the
tasks (`tasks` in the handoff) with ids `environments-{check}-{repo-slug}-{YYYY-Www}`.

The `preview-environment` plan task's description cites Shipwright's own pattern: one bring-up
script used locally and by a CI composite action, bringing the whole stack up from the PR's source
in a throwaway cluster with no real credentials, then running smoke/canary and e2e suites
(`docs/preview-environment.md`, `scripts/preview-env.ts`, `.github/actions/preview-env`,
`preview/canary/`).

## Step 3: Dedup and queue

The scan's planned tasks already exclude checks with an active task. Re-check right before
writing: query `pending`, `in_progress`, `pr_open` and `blocked` tasks for the repo (`limit=1000`, follow
`nextCursor` until it is null) and drop any planned task whose check already has an id starting
`environments-{check}-{repo-slug}-`. Then `POST /tasks/bulk` the rest. A re-run on an unchanged
repo therefore queues nothing. Count the accepted tasks per route.

## Step 4: Record the run

Skip under `--dry-run`. `outcome` is `ok` when anything was queued or the docs changed, `no_op`
otherwise, `failed` on error (`"error": 1`).

```bash
echo '{"outcome":"ok","metrics":{"findings":7,"auto":2,"review":2,"plan":3}}' > /tmp/environments-result.json
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" record --cron environments \
  --repo {org}/{repo} --commit {handoff.commitSha} --result /tmp/environments-result.json
```

Add `--task {SC-... id}` when dispatched from a system-cron task. Print a 3-5 line summary.

## Error Handling

Task-store query or bulk-append failure: record a `failed` run and stop. Re-running is safe
because dedup skips checks that already have an active task.

## Constraints (Do Not Violate)

- **`--repo` is required.**
- **One task per check**, never bundled.
- **Queue only** — never opens PRs or edits code.
- **No local state** beyond the handoff scratch.
