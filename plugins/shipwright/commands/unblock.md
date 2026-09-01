---
description: Human-facing triage tool for blocked tasks and PRs — discovers escalations, infers which phase raised them, and lets you retry, redirect, or abandon each one
argument-hint: "[repo ...]"
---

# Unblock

Discover every `status: 'blocked'` task and `blocked: true` PR in the task store, infer
which pipeline phase escalated each one from its `blockedReason` text, and walk through
them one at a time so a human can decide: **retry**, **redirect**, or **abandon**.

Unlike `dev-task`/`review`/`patch`/`deploy`, this command is **not** dispatched by the
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

**Do not dedupe on `PullRequest.taskId`.** It is populated only ~10% of the time — most
task↔PR links exist solely in the `Task.pr` direction — so a taskId-based dedup treats most
blocked PRs with a real linked task as PR-only records, and a bundle PR (multiple tasks on
one branch) only ever dedupes against whichever single task happened to be stamped into
`taskId`. Instead, for every blocked PR, query the task store live for its linked task(s):

```bash
for pr in $BLOCKED_PRS; do
  PR_REPO=$(echo "$pr" | jq -r '.repo')
  PR_NUMBER=$(echo "$pr" | jq -r '.prNumber')
  LINKED_TASKS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks?repo=${PR_REPO}&pr=${PR_NUMBER}")
  LINKED_TASKS=$(echo "$LINKED_TASKS_JSON" | jq -c '.tasks[]')
  # ... match each task in $LINKED_TASKS against $BLOCKED_TASKS by id, below
done
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
- **Tasks:** parse `.blockedReason` first. If it's empty, also check `.note` — `deploy.md`
  writes its five escalation strings (`Post-merge CI failed`, `Deploy stage failed`,
  `canary_blocked`, `Pipeline timeout`, `Canary failed after deploy`) into the task's `note`
  field when a task is linked (`$TASK_ID` set), not `blockedReason`; `blockedReason` on a
  task-linked deploy escalation stays `null`. `blockedReason` is only populated for these
  five deploy patterns in the PR-only branch (`$PR_RECORD_ID`, no linked task). All other
  phases (dev-task, patch, spin-detection) write to `blockedReason` on tasks as usual — the
  `.note` fallback only matters for deploy-originated task escalations.

| Origin phase | pattern (substring match) | field(s) to check |
|---|---|---|
| **dev-task** | `implementation_blocked_after_model_escalation` | task: `blockedReason` |
| **dev-task** | `requirements_not_met` | task: `blockedReason` |
| **dev-task** | `pr_creation_failed` | task: `blockedReason` |
| **dev-task** | `ci_max_retries_exhausted` | task: `blockedReason` |
| **patch** | `merge-conflict` (resolution blocked) | task: `blockedReason` |
| **patch** | `second-round disagreement` (reviewer vs. automated fix, escalated to HITL) | task: `blockedReason` |
| **patch** | `review-finding fix blocked` | task: `blockedReason` |
| **patch** | `CI-fix blocked` | task: `blockedReason` |
| **deploy** | `Post-merge CI failed` | task: `blockedReason`, fallback `note`; PR: `blockedReason` |
| **deploy** | `Deploy stage failed` | task: `blockedReason`, fallback `note`; PR: `blockedReason` |
| **deploy** | `canary_blocked` | task: `blockedReason`, fallback `note`; PR: `blockedReason` |
| **deploy** | `Pipeline timeout` | task: `blockedReason`, fallback `note`; PR: `blockedReason` |
| **deploy** | `Canary failed after deploy` | task: `blockedReason`, fallback `note`; PR: `blockedReason` |
| **deploy** | `Post-merge CI still pending after 10 minutes` (post-merge CI budget timed out with runs still pending — PR-only, set by `deploy.md`'s Step 5a; the task-linked branch of that same step sets `status=deployed` with no note/blockedReason at all, so this pattern never appears on a task) | PR: `blockedReason` only |
| **spin-detection — skip-count (`recordSkip`)** | starts with `Auto-blocked after` and contains `consecutive skips` — exact format is `` Auto-blocked after ${N} consecutive skips (dispatched but found nothing to do) `` — tracked via `skipCount`; **not task-only** — `Task` and `PullRequest` each carry their own `skipCount`/`lastSkippedAt` (`task-store/prisma/schema.prisma`) and `PullRequestService.recordSkip()` produces this identical blockedReason string on a PR-only record (no linked task), just like `TaskService.recordSkip()` does on a task — distinct from (though similarly named to) the PR CI-failure-streak variant below | task: `blockedReason`; PR: `blockedReason` |
| **spin-detection — PR CI-failure streak (`patch()`/`ciFailureSignature`)** | starts with `Auto-blocked after` and contains `consecutive patch cycles hitting the same CI failure` — exact format is `` Auto-blocked after ${N} consecutive patch cycles hitting the same CI failure (${signature}) `` — PR-only, tracked via `consecutiveCiFailureCount` on the PR record (a distinct counter from task-side `skipCount`); **no dedicated reset endpoint exists today** — Step 6d's `/tasks/:id/skip/reset` doesn't apply (task-only, wrong counter), so a 6c retry clears `blocked`/`blockedReason` but leaves the streak elevated and one more matching CI failure re-blocks the PR immediately | PR: `blockedReason` only |

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
Origin phase:  {dev-task | patch | deploy | spin-detection — skip-count | spin-detection — PR CI-failure streak | unknown origin phase}
Blocked at:    {blockedAt}
Blocked reason: {blockedReason, or task.note when blockedReason is empty (deploy escalations on a linked task)}
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

There are three retry destinations, chosen per item:

- **task.pr is set** (escalation happened mid-review/patch/deploy, after a PR already
  existed) → PATCH the task directly to `status: 'pr_open'`. Do **not** use `/release` here
  — `/release` resets to `'pending'`, which would let `dev-task` open a duplicate PR.
- **task.pr is empty** (no PR exists yet) → agent tokens **cannot** PATCH a task's status
  to `'pending'` directly (`assertNoLifecycleFieldWrite()` in `task-store/src/routes/tasks.ts`
  throws 400 for agent tokens attempting this). Use `POST /tasks/:id/release` instead —
  it atomically sets `status:'pending', claimedBy:null, claimedAt:null, heartbeatAt:null` —
  then a follow-up `PATCH /tasks/:id` to clear `blockedReason`/`blockedAt` (release() does
  not touch those fields).
- **PR-only record** (no linked task) → `PATCH /prs/:id` with `blocked: false` (and clear
  `blockedReason`). No task-side call needed.

### 6a. Retry — task.pr is set

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d '{"status": "pr_open", "blockedReason": null, "blockedAt": null}' | jq .
```

### 6b. Retry — task.pr is empty (no PR yet)

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID/release" | jq .

curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d '{"blockedReason": null, "blockedAt": null}' | jq .
```

### 6c. Retry — PR-only record (no linked task)

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_ID" \
  -d '{"blocked": false, "blockedReason": null}' | jq .
```

### 6d. Spin-detection skipCount reset

In addition to whichever retry path (6a/6b/6c) applies, if `blockedReason` matches the
**skip-count** spin-detection variant (starts with `Auto-blocked after` and contains
`consecutive skips` — the `recordSkip()` pattern), also reset `skipCount` via the
purpose-built endpoint — prefer this over a raw PATCH of `skipCount`. This applies to
**both** tasks and PR-only records — `Task` and `PullRequest` each carry their own
`skipCount`/`lastSkippedAt`, and each has its own reset endpoint:

Task record:

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID/skip/reset" | jq .
```

PR-only record (no linked task):

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_ID/skip/reset" | jq .
```

(Both `resetSkip()` implementations set `skipCount: 0, lastSkippedAt: null` on their
respective record.) Without this step, a PR-only record blocked by this exact reason
re-blocks on its very next skip — its elevated `skipCount` is untouched by a 6c retry.

**Does not apply to the PR CI-failure-streak variant.** If `blockedReason` instead matches
the **PR CI-failure streak** spin-detection variant (contains `consecutive patch cycles
hitting the same CI failure` — the `consecutiveCiFailureCount` pattern), there is no
reset endpoint for that counter today — neither `/tasks/:id/skip/reset` nor
`/prs/:id/skip/reset` touches it, since both reset `skipCount`, a different field entirely.
A 6c retry clears `blocked`/`blockedReason`, but `consecutiveCiFailureCount` stays elevated,
so one more patch cycle hitting the same CI failure signature re-blocks the PR immediately.
Tell the human this before retrying so they aren't surprised by an immediate re-block.

### 6e. Redirect

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

Then run the **same retry logic as above** (6a/6b as applicable, plus 6d if spin-detected)
against the now-updated task. Redirect has no PR-only variant — a PR-only blocked record
has no description/acceptanceCriteria to edit; offer only retry/abandon for those.

### 6f. Abandon

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
✓ {task-id or org/repo#pr}: {retried → pr_open | retried → pending | retried → unblocked | redirected → retried | abandoned}
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
