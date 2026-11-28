---
name: error-fix
description: Read open error PatrolFindings from the task store (required --repo), fetch each issue's Sentry detail and stack trace, and route each auto / review / plan as task-store tasks (plus companion observability tasks where instrumentation gaps hinder root-causing). Requires error-scan to have run first.
---

# Error Fix

Read the repo's open error `PatrolFinding`s from the task store and, for each New/Regressed
issue, fetch its Sentry detail and latest-event stack trace, route it, and queue it as a
task-store task. Findings are never turned into direct PRs, and the scan-to-fix hand-off is the
store: this skill reads no report file and writes no finding to any repo path.

Only issues already mapped to this repo exist as findings (`/error-scan` drops unmapped ones
before recording), so there is no unmapped group here and no guessed repo.

**Prerequisites:**
- Run `/error-scan --repo org/repo` first so open PatrolFindings exist.
- `SENTRY_ORG` and `SENTRY_AUTH_TOKEN` must be set (issue detail + latest event).

> **Task store setup:** If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is
> missing, invoke `/shipwright:task-store` for setup instructions.

---

## Setup: Parse Arguments

- `--repo org/repo` — **required**. If missing or not `org/repo`, print and stop:
  ```
  Usage: /error-fix --repo org/repo [--cron ID] [--dry-run]
  Error: --repo is required.
  ```
- `--cron ID` — the system-cron id (default `error-patrol`); used as `CRON_ID` for reads,
  `originRef` and the recorded run.
- `--dry-run` — print what would be routed without writing tasks, findings or a run

Set `REPO` to the `--repo` value. Queueing is the only mode — no PR mode.

---

## Step 1: Load Open Findings from the Store

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/patrol-findings?cronId=$CRON_ID&repo={url-encoded-repo}&status=open&limit=200" | jq '.findings'
```

Page with `nextCursor` until exhausted. Skip findings whose `taskId` is already set. If none
remain, print `No open error findings for {repo}. Run /error-scan --repo {repo} first.` and
stop. Each finding's `fingerprint` is the Sentry issue id and its `detail` holds `shortId`,
`title`, `culprit`, `permalink`, `project`, `count`, `userCount`, `firstSeen`, `lastSeen`.
Order by `detail.count` descending.

---

## Step 2: Fetch Sentry Detail Per Issue

For each finding (issue id = `fingerprint`):

```bash
curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/$ISSUE_ID/"
curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/$ISSUE_ID/events/latest/"
```

These are the basis for routing (Step 4) and companion detection (Step 5). Never print or log
`$SENTRY_AUTH_TOKEN`. If either call fails (non-2xx), skip that issue this run and list it in
the summary as a distinct "Sentry fetch failed" line; never queue a task on incomplete data.

Run each fetched issue through `references/pre-filing-verification.md` (relative to the plugin
root) — the finding is a snapshot that may be stale. Drop issues whose cited call site no
longer exists or whose gap is already fixed (Items 1–2); an issue that cannot be confirmed by a
literal check routes `review`, never `auto` (Item 3); Item 4 (id/branch collisions) is covered
by Step 3 dedup.

---

## Step 3: Dedup Check

Skip when `--dry-run`. Query active tasks for the repo, URL-encoded, with an explicit
`limit=1000`, for each of `pending`, `in_progress` and `blocked` (a task awaiting review counts
as active):

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=pending&repo={url-encoded-repo}&limit=1000" | jq .
```

**Pagination guard — do not silently proceed with a partial result set.** After each call
check `nextCursor`: if it is a string, re-run the same query with `&cursor=<nextCursor>`
(opaque; never parse or build one) and merge the `.tasks` arrays until `nextCursor` is `null`.
Never build the "already active" set from an incomplete page set.

Collect tasks with `source == "error-fix"`. A Sentry issue is already active when a task id is
`error-{sentry-issue-id}` or starts with `error-{sentry-issue-id}-`. Skip those issues and print
`Skipping {shortId} — task already active`. Findings that already carry a `taskId` were skipped
in Step 1.

---

## Step 4: Route Each Issue (auto / review / plan)

Routing follows the three-way contract in `docs/task-store.md` ("Finding routing"). It is a
judgment call made at runtime from the Sentry detail and stack trace; no event count, user count
or severity threshold ever forces a route (counts only order the queue).

| Route | When | Task shape |
|---|---|---|
| **auto** | A clear single root cause with an obvious fix: the trace points to one function/module and the fix is a straightforward change (null check, missing `await`, wrong type, off-by-one, one unhandled edge case), contained to one service | `kind: dev`, `status: pending`, `hitl: false` |
| **review** | The cause is ambiguous, there is no clear reproduction path, several plausible fixes exist, a product decision is needed ("reject or normalize this input?"), or verification could not be confirmed by a literal check. State the specific question in `blockedReason` | `kind: dev`, `status: blocked`, `blockedReason: "needs-review: <question>"`, `hitl: false`; a human answers and calls `POST /tasks/{id}/unblock` |
| **plan** | The fix is bigger than one task: the trace spans several services or repos, or it needs a design decision first | `kind: prd`, `status: blocked`, `blockedReason: "needs-plan: <why>"`, `hitl: false`, no branch; a human takes it through `/shipwright:prd` or `/shipwright:plan-session` and unblocks or cancels it |

Default toward `review` (or `plan` if large) when unsure — never toward `auto`. This skill
never marks a task as human-only: Sentry issues involve no credential rotation, and a plan task waits
as `blocked` for a human rather than being autonomously planned.

---

## Step 5: Companion-Task Detection (Observability Gaps)

While reading the trace, watch for an **instrumentation gap** at the call site: missing
request/entity context on the event, inconsistent logging shape versus neighboring call
sites, or **pure noise** (an exception captured that is not an actionable error, e.g. a
benign condition or a client abort).

If one applies, queue a **companion task** for the observability fix in addition to the
primary. If the issue is a real bug, queue both; if it is pure noise, queue only the companion.
Route the companion with Step 4: a single obvious call-site fix is `auto`; a gap recurring
across call sites or services with no shared abstraction to slot into is `review` (or `plan`
if large). Set `dependencies: ["{companion id}"]` on the primary only when it genuinely cannot
land or be verified first.

---

## Step 6: Dry-Run Output (if --dry-run)

Print, then stop without writing tasks, findings or a run:

```
ERROR FIX — DRY RUN ({repo})
Would route {N} tasks:
  1. error-{sentry-issue-id}  [auto | review | plan]  {issue title}
  2. error-{sentry-issue-id}-obs  [auto | review | plan]  (companion) {call site}
No tasks written. Re-run without --dry-run to queue.
```

---

## Step 7: Queue Tasks

Cap at 10 issues per run (highest `count` first); note the cap if more remain.

### 7.1 Build Task JSON

```json
{
  "id": "error-{sentry-issue-id}",
  "title": "Error fix: {issue title}",
  "source": "error-fix",
  "originKind": "cron",
  "originRef": "<CRON_ID>",
  "repo": "<REPO>",
  "kind": "dev | prd",
  "branch": "fix/error-{sentry-issue-id}-{slug}",
  "layer": "Background",
  "status": "pending | blocked",
  "blockedReason": "needs-review: <question>  (review route) | needs-plan: <why>  (plan route)",
  "hitl": false,
  "description": "<see 7.2>"
}
```

The companion id is `error-{sentry-issue-id}-obs`, title `Error fix (observability): {call
site}`, branch `fix/error-{sentry-issue-id}-obs-{slug}`. The primary id is the finding's
fingerprint prefixed `error-`. `repo` is `--repo` verbatim (already `org/repo`). `slug`:
lowercase, hyphens, max 5 words. Plan tasks omit `branch`; omit `blockedReason` unless the route
is review or plan.

### 7.2 Description

Enough context for `dev-task` to fix without re-reading Sentry:

```
Sentry issue: {shortId} — {issue title}
Link: {permalink}
Culprit: {culprit}
Project: {project} | Repo: {repo} | Route: {auto|review|plan}

Stack trace summary: {condensed top frames — the function/file, not the raw trace}
Root cause hypothesis: {best-effort read}
Fix guidance: {concrete guidance, or the open question for review/plan}

{If a companion was queued: "Related observability task: {id} — {reason}"}
Issue: {sentry-issue-id}
```

The companion description names the gap, the call site, fix guidance and, when relevant,
`Blocks: {primary id}`.

### 7.3 Write, Append and Link Back

1. Write the task array to a temp file outside the repo (`TASKS="$(mktemp -d)/error-tasks.json"`).
2. `POST $SHIPWRIGHT_TASK_STORE_URL/tasks/bulk` with `--data-binary @"$TASKS"` (bearer auth,
   `Content-Type: application/json`); delete the temp file afterwards.
3. Link each routed finding to its **primary** task (or the companion for a noise-only issue)
   in the store; status stays `open`:
   ```bash
   curl -sf -X POST -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/patrol-findings/batch" \
     --data '{"cronId":"'"$CRON_ID"'","repo":"'"$REPO"'","findings":[{"fingerprint":"<issue id>","status":"open","taskId":"<task id>"}]}'
   ```
   This finding-to-task link is what `/error-resolve` reads; there is no ledger file.
4. Record one run with the routing counts:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" record --cron "$CRON_ID" --repo "$REPO" \
     --commit "$(git rev-parse HEAD)" --result "$RESULT"
   ```
   `$RESULT` (temp file outside the repo) =
   `{"outcome":"ok","metrics":{"auto":N,"review":N,"plan":N,"skipped":N}}` (`"no_op"` when
   nothing was routed). Pass no legacy-import flag; the import belongs to `/error-scan`.

---

## Step 8: Print Summary

```
ERROR FIX — {repo}: {A} auto, {R} review, {P} plan; {S} skipped
{If any skipped: one line each — "Skipped (already active)" or "Skipped (Sentry fetch failed)": {shortId}}
Auto tasks run via the loop; review tasks wait for a human unblock; plan tasks wait for /shipwright:prd | /shipwright:plan-session.
```

Stop after printing.

---

## Error Handling

- **Store read fails** (Step 1 or Step 3 dedup): log and stop. Never queue without a dedup pass.
- **Sentry fetch fails for an issue**: skip it, note it, continue with the rest.
- **Bulk append fails**: log the response body and stop; re-running is idempotent because dedup
  skips already-queued issues and findings with a `taskId` are skipped.
- **Link-back or run record fails** after tasks were created: print the error and the created
  ids; do not re-create tasks.

---

## Constraints (Do Not Violate)

- **`--repo` is required** — no fallback to the current directory.
- **Store only** — findings are read from, and linked back to, the task store; no finding detail
  is written to any repo path, and no local state file is read or written.
- **Three routes, no `hitl: true`** — every task is auto, review or plan per Step 4; `hitl` is always false.
- **No numeric/count backstop** — counts never force a route.
- **Dedup before queueing** — never skip Step 3 outside `--dry-run`.
- **Companion-task reasoning stays local to this file**, not in `references/principles.md`.
- **Never log or persist `$SENTRY_AUTH_TOKEN`.**
- **Queue only** — never opens PRs and never leaves the base branch.
- **`--dry-run` mutates nothing.**
