---
description: Human-facing triage tool for blocked tasks and PRs — discovers escalations, infers which phase raised them, and lets you retry, redirect, or abandon each one
argument-hint: "[repo ...]"
---

# Unblock

Discover every `status: 'blocked'` task and `blocked: true` PR in the task store, infer
which pipeline phase escalated each one from its `blockedReason` text, and walk through
them one at a time so a human can decide: **retry**, **redirect**, or **abandon**.

Unlike `dev-task`/`review`/`patch`/`merge`, this command is **not** dispatched by the
`shipwright-loop` cron and is exempt from the Candidate Selection Contract (see
`plugins/shipwright/CLAUDE.md`) — it self-discovers its own targets because it is a
human-facing triage tool, not an autonomous pipeline phase. It never runs unattended.

**This command runs interactively. Present each blocked item and wait for the human's
decision before acting on it — do not batch-act or assume a default choice.**

> **Task store setup:** This command reads and updates tasks/PRs in the Shipwright task
> store. If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke
> `/shipwright:task-store` for setup instructions.

---

## Step 1: Parse Arguments

`$ARGUMENTS` is an optional, space-separated list of `org/repo` filters:

```bash
read -ra REPO_ARGS <<< "$ARGUMENTS"
```

If `REPO_ARGS` is empty, **do not filter by repo** — discover across every repo the
token's scope allows (an admin token sees all repos; an agent token is limited to its own
repo scope server-side, same as every other list endpoint in this plugin). If one or more
repos are given, pass each as a repeated `?repo=` query param (both `GET /tasks` and
`GET /prs` accept `?repo=` repeatably per `TaskListQuerySchema`/`PrListQuerySchema` — a
single repo behaves as an exact match, multiple repos match any of the list).

Build a reusable query-string suffix:

```bash
REPO_QS=""
for r in "${REPO_ARGS[@]}"; do
  REPO_QS="$REPO_QS&repo=$r"
done
```

---

## Step 2: Discover Blocked Tasks

```bash
BLOCKED_TASKS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?state=blocked${REPO_QS}")
BLOCKED_TASKS=$(echo "$BLOCKED_TASKS_JSON" | jq -c '.tasks[]')
```

`GET /tasks?state=blocked` delegates to `listBlocked()`, which returns tasks where
`status === 'blocked'` **OR** the task is open with a non-empty `blockedBy` dependency
array. **`blockedBy` is dependency-blocking context (which sibling tasks this one depends
on that aren't done yet) — it is unrelated to escalation blocking and must not be
confused with `blockedReason`.** Only surface an item in this command's triage list when
its `status === 'blocked'` (i.e. it actually carries a `blockedReason` from an escalation);
skip tasks that are merely dependency-blocked (`status` still open, `blockedBy.length > 0`,
no `blockedReason`) — those aren't triage-able here, they resolve themselves once their
dependency completes.

---

## Step 3: Discover Blocked PRs

```bash
BLOCKED_PRS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?blocked=true${REPO_QS}")
BLOCKED_PRS=$(echo "$BLOCKED_PRS_JSON" | jq -c '.prs[]')
```

`GET /prs?blocked=true` returns PRs where `pr.blocked === true` **OR** the PR has a linked
task whose `task.status === 'blocked'`. That means a PR with a linked blocked task can
appear in **both** this list and the blocked-tasks list from Step 2 — dedupe on the
task/PR pairing.

**Do not dedupe on `PullRequest.taskId`.** The column no longer exists (PTL-3.1 removed
it): it was populated only ~10% of the time — most task↔PR links exist solely in the
`Task.pr` direction — so a taskId-based dedup treated most blocked PRs with a real linked
task as PR-only records, and a bundle PR (multiple tasks on one branch) only ever deduped
against whichever single task happened to be stamped into it. Instead, for every blocked
PR, query the task store live for its linked task(s):

```bash
while IFS= read -r pr; do
  PR_REPO=$(echo "$pr" | jq -r '.repo')
  PR_NUMBER=$(echo "$pr" | jq -r '.prNumber')
  LINKED_TASKS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks?repo=${PR_REPO}&pr=${PR_NUMBER}")
  LINKED_TASKS=$(echo "$LINKED_TASKS_JSON" | jq -c '.tasks[]')
  # ... match each task in $LINKED_TASKS against $BLOCKED_TASKS by id, below
done <<< "$BLOCKED_PRS"
```

`GET /tasks?repo=&pr=` can return **more than one** task for a single PR — a bundle branch
carries several tasks against the same `pr` number. Dedupe against **every** matched task,
not just one: for each task returned by the lookup, if that task's `id` also appears in the
Step 2 `BLOCKED_TASKS` list, triage it once as a task-with-PR item (Step 5's task.pr-having
path) per match — a two-task bundle where both tasks are blocked produces two triage items,
not one collapsed item. Only when the `/tasks?repo=&pr=` lookup returns **zero** tasks is
the PR a genuinely PR-only record with no linked task to dedupe against.

If both `BLOCKED_TASKS` and `BLOCKED_PRS` are empty after dedup, print and stop:

```
✓ Nothing to triage — no blocked tasks or PRs found.
```

---

## Step 4: Infer Origin Phase

For each item, parse the reason text against the known patterns below. Match on substring
containment, not exact equality — several patterns include a dynamic suffix (a run ID, a
subagent's own detail) after a fixed prefix.

- **PR-only records:** parse `.blockedReason` on the PR.
- **Tasks:** parse `.blockedReason`. `merge.md` writes its escalation strings to `blockedReason` on
  both the linked task and the PR record, so no `.note` fallback is needed.

| Origin phase | pattern (substring match) | field(s) to check |
|---|---|---|
| **dev-task** | `implementation_blocked_after_model_escalation` | task: `blockedReason` |
| **dev-task** | `requirements_not_met` | task: `blockedReason` |
| **dev-task** | `pr_creation_failed` | task: `blockedReason` |
| **dev-task** | `ci_max_retries_exhausted` | task: `blockedReason` |
| **patch** | `merge-conflict` (resolution blocked) | task: `blockedReason` |
| **patch** | `second-round disagreement` (reviewer vs. automated fix, escalated to HITL) | task: `blockedReason` |
| **patch** | `structurally unfixable` (finding requires a write under `.claude/**`, which the CLI blocks unconditionally — escalated to HITL on the first round) | task: `blockedReason` |
| **patch** | `review-finding fix blocked` | task: `blockedReason` |
| **patch** | `main_red:` (the PR's CI failure is inherited from a red base branch — nothing for patch to fix on the PR; `blockedReason` is `main_red: {base} @ {main-sha} is failing {signature}`) | task: `blockedReason`; PR: `blockedReason` |
| **patch** | `CI-fix blocked` | task: `blockedReason` |
| **merge** | `Post-merge CI failed` | task: `blockedReason`; PR: `blockedReason` |
| **merge** | `Squash merge failed` | task: `blockedReason`; PR: `blockedReason` |
| **merge** | `Merge blocked by branch protection` (a self-review APPROVE does not satisfy the required-review rule — a human adds a real approval or configures a ruleset bypass actor before retry) | task: `blockedReason`; PR: `blockedReason` |
| **spin-detection — skip-count (`recordSkip`)** | starts with `Auto-blocked after` and contains `consecutive skips` — exact format is `` Auto-blocked after ${N} consecutive skips (dispatched but found nothing to do) `` — tracked via `skipCount`; **not task-only** — `Task` and `PullRequest` each carry their own `skipCount`/`lastSkippedAt` (`task-store/prisma/schema.prisma`) and `PullRequestService.recordSkip()` produces this identical blockedReason string on a PR-only record (no linked task), just like `TaskService.recordSkip()` does on a task — distinct from (though similarly named to) the PR CI-failure-streak variant below | task: `blockedReason`; PR: `blockedReason` |
| **spin-detection — PR CI-failure streak (`patch()`/`ciFailureSignature`)** | starts with `Auto-blocked after` and contains `consecutive patch cycles hitting the same CI failure` — exact format is `` Auto-blocked after ${N} consecutive patch cycles hitting the same CI failure (${signature}) `` — PR-only, tracked via `consecutiveCiFailureCount` on the PR record (a distinct counter from task-side `skipCount`); `POST /prs/:id/unblock` (Step 6b) resets the streak counter and signature along with the block, so the next patch cycle starts a fresh streak | PR: `blockedReason` only |

If neither field matches any pattern above (both empty, or genuinely unrecognized text),
present it as **unknown origin phase** — do not guess which phase set it. Never crash on an
unmatched reason.

---

## Step 5: Present Each Blocked Item

For each blocked task or PR-only record (in the order returned), print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BLOCKED: {task-id or org/repo#pr}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Title:         {title}
Repo:          {repo}
Origin phase:  {dev-task | patch | merge | spin-detection — skip-count | spin-detection — PR CI-failure streak | unknown origin phase}
Blocked at:    {blockedAt}
Blocked reason: {blockedReason}
PR:            {task.pr or "(none)"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then ask the human to choose one of:
- **retry** — clear the block and return the item to the pipeline
- **redirect** — edit the description/acceptance criteria first, then retry
- **abandon** — cancel the item, leaving `blockedReason` as a historical record

Wait for the human's answer before acting. Skip an item entirely if the human says so (no
action taken, move to the next).

---

## Step 6: Act on the Human's Choice

Each retry is a single call — the task-store picks the destination and resets all the
counters atomically, so there is no follow-up PATCH or reset step:

- **Task** → `POST /tasks/:id/unblock`. With no body the target is inferred (no `pr` →
  `pending`; PR open → `pr_open`; PR merged → `merged`); pass `{"to": "..."}` only to override
  (`pending`, `pr_open`, `merged`, `deployed`, `released`). Do **not** use `/release` — it
  resets to `'pending'`, which would let `dev-task` open a duplicate PR. Returns `409` if the
  task isn't currently `status: 'blocked'`, or if its PR was closed without merging and no
  `to` was given.
- **PR-only record** (no linked task) → `POST /prs/:id/unblock`. Returns `409` if the PR
  isn't currently blocked.

### 6a. Retry — task

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID/unblock" | jq .
```

To override the inferred destination:

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID/unblock" \
  -d '{"to": "pending"}' | jq .
```

### 6b. Retry — PR-only record (no linked task)

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_ID/unblock" | jq .
```

**`main_red:` blocks (patch).** Before retrying, tell the human to confirm the base branch is
green again (the sha and failing jobs are named in `blockedReason`), then refresh CI — re-run
the failed checks or update the PR branch onto the new base. Retrying while `main` is still
red just re-blocks the PR on the next patch cycle.

### 6c. Redirect

Ask the human what to change in the description and/or acceptance criteria. PATCH those
fields first:

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d "$(jq -n --arg desc "$NEW_DESC" --argjson ac "$NEW_AC_JSON" \
    '{description: $desc, acceptanceCriteria: $ac}')" | jq .
```

Then run the **same retry logic as above** (6a)
against the now-updated task. Redirect has no PR-only variant — a PR-only blocked record
has no description/acceptanceCriteria to edit; offer only retry/abandon for those.

### 6d. Abandon

Task-only (PR-only records have no `status` field to cancel — abandon a PR-only record via
its linked repo/PR directly on GitHub, or simply leave it blocked; this command does not
force an action). Set `status: 'cancelled'`. **Preserve `blockedReason` as-is — do not
clear it.** It becomes a historical note of why the item was abandoned.

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d '{"status": "cancelled"}' | jq .
```

---

## Step 7: Confirm

After acting on an item, print a one-line confirmation and move to the next item:

```
✓ {task-id or org/repo#pr}: {retried → {status} | retried → unblocked | redirected → retried | abandoned}
```

Once every discovered item has been triaged (or explicitly skipped), print a final summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNBLOCK TRIAGE COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Retried:    {n}
Redirected: {n}
Abandoned:  {n}
Skipped:    {n}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
