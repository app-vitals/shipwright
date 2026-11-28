---
name: error-resolve
description: Read error PatrolFindings (required --repo) and each linked task's current status from the task store, and resolve the corresponding Sentry issue once its gating task has reached deployed/done. Never resolves on merged, released or pr_open.
---

# Error Resolve

Read the repo's error `PatrolFinding`s that `/error-fix` linked to a task (`taskId`), look up
each linked task's **current** status in the task store, and call Sentry's issue-resolve
endpoint only for issues whose gating task has reached `deployed` or `done`. This skill makes
**no code changes** and queues no tasks; it mutates Sentry issue state and, after a successful
resolve, the finding's status in the store. It reads and writes no repo path and no local state
file.

---

## Setup: Parse Arguments

- `--repo org/repo` — **required**. If missing or not `org/repo`, print and stop:
  ```
  Usage: /error-resolve --repo org/repo [--cron ID] [--dry-run]
  Error: --repo is required.
  ```
- `--cron ID` — the system-cron id (default `error-patrol`), used as `CRON_ID`.
- `--dry-run` — check readiness and print what would resolve; no Sentry call, no store write.

---

## Step 0: Preconditions

1. `SHIPWRIGHT_TASK_STORE_URL` and `SHIPWRIGHT_TASK_STORE_TOKEN` must be set; otherwise print
   `error-resolve requires SHIPWRIGHT_TASK_STORE_URL and SHIPWRIGHT_TASK_STORE_TOKEN to be set.
   Invoke /shipwright:task-store for setup instructions. Skipping resolve.` and stop.
2. `SENTRY_ORG` and `SENTRY_AUTH_TOKEN` must be set; otherwise print
   `error-resolve requires SENTRY_ORG and SENTRY_AUTH_TOKEN to be set in the environment.
   Skipping resolve.` and stop.
3. Never print `$SENTRY_AUTH_TOKEN` or `$SHIPWRIGHT_TASK_STORE_TOKEN`, never write either to a
   file, and never echo the literal `$SENTRY_ORG`.

---

## Step 1: Read the Finding-to-Task Links

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/patrol-findings?cronId=$CRON_ID&repo={url-encoded-repo}&status=open&limit=200" | jq '.findings'
```

Page with `nextCursor` until exhausted. Keep findings whose `taskId` is non-null; the Sentry
issue id is the finding's `fingerprint`. If none, print `No linked error findings for {repo}.
Nothing to resolve.` and stop cleanly.

---

## Step 2: Gating Task

Each finding links one task (`taskId`): the primary fix task, or the companion for a pure-noise
issue (`/error-fix` links the primary whenever one exists). That linked task is the gate. A
companion task of an issue that also has a primary never gates resolution.

---

## Step 3: Read the Task Status from the Store

**Always a live lookup, before any Sentry action.** The finding stores only the task id.

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{taskId}"
```

- **200** — record `status`.
- **404** — `missing`: not ready. Continue.
- Other non-2xx — `lookup failed`: not ready, retried next run. Continue.
- `cancelled` — not ready (the fix was abandoned, not shipped); recorded distinctly.

---

## Step 4: Decide Readiness

An issue resolves only when its gating task is `deployed` or `done` — never `merged`, never
`released`, never `pr_open`, never anything else. `released` means a library was published,
which does not change a running service until a consumer deploys it. Every non-ready issue is
left untouched: no Sentry call and no store write.

---

## Step 5: Dry-Run Output (if --dry-run)

Print and stop; no Sentry call, no store write:

```
ERROR RESOLVE — DRY RUN ({repo})
Would resolve {N}: <sentry_issue_id> — task {task_id} status={deployed|done}
Not yet ready {N}: <sentry_issue_id> — task {task_id} status={status}
Missing/cancelled {N}: <sentry_issue_id> — task {task_id} ({missing|cancelled})
```

---

## Step 6: Resolve in Sentry

For each ready issue:

```bash
curl -sS -X PUT -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"status": "resolved"}' \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/{issue_id}/"
```

Success requires a 2xx **and** a response body whose `status` is `"resolved"`. Otherwise record
the failure (issue id, HTTP status) and leave that finding untouched for a retry; continue with
the rest.

---

## Step 7: Mark the Finding Resolved (Only After a Successful Resolve)

Only after Step 6 succeeded for an issue, set its finding to `resolved` in the store so the
next `/error-scan` detects a later reappearance as a regression:

```bash
curl -sf -X POST -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/patrol-findings/batch" \
  --data '{"cronId":"'"$CRON_ID"'","repo":"'"$REPO"'","findings":[{"fingerprint":"<issue id>","status":"resolved"}]}'
```

Then record one run with `cron-run-recorder.ts record --cron "$CRON_ID" --repo "$REPO" --commit
"$(git rev-parse HEAD)" --result "$RESULT"` where `$RESULT` (a temp file outside the repo) is
`{"outcome":"ok"|"no_op","metrics":{"resolved":N,"not_ready":N,"missing":N,"lookup_failed":N,"sentry_failed":N}}`.
If the store write fails after a successful Sentry resolve, log it and do not try to unresolve
in Sentry; a later run's redundant resolve is harmless.

---

## Step 8: Print Summary

```
ERROR RESOLVE — {repo}: {R} resolved, {N} not yet ready, {M} missing/cancelled, {L} lookup failed, {F} Sentry call failed
{One line per resolved issue: <sentry_issue_id> — task {task_id} reached {deployed|done}}
```

Stop after printing.

---

## Error Handling

- **Missing env vars**: Step 0 — print and stop, touch nothing.
- **No linked findings**: Step 1 — clean stop.
- **Task 404/cancelled/lookup failure**: Step 3 — not ready, run continues.
- **Sentry call fails**: Step 6 — finding untouched, retried next run.
- **Store write fails after a resolve**: Step 7 — log, never reverse the Sentry resolve.

---

## Constraints (Do Not Violate)

- **`--repo` is required** — no fallback to the current directory.
- **Always a live task-store lookup** for the gating task before any Sentry action.
- **Only `deployed`/`done` resolves.** `merged`, `released` and `pr_open` — and every other
  status — never do.
- **Never write the store before the Sentry call succeeds.**
- **Store only** — no repo path and no local state file is read or written.
- **Never log or persist `$SENTRY_AUTH_TOKEN` or `$SHIPWRIGHT_TASK_STORE_TOKEN`.**
- **No code changes, no task queueing.**
- **`--dry-run` mutates nothing.**
- **One failure doesn't abort the run.**
