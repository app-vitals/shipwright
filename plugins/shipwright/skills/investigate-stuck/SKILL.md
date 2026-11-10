---
name: investigate-stuck
description: >
  Diagnose why a specific PR or task is stuck or didn't proceed — snapshots the
  work queue, task-store PR/task records and live GitHub state, resolves every
  shipwright-loop phase dispatch for the item, then delegates transcript and
  Sentry analysis to agent-platform:investigate-cron. Takes <org/repo#N|taskId>.
---

# investigate-stuck

Diagnose why a PR or task didn't proceed, by checking the Shipwright pipeline's
ground truth for that one item (work queue, task-store, GitHub) and the dispatch
history of every `shipwright-loop` phase against it. Generic cron-run analysis
(run lookup by cron name, transcript reading, Sentry cross-check, synthesis
structure) is owned by `agent-platform:investigate-cron` — this skill delegates
to it rather than duplicating it.

**Usage:** `/shipwright:investigate-stuck <org/repo#N|taskId>`

Arguments:

- `<org/repo#N|taskId>` — a PR (`org/repo#N`, e.g. `acme/x#123`) or a bare task
  id (e.g. `IC-1.1`).

**Examples:**
- `/shipwright:investigate-stuck acme/x#123`
- `/shipwright:investigate-stuck IC-1.1`

Out of scope: this skill is only the item-scoped ground-truth and dispatch-history
flow. It is not a general why-is-it-stuck engine (no fleet-wide scans, no
remediation). To investigate a cron by name and time, use
`agent-platform:investigate-cron` directly.

---

## Step 0: Bind the item

```bash
# /shipwright:investigate-stuck <org/repo#N|taskId>
ITEM_ARG="$1"   # e.g. "acme/x#123" or "IC-1.1"
```

If `ITEM_ARG` is empty, ask for it and stop. A PR reference splits into
`{org}/{repo}` and `{pr}`; a bare task id matches `^[A-Z]+-[0-9]+\.[0-9]+$`.

---

## Step 1: Resolve the item's runs via the admin cron-runs API

The admin API (`$SHIPWRIGHT_API_URL`, authenticated with
`Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY`, agent id `$SHIPWRIGHT_AGENT_ID`)
is the exact source for cron run history.

### 1a. List crons and resolve `loopCronId`

```bash
CRONS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons")

# The loop cron is the top-level cron: parentCronId === null (typically
# system === true and named "shipwright-loop"). Phase crons (dev-task, plan,
# review, patch, merge) are its children: parentCronId === <loop cron's id>.
LOOP_CRON_ID=$(echo "$CRONS_JSON" | jq -r '.crons[] | select(.parentCronId == null and .system == true) | .id' | head -1)

if [ -z "$LOOP_CRON_ID" ] || [ "$LOOP_CRON_ID" = "null" ]; then
  echo "No loop cron found via admin API — dispatch history unavailable; continue with Step 2 only."
else
  echo "loopCronId: $LOOP_CRON_ID"
fi
```

Map each run's `phaseId` back to a phase name using the same listing
(`.crons[] | select(.id == $phaseId) | .name | sub("^shipwright-"; "")`).

### 1b. List runs for the item, filtered server-side

`GET /agents/{id}/crons/{cronId}/runs` supports `limit`/`offset` plus
server-side `itemId`/`phaseId` query filters.

Fetch runs scoped to `itemId=$ITEM_ARG` directly; the server
returns every matching run across all five phases in one call, no client-side
`select()` needed:

```bash
ITEM_RUNS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/$LOOP_CRON_ID/runs?itemId=$ITEM_ARG&limit=100")

# The API's orderBy is startedAt desc; re-sort ascending (chronological) for
# the dispatch-history narrative below.
ITEM_RUNS=$(echo "$ITEM_RUNS_JSON" | jq -r '.items | sort_by(.startedAt)')

echo "Found $(echo "$ITEM_RUNS" | jq 'length') dispatch(es) for item \"$ITEM_ARG\":"
echo "$ITEM_RUNS" | jq -r '.[] | "  \(.startedAt)  phaseId=\(.phaseId)  outcome=\(.outcome)  skipped=\(.skipped)"'
```

If `total` in `ITEM_RUNS_JSON` exceeds the fetched `limit`, paginate with
`itemId=$ITEM_ARG&limit=100&offset=<n>` before sorting — in practice an item's dispatch count across five phases
is small enough that this rarely triggers.

If `ITEM_RUNS` is empty, no run was ever dispatched for that PR/task through the
admin-tracked loop cron — either it predates run tracking, or the item was
never processed. Report that no dispatch history exists (see the no-dispatch-history handler
below) and rely on Step 2.

---

## Step 2: Ground-truth snapshot

Before extracting anything from a transcript, pull current live state. Often
the answer to "why didn't this run/proceed" is fully explained by state that
exists **right now** — the item simply isn't next in the queue yet, or it's
blocked by a flag — without needing to read a single line of session output.
The signals apply directly to `ITEM_ARG`.

Three independent signals, each degrading gracefully if unavailable — a
missing snapshot, PR record, or task record is not an error, just a signal
that's not yet available to reason from:

### 2a. Work-queue snapshot

`GET /agents/{id}/work-queue` returns the **last-pushed ranked snapshot** of
this agent's pending work — not a live-computed view. The loop orchestrator
POSTs a fresh ranked snapshot once per tick (capped at 50 items, oldest-first
FIFO); this GET just returns whatever was pushed at the most recent tick, and
returns `404` if the agent has never pushed one. Items are ranked oldest-first
by age; there is no explicit `rank` field — the array index **is** the rank.
Treat this as "latest known ranking as of the last tick," not real-time truth.

```bash
WORK_QUEUE_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/work-queue" 2>/dev/null)

if [ -z "$WORK_QUEUE_JSON" ]; then
  echo "No work-queue snapshot available (agent has never pushed one, or the admin API is unreachable) — skip this signal."
else
  echo "Snapshot computed at: $(echo "$WORK_QUEUE_JSON" | jq -r '.snapshot.computedAt')"
  echo "$WORK_QUEUE_JSON" | jq -r '.snapshot.items | to_entries[] | "  rank=\(.key)  type=\(.value.type)  id=\(.value.id)  phase=\(.value.phase)  age=\(.value.age)"'

  # Surface this item's rank/age relative to other ready candidates, if present.
  echo "$WORK_QUEUE_JSON" | jq -r --arg id "$ITEM_ARG" \
    '.snapshot.items | to_entries[] | select(.value.id == $id) | "This item: rank=\(.key) of \(($ENV.TOTAL // "?")) phase=\(.value.phase) age=\(.value.age)"'
fi
```

If the item appears in the snapshot far down the ranking relative to other
ready candidates, that alone can explain "hasn't run yet — not its turn" for a
`dev-task`/`review`/`patch`/`merge` cron. If it's absent from the snapshot
entirely, either it wasn't a ready candidate at the last tick, or no snapshot
exists yet — note which, and move on to 2b/2c rather than guessing.

### 2b. Task-store PR/task record

Fetch the task-store's cached view of the item — the PR record, the task
record, or both, depending on what `ITEM_ARG` (or the item implied by
X:

```bash
# PR record (when the item is a PR, org/repo#N):
PR_RECORD_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&prNumber={pr}" | jq -c '.prs[0] // empty')

if [ -z "$PR_RECORD_JSON" ]; then
  echo "No task-store PR record for {org}/{repo}#{pr} — not yet tracked, or never a PR. Skip this signal."
else
  echo "$PR_RECORD_JSON" | jq '{claimedBy, hitl, reviewState, readyForReviewAt, readyForPatchAt, readyForMergeAt, patchCycles, commitSha}'
fi

# Task record(s) — live lookup via GET /tasks?repo=&pr= for a PR, or /tasks/{id} for a bare task id:
if [[ "$ITEM_ARG" =~ ^[A-Z]+-[0-9]+\.[0-9]+$ ]]; then
  # ITEM_ARG is a bare task id (e.g., "IC-1.1")
  TASK_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks/$ITEM_ARG" 2>/dev/null)
  if [ -z "$TASK_JSON" ]; then
    echo "No task-store task record for $ITEM_ARG — skip this signal."
  else
    echo "$TASK_JSON" | jq '{id, status, hitl, dependencies}'
  fi
else
  # ITEM_ARG is a PR reference — fetch associated tasks via live lookup.
  # Gated on ITEM_ARG's shape, not on PR_RECORD_JSON being non-empty: a
  # freshly-opened PR not yet claimed by review/patch/merge has no
  # PullRequest record yet, but real Task records (Task.repo/Task.pr) can
  # already exist — the live lookup below must still run for it.
  TASKS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks?repo={org}/{repo}&pr={pr}" 2>/dev/null)
  if [ -z "$TASKS_JSON" ]; then
    echo "No tasks found for {org}/{repo}#{pr} — skip this signal."
  else
    # Loop over zero, one, or many tasks (the bundle case)
    TASK_COUNT=$(echo "$TASKS_JSON" | jq '.tasks | length')
    if [ "$TASK_COUNT" -eq 0 ]; then
      echo "No tasks found for {org}/{repo}#{pr} — skip this signal."
    else
      echo "$TASKS_JSON" | jq '.tasks[] | {id, status, hitl, dependencies}'
    fi
  fi
fi
```

`hitl=true`, a `reviewState` that clearly blocks progress (e.g. stuck at
`pending` with no recent activity), or an unmet `dependencies` entry on the
task record are all direct, no-transcript-needed explanations for "why didn't
this proceed." Note: a PR can map to zero, one, or multiple tasks (the bundle
case, where several tasks share the same PR) — the live lookup loops over all
results to surface blocking conditions on any of them.

### 2c. Live GitHub state, diffed against the cached task-store view

Fetch live state directly from GitHub — this is the source of truth GitHub
holds right now, which may have moved since the task-store record was last
written:

```bash
GH_LIVE_JSON=$(gh pr view {pr} --repo {org}/{repo} \
  --json mergeStateStatus,state,headRefOid,author,createdAt 2>/dev/null)
echo "$GH_LIVE_JSON" | jq .
```

`gh pr checks` may not reliably work here — agent PATs generally lack Checks
API access. If a CI-status signal is needed, prefer the lightweight Actions-API
pattern used elsewhere in this plugin (e.g. `merge.md`, `patch.md`,
`review.md`): `gh api "repos/{org}/{repo}/actions/runs?head_sha=$HEAD_SHA&per_page=20"`
filtered/deduped client-side. Keep it to a single snapshot fetch here — this
step is a quick ground-truth check, not a full CI poll loop.

**Explicitly diff the live GitHub state against the task-store's cached
view** (`PR_RECORD_JSON` from 2b) — do not silently prefer one source over the
other:

```bash
if [ -n "$PR_RECORD_JSON" ] && [ -n "$GH_LIVE_JSON" ]; then
  LIVE_HEAD=$(echo "$GH_LIVE_JSON" | jq -r '.headRefOid')
  CACHED_HEAD=$(echo "$PR_RECORD_JSON" | jq -r '.commitSha // empty')
  LIVE_STATE=$(echo "$GH_LIVE_JSON" | jq -r '.state')

  if [ -n "$CACHED_HEAD" ] && [ "$LIVE_HEAD" != "$CACHED_HEAD" ]; then
    echo "DISCREPANCY: live headRefOid ($LIVE_HEAD) != task-store cached commitSha ($CACHED_HEAD) — new commits landed since the task-store record was last written."
  fi
  if [ "$LIVE_STATE" = "MERGED" ] && [ "$(echo "$PR_RECORD_JSON" | jq -r '.state // empty')" != "merged" ]; then
    echo "DISCREPANCY: PR is merged on GitHub but the task-store record does not reflect it."
  fi
fi
```

Any drift found here (stale `commitSha`, a merge the task-store hasn't caught
up to, a `mergeStateStatus` that's since cleared) is itself often the answer
to "why didn't this run as expected" — call it out explicitly rather than
picking a side.

### Short-circuit

If these three signals alone answer the investigation with high confidence —
e.g. the work-queue snapshot shows the item is far from next, `hitl=true` is
actively blocking, or the task-store/GitHub diff shows a state (merged,
closed, `mergeStateStatus` blocked) that plainly explains "not its turn yet"
or "blocked by a flag" — **report the conclusion now and stop; there is no
need to proceed to session/transcript extraction.** Otherwise, continue to Step 3.
---

## Step 3: Delegate transcript extraction, Sentry and synthesis structure

For each run in `ITEM_RUNS`, hand its `sessionId` and `startedAt` (and the phase
name resolved in 1a) to `agent-platform:investigate-cron`, which owns
transcript location (direct by `sessionId`, mtime-window fallback when null),
extraction of what the model did and why, the Sentry cross-check, and the
synthesis structure. Do not re-implement any of that here. Run it once per
dispatch so the result is a chronological narrative across phases, and carry
Step 2's ground-truth findings (queue rank, `hitl`, `reviewState`, drift) into
the conclusion — they are often the real answer.

If `agent-platform:investigate-cron` is unavailable in this agent's plugin set,
say so and report the Step 1 dispatch table and Step 2 findings only; do not
fall back to hand-rolled transcript parsing.

---

## Step 4: Synthesize the explanation

Combine Step 2's ground truth with each dispatch's findings. Output, one entry
per dispatch, chronological:

```
Item: <org/repo#N|taskId>
Dispatch history (<N> run(s) across <phases>):

[1] Phase: dev-task  Time: <startedAt> (session: <session-id>)
    What happened: <narrative>
    Conclusion: <decision>

[2] Phase: review  Time: <startedAt> (session: <session-id>)
    ...
```

`<session-id>` is the run's `sessionId` from the admin API record. Follow the
list with the ground-truth conclusion (why the item is not progressing now, if
that is what the evidence shows).

---

## No dispatch history

If no run is found for the item:

```
No dispatch history found for item "<item>".

Possible reasons:
1. The preCheck script returned non-zero — the cron was suppressed before Claude ran.
   preCheck failures are logged to stdout via console.error with an "[agent:cron]" prefix
   (agent/src/cron-handler.ts).
2. The item was never dispatched through the admin-tracked loop cron — check the task
   store / GitHub directly for its history (Step 2).
3. A cron was disabled at the time. Verify via:
      curl -s -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
        "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" | jq '.crons[] | {name, enabled}'
```

---

## Notes

- Sources: the admin API (`AgentCronRun` records: exactly when and against what
  item a cron fired), the task store and GitHub (the item's current state), and,
  via `agent-platform:investigate-cron`, transcripts and Sentry.
- Prefer the ground-truth snapshot (Step 2) over transcript extraction whenever
  it alone answers the question.
