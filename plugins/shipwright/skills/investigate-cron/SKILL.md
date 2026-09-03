---
name: investigate-cron
description: >
  Diagnose why a cron run behaved unexpectedly — looks up the exact run via the
  admin cron-runs API (by name+time or by PR/task id), finds the matching Claude
  Code session transcript, reads what the model did and why, and explains it in
  plain language. No log files needed; the transcript is the source of truth.
---

# investigate-cron

Diagnose a cron run either by name and approximate execution time, or directly
by the PR/task it was dispatched against.

**Usage:**
- `/shipwright:investigate-cron <name> <time>` — find the run of cron `<name>`
  closest to `<time>`
- `/shipwright:investigate-cron --item <org/repo#N|taskId>` — find every
  dispatch across all four pipeline phases for a given PR or task

Arguments:

- `<name>` — cron name: `deploy`, `dev-task`, `patch`, `review`
- `<time>` — approximate time the cron fired, e.g. `6pm`, `14:30`, `2:30pm PST`.
  Timezone defaults to Pacific if not specified.
- `--item <org/repo#N|taskId>` — a PR (`org/repo#N`, e.g. `acme/x#123`) or a bare
  task id (e.g. `IC-1.1`). When present, no time argument is needed or used.

**Examples:**
- `/shipwright:investigate-cron deploy 6pm`
- `/shipwright:investigate-cron --item acme/x#123`
- `/shipwright:investigate-cron --item IC-1.1`

---

## Step 0: Bind invocation arguments and pick a mode

Before running any steps, parse the invocation and detect which mode applies.

```bash
# Set these from the user's invocation:
#   /shipwright:investigate-cron <name> <time>
#   /shipwright:investigate-cron --item <org/repo#N|taskId>

# If the first argument is literally "--item", route to item mode:
if [ "$1" = "--item" ]; then
  MODE="item"
  ITEM_ARG="$2"   # e.g. "acme/x#123" or "IC-1.1"
else
  MODE="name-time"
  CRON_NAME="$1"  # e.g. deploy
  TIME_ARG="$2"   # e.g. 6pm
fi
```

For example:
- `/shipwright:investigate-cron deploy 6pm` → `MODE=name-time`, `CRON_NAME="deploy"`, `TIME_ARG="6pm"`
- `/shipwright:investigate-cron --item acme/x#123` → `MODE=item`, `ITEM_ARG="acme/x#123"`

`--item` mode skips time parsing entirely (3a does not apply) — there is no
target time to convert, since the runs endpoint returns every dispatch for that
item directly.

Do not proceed to Step 1 until the mode and its variables are set.

---

## Step 1: Resolve the run via the admin cron-runs API

The admin API (`$SHIPWRIGHT_API_URL`, authenticated with
`Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY`, agent id `$SHIPWRIGHT_AGENT_ID`)
is the primary, exact source for cron run history — it replaces guessing from
transcript file mtimes. Both modes start by listing this agent's crons to find
the loop cron and (in name+time mode) the phase cron.

### 1a. List crons and resolve `loopCronId` (and `phaseId` for name+time mode)

```bash
CRONS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons")

# The loop cron is the top-level cron: parentCronId === null (typically
# system === true and named "shipwright-loop"). Phase crons (dev-task, review,
# patch, deploy) are children: parentCronId === <loop cron's id>.
LOOP_CRON_ID=$(echo "$CRONS_JSON" | jq -r '.crons[] | select(.parentCronId == null and .system == true) | .id' | head -1)

if [ -z "$LOOP_CRON_ID" ] || [ "$LOOP_CRON_ID" = "null" ]; then
  echo "No loop cron found via admin API — falling back to the pre-admin-API path (see Fallback section below)."
else
  echo "loopCronId: $LOOP_CRON_ID"
fi
```

Name+time mode additionally needs the phase cron's id (`phaseId`) so runs can be
filtered to just that phase:

```bash
# Only needed in name+time mode.
PHASE_ID=$(echo "$CRONS_JSON" | jq -r --arg loop "$LOOP_CRON_ID" --arg name "$CRON_NAME" \
  '.crons[] | select(.parentCronId == $loop and (.name | sub("^shipwright-"; "")) == $name) | .id' | head -1)
echo "phaseId: $PHASE_ID"
```

If `LOOP_CRON_ID` (or, in name+time mode, `PHASE_ID`) can't be resolved — the
admin API is unreachable, this agent has no `shipwright-loop` cron, or no phase
cron matches `<name>` — fall back to the pre-admin-API approach documented in
the **Fallback: pre-admin-API history** section below, and skip the rest of
this step.

### 1b. List runs for the loop cron, filtered server-side

`GET /agents/{id}/crons/{cronId}/runs` supports `limit`/`offset` plus
server-side `itemId`/`phaseId` query filters — pass `phaseId=` (name+time mode)
or `itemId=` (item mode) directly as query params and the server narrows the
Prisma `where` clause accordingly. There's no need to paginate through the full
run history and filter client-side anymore.

**Name+time mode** — fetch runs scoped to `phaseId=$PHASE_ID` directly. A
single phase's run history is typically much smaller than the loop cron's full
history, so one call with a generous `limit` is usually enough; only paginate
(mirroring the loop below, scoped by `phaseId`) if `total` exceeds what you
fetched:

```bash
PHASE_RUNS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/$LOOP_CRON_ID/runs?phaseId=$PHASE_ID&limit=100")
PHASE_RUNS_FILE=$(mktemp)
echo "$PHASE_RUNS_JSON" | jq '.items' > "$PHASE_RUNS_FILE"

TOTAL=$(echo "$PHASE_RUNS_JSON" | jq -r '.total')
OFFSET=100
while [ "$OFFSET" -lt "$TOTAL" ]; do
  PAGE_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
    "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/$LOOP_CRON_ID/runs?phaseId=$PHASE_ID&limit=100&offset=$OFFSET")
  PHASE_RUNS_FILE_NEW=$(mktemp)
  jq -s '.[0] + .[1]' "$PHASE_RUNS_FILE" <(echo "$PAGE_JSON" | jq '.items') > "$PHASE_RUNS_FILE_NEW"
  mv "$PHASE_RUNS_FILE_NEW" "$PHASE_RUNS_FILE"
  OFFSET=$((OFFSET + 100))
done
echo "Fetched $(jq 'length' "$PHASE_RUNS_FILE") runs for phaseId=$PHASE_ID"
```

Then pick the run whose `startedAt` is closest to `TARGET_EPOCH` (computed in
3a) — this ranking is still done client-side, since the API doesn't take a
"closest to a timestamp" query:

```bash
BEST_RUN=$(jq -r --argjson target "$TARGET_EPOCH" '
  map(. + {distance: ((((.startedAt | sub("\\.[0-9]+Z$"; "Z")) | fromdateiso8601) - $target) | if . < 0 then -. else . end)})
  | sort_by(.distance)
  | first
' "$PHASE_RUNS_FILE")

if [ "$BEST_RUN" = "null" ] || [ -z "$BEST_RUN" ]; then
  echo "No runs found for phaseId=$PHASE_ID — fall back to the pre-admin-API path."
else
  RUN_STARTED_AT=$(echo "$BEST_RUN" | jq -r '.startedAt')
  # Populate ITEM_ARG from the resolved run's itemId so Step 2's ground-truth
  # signals (2a's work-queue rank lookup, 2b's task-id fallback) work in
  # name+time mode too, exactly as they do in item mode.
  ITEM_ARG=$(echo "$BEST_RUN" | jq -r '.itemId // empty')
  echo "Matched run: $(echo "$BEST_RUN" | jq -r '.id') startedAt=$RUN_STARTED_AT itemId=${ITEM_ARG:-<none>}"
fi
```

If `BEST_RUN` has no `itemId` (e.g. a loop-tick run not dispatched against a
specific PR/task), `ITEM_ARG` stays empty and Step 2's item-scoped signals
degrade gracefully — same behavior as when they're checked against an
already-empty `ITEM_ARG` today.

**Item mode** — fetch runs scoped to `itemId=$ITEM_ARG` directly; the server
returns every matching run across all four phases in one call, no client-side
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
`itemId=$ITEM_ARG&limit=100&offset=<n>` the same way as the name+time mode loop
above before sorting — in practice an item's dispatch count across four phases
is small enough that this rarely triggers.

If `ITEM_RUNS` is empty, no run was ever dispatched for that PR/task through the
admin-tracked loop cron — either it predates run tracking, or the item was
never processed. Fall back to the pre-admin-API path only if you have a rough
time window to search from another source (e.g. `gh pr view` timestamps);
otherwise report that no dispatch history exists.

### 1c. From the resolved run to a transcript

Once you have the resolved run (name+time mode: `BEST_RUN`; item mode: each
entry in `ITEM_RUNS`), check its `sessionId` field first — this is the exact
Claude session id the run recorded, not a guess:

```bash
SESSION_ID=$(echo "$BEST_RUN" | jq -r '.sessionId // empty')  # or per-entry in ITEM_RUNS
```

**If `sessionId` is non-null**, skip the mtime-window search entirely and
construct the transcript path directly — no scanning or matching required:

```bash
TRANSCRIPT_PATH="$TRANSCRIPT_DIR/$SESSION_ID.jsonl"
if [ -f "$TRANSCRIPT_PATH" ]; then
  echo "Transcript resolved directly via sessionId: $TRANSCRIPT_PATH"
else
  echo "Run has sessionId=$SESSION_ID but no matching .jsonl file exists at $TRANSCRIPT_PATH — the transcript may have been pruned. Fall back to the mtime-window search (3b) as a best-effort recovery."
fi
```

`$TRANSCRIPT_DIR` is derived from the CWD exactly as described in 3b — that
derivation is shared by both this direct path and the fallback below, so run
it once regardless of which path you end up taking.

**If `sessionId` is null** — the run predates CSI-3.1 (session-id recording),
or the CLI produced no stdout at all for that invocation — fall back to Step
3b's existing tight mtime-window search around the run's exact `startedAt`
(name+time mode: `RUN_STARTED_AT`; item mode: the entry's own `startedAt`).
That fallback logic is unchanged; see **"When sessionId is null: mtime-window
fallback"** in 3b.

---

## Step 2: Ground-truth snapshot (both modes)

Before extracting anything from a transcript, pull current live state. Often
the answer to "why didn't this run/proceed" is fully explained by state that
exists **right now** — the item simply isn't next in the queue yet, or it's
blocked by a flag — without needing to read a single line of session output.
This step runs for **both `name-time` mode and `item` mode**: in `item` mode
the ground-truth signals apply directly to `ITEM_ARG`; in `name-time` mode
Step 1b populates `ITEM_ARG` from the resolved run's `itemId` once a run is
matched, so the same signals below work unmodified in both modes (or, if
Step 1 found no run at all, `ITEM_ARG` stays empty and these signals degrade
gracefully per-signal, same as an absent snapshot/record).

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
`dev-task`/`review`/`patch`/`deploy` cron. If it's absent from the snapshot
entirely, either it wasn't a ready candidate at the last tick, or no snapshot
exists yet — note which, and move on to 2b/2c rather than guessing.

### 2b. Task-store PR/task record

Fetch the task-store's cached view of the item — the PR record, the task
record, or both, depending on what `ITEM_ARG` (or the item implied by
`name-time` mode) resolves to:

```bash
# PR record (when the item is a PR, org/repo#N):
PR_RECORD_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&prNumber={pr}" | jq -c '.prs[0] // empty')

if [ -z "$PR_RECORD_JSON" ]; then
  echo "No task-store PR record for {org}/{repo}#{pr} — not yet tracked, or never a PR. Skip this signal."
else
  echo "$PR_RECORD_JSON" | jq '{claimedBy, hitl, reviewState, readyForReviewAt, readyForPatchAt, readyForDeployAt, patchCycles, commitSha}'
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
elif [ -n "$PR_RECORD_JSON" ]; then
  # ITEM_ARG is a PR reference — fetch associated tasks via live lookup
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
pattern used elsewhere in this plugin (e.g. `deploy.md`, `patch.md`,
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
need to proceed to session/transcript extraction.** This applies in both
`name-time` mode and `item` mode. Otherwise, continue to Step 3.

---

## Step 3: Locate and extract the transcript

This step covers converting the time argument, finding the matching
session(s), and extracting what happened from the transcript — the three
sub-steps below run in sequence whenever Step 2's ground-truth signals were
inconclusive and transcript evidence is actually needed.

### 3a. Convert the time argument (name+time mode only)

Only applies when `MODE=name-time`. Item mode has no time argument and skips
this step.

Parse the `<time>` argument to a Unix epoch in the **Pacific timezone** (default).
This produces `TARGET_EPOCH`, used in Step 1b to pick the closest run.

```python
#!/usr/bin/env python3
import sys
from datetime import datetime, timezone
import zoneinfo
import re

time_arg = sys.argv[1]  # e.g. "6pm", "14:30", "2:30pm", "6pm PST"
date_str = sys.argv[2]  # today's date in YYYY-MM-DD, passed from bash

# Detect explicit timezone
tz_name = "America/Los_Angeles"  # Pacific default
if "PST" in time_arg or "PDT" in time_arg:
    tz_name = "America/Los_Angeles"
elif "EST" in time_arg or "EDT" in time_arg:
    tz_name = "America/New_York"
elif "UTC" in time_arg:
    tz_name = "UTC"

tz = zoneinfo.ZoneInfo(tz_name)
clean = re.sub(r'\s*(PST|PDT|EST|EDT|UTC)', '', time_arg).strip()

# Parse time portion
for fmt in ["%I%p", "%I:%M%p", "%H:%M", "%H"]:
    try:
        t = datetime.strptime(clean.upper(), fmt)
        target = datetime(int(date_str[:4]), int(date_str[5:7]), int(date_str[8:]),
                          t.hour, t.minute, tzinfo=tz)
        print(int(target.timestamp()))
        break
    except ValueError:
        continue
```

Run it:
```bash
TARGET_EPOCH=$(python3 -c "
import sys, re, zoneinfo
from datetime import datetime

time_arg = '${TIME_ARG}'
today = '$(date +%Y-%m-%d)'
tz = zoneinfo.ZoneInfo('America/Los_Angeles')
clean = re.sub(r'\s*(PST|PDT|EST|EDT|UTC)', '', time_arg).strip().upper()
for fmt in ['%I%p', '%I:%M%p', '%H:%M', '%H']:
    try:
        t = datetime.strptime(clean, fmt)
        dt = datetime(int(today[:4]), int(today[5:7]), int(today[8:]), t.hour, t.minute, tzinfo=tz)
        print(int(dt.timestamp()))
        break
    except: pass
else:
    import sys; sys.stderr.write(f'Could not parse time: {clean}\n'); sys.exit(1)
") || { echo "Error: could not parse time '${TIME_ARG}'"; exit 1; }
echo "Target epoch: $TARGET_EPOCH ($(date -d @$TARGET_EPOCH 2>/dev/null || date -r $TARGET_EPOCH))"
```

### 3b. Find matching sessions

Derive the transcript directory from the current working directory (CWD), then
locate the session(s) that correspond to the run(s) resolved in Step 1.

Claude Code stores session transcripts at:
```
~/.claude/projects/<encoded-cwd>/
```

The encoding rule: replace every `/` and `.` character with `-`.

```bash
# Get the CWD and encode it
CWD=$(pwd)
ENCODED=$(echo "$CWD" | tr '/.' '-')
TRANSCRIPT_DIR="$HOME/.claude/projects/$ENCODED"
echo "Transcript directory: $TRANSCRIPT_DIR"
ls "$TRANSCRIPT_DIR"/*.jsonl 2>/dev/null | head -20
```

Example: `/data/agent/home/workspace` encodes to `-data-agent-home-workspace`,
so transcripts live at `~/.claude/projects/-data-agent-home-workspace/`.

If the directory doesn't exist or contains no `.jsonl` files, it means this
workspace has no Claude Code session history at this path. Verify the CWD is
the agent workspace root.

**When `sessionId` is null: mtime-window fallback.** Step 1c's direct
`$TRANSCRIPT_DIR/$SESSION_ID.jsonl` lookup is the preferred path whenever the
resolved run carries a non-null `sessionId` — this section only applies when
it doesn't (runs that predate CSI-3.1, or a CLI invocation that produced no
stdout). In that case you still have an exact `startedAt` for the run (Step
1c). Use a tight window (e.g. ±5 minutes) around that timestamp against the
`.jsonl` file mtimes to find the matching transcript — this is a precision
narrowing step, not an exact match, which is why it's the fallback rather than
the primary matching mechanism now that `sessionId` is available.
`startedAt` is ISO 8601 (e.g. `2026-07-21T01:11:46.391Z`) — convert it to epoch
seconds first (in item mode, repeat this per entry in `ITEM_RUNS`):

```bash
RUN_STARTED_EPOCH=$(date -d "$RUN_STARTED_AT" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${RUN_STARTED_AT%%.*}" +%s)
```

```bash
python3 -c "
import os, glob

transcript_dir = '$TRANSCRIPT_DIR'
run_started_epoch = $RUN_STARTED_EPOCH  # RUN_STARTED_AT converted to epoch seconds
window = 300  # 5 minutes — tight, since we have an exact known event time

candidates = []
for path in glob.glob(os.path.join(transcript_dir, '*.jsonl')):
    mtime = os.path.getmtime(path)
    if abs(mtime - run_started_epoch) <= window:
        candidates.append((mtime, path))

candidates.sort()
for mtime, path in candidates:
    session_id = os.path.basename(path).replace('.jsonl', '')
    print(f'{session_id}  mtime={mtime}  path={path}')
"
```

If exactly one candidate is found, that's the transcript for the resolved run.
If multiple are found, pick the one whose first entry timestamp is closest to
`run_started_epoch`. If none are found, the transcript may have been pruned or
this workspace's CWD doesn't match where the cron actually ran — see the
**Fallback** section below or the no-match handler at the end.

---

## Fallback: pre-admin-API history

Runs that predate admin-API run tracking (or that the admin API can't resolve
for any reason — unreachable, no `shipwright-loop` cron found, no phase cron
matching `<name>`, no runs returned for the resolved `phaseId`/`itemId`) have no
exact `startedAt` to anchor on. For those, fall
back to the original fuzzy approach: a ±90 minute mtime window plus
`[Cron job:]` string-matching in the transcript's first user message. This path
only applies to `name-time` mode — `--item` mode has no time argument to build
a fuzzy window from, so if the admin API has no runs for an item, report that
no dispatch history was found rather than guessing.

Search JSONL files in the transcript directory. Use `mtime` as a fast
pre-filter: files modified within ±90 minutes of the target time are candidates.

```bash
WINDOW=5400  # 90 minutes in seconds
LOWER=$((TARGET_EPOCH - WINDOW))
UPPER=$((TARGET_EPOCH + WINDOW))

# Find JSONL files modified in the window
python3 -c "
import os, glob, json

transcript_dir = '$TRANSCRIPT_DIR'
lower = $LOWER
upper = $UPPER
cron_name = '$CRON_NAME'

candidates = []
for path in glob.glob(os.path.join(transcript_dir, '*.jsonl')):
    mtime = os.path.getmtime(path)
    if lower <= mtime <= upper:
        candidates.append((mtime, path))

candidates.sort()
print(f'Found {len(candidates)} candidate files in ±90min window')

# Match cron name in first user message containing [Cron job:]
matches = []
for mtime, path in candidates:
    with open(path) as f:
        for line in f:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get('type') != 'user':
                continue
            content = entry.get('message', {}).get('content', '')
            if not isinstance(content, str):
                continue
            if '[Cron job:' in content and cron_name in content.lower():
                session_id = os.path.basename(path).replace('.jsonl', '')
                matches.append({'path': path, 'mtime': mtime, 'session_id': session_id,
                                 'prompt_preview': content[:200]})
                break

print(f'Matching sessions for cron \"{cron_name}\": {len(matches)}')
for m in matches:
    import datetime
    t = datetime.datetime.fromtimestamp(m['mtime'])
    print(f'  {m[\"session_id\"]} @ {t}')
    print(f'  Prompt: {m[\"prompt_preview\"]}')
"
```

If multiple matches exist (e.g. cron fired twice), pick the one closest to the
target time. If no matches are found, skip to the no-match handler at the end.

### 3c. Extract what happened

Parse the matching session JSONL to extract the narrative: initial prompt,
assistant text outputs, key Bash commands, and whether the session ended silently.

```python
#!/usr/bin/env python3
import json, sys

path = sys.argv[1]  # path to the matching .jsonl file

initial_prompt = None
assistant_texts = []
bash_commands = []
ended_silently = False

with open(path) as f:
    for line in f:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        role = entry.get('type')
        msg = entry.get('message', {})
        content = msg.get('content', '')

        if role == 'user' and isinstance(content, str) and initial_prompt is None:
            initial_prompt = content

        elif role == 'assistant' and isinstance(content, list):
            for block in content:
                btype = block.get('type')
                if btype == 'text':
                    text = block.get('text', '').strip()
                    if text:
                        # Check for [silent] marker
                        if '[silent]' in text:
                            ended_silently = True
                        assistant_texts.append(text)
                elif btype == 'thinking':
                    pass  # skip thinking blocks
                elif btype == 'tool_use' and block.get('name') == 'Bash':
                    inp = block.get('input', {})
                    cmd = inp.get('command', '')
                    desc = inp.get('description', '')
                    if cmd:
                        bash_commands.append({'command': cmd[:300], 'description': desc})

print('=== INITIAL PROMPT ===')
print((initial_prompt or '')[:500])
print()
print(f'=== ASSISTANT OUTPUTS ({len(assistant_texts)} blocks) ===')
for i, t in enumerate(assistant_texts[:10], 1):
    print(f'[{i}] {t[:400]}')
    print()
print(f'=== BASH COMMANDS ({len(bash_commands)} total) ===')
for b in bash_commands[:20]:
    print(f'  # {b["description"]}')
    print(f'  {b["command"][:200]}')
    print()
print(f'=== SILENT: {ended_silently} ===')
```

Run it against the matched session file and capture the output for synthesis.
In item mode, run this once per session matched to each entry in `ITEM_RUNS` —
the goal is a chronological narrative across all four phases, not a single run.

**Key signals to look for:**

- The **initial prompt** confirms which cron fired and its trigger context
- **Assistant text blocks** reveal the model's reasoning, decisions, and conclusions
- **Bash commands** show exactly what actions were taken (GitHub API calls, file reads, etc.)
- **`[silent]`** in the final assistant message means the cron ran but had nothing to report —
  this is expected behavior (e.g. preCheck passed but skill found no qualifying work)
- Missing or empty outputs may indicate the session was aborted or hit a context limit

---

## Step 4: Sentry cross-check

Cross-check the transcript's account of "what happened" against what Sentry
actually recorded for the same time window — an unhandled exception or a
smoking-gun `console.log`/`console.warn`/`console.error` line often explains
unexpected cron behavior more directly than anything in the transcript itself,
and this dataset is easy to forget to check.

### 4a. Preconditions

Confirm `SENTRY_ORG` and `SENTRY_AUTH_TOKEN` are both set in the environment
(`echo "org_set=$([ -n "$SENTRY_ORG" ] && echo yes || echo no)
token_set=$([ -n "$SENTRY_AUTH_TOKEN" ] && echo yes || echo no)"`). If either is
unset or empty, print:

```
investigate-cron's Sentry cross-check requires SENTRY_ORG and SENTRY_AUTH_TOKEN to be set in the environment. Skipping this step — continuing without Sentry data.
```

and skip straight to Step 5 — **never block the rest of the investigation** on
missing Sentry credentials. This mirrors `error-scan`'s Step 0 gating pattern
(see `plugins/shipwright/skills/error-scan/SKILL.md`).

Never print, log, or persist the literal values of `$SENTRY_AUTH_TOKEN` or
`$SENTRY_ORG` — reference them only as env var names, exactly like `error-scan`
does, in any output this step produces.

Determine the run's time window before calling either API below: the run's
`startedAt` (from Step 1) plus a reasonable margin (e.g. ±30-60 minutes), or —
for an investigation of something still in progress — the run-to-now window.

### 4b. Issues API — unresolved exceptions and 5xx errors

```bash
curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/?query=is:unresolved"
```

This endpoint doesn't take a raw time-window query param — `query=is:unresolved`
is the only filter applied server-side. Scope the result to the run's window
**client-side**, by comparing each issue's `firstSeen`/`lastSeen` timestamps
against `[RUN_STARTED_AT - margin, RUN_STARTED_AT + margin]` (or
`now` if the window is open-ended) via `jq`, e.g.:

```bash
echo "$ISSUES_JSON" | jq -r --arg lower "$WINDOW_LOWER_ISO" --arg upper "$WINDOW_UPPER_ISO" '
  .[] | select(.lastSeen >= $lower and .firstSeen <= $upper) |
  "\(.shortId)  \(.title)  firstSeen=\(.firstSeen)  lastSeen=\(.lastSeen)  \(.permalink)"
'
```

Be explicit in any output that this window filtering happened client-side, not
via the API — a raw unfiltered `is:unresolved` result includes every
currently-unresolved issue org-wide, most of which have nothing to do with
this run.

### 4c. ourlogs — structured console output for the same window

The `ourlogs` dataset carries every `console.log`/`console.warn`/`console.error`
call forwarded to Sentry as structured logs (see `docs/observability.md`'s
"Read side" section) — **this is the dataset that resolved a near-identical
prior "shipwright-loop stall" investigation, and the one this team keeps
forgetting to check.** Query it via the Events API with the same
`SENTRY_ORG`/`SENTRY_AUTH_TOKEN` credentials:

```bash
curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  --data-urlencode "dataset=ourlogs" \
  --data-urlencode "project=<numeric_project_id>" \
  --data-urlencode "field=timestamp" --data-urlencode "field=message" \
  --data-urlencode "query=<search text>" \
  --data-urlencode "statsPeriod=24h" \
  --data-urlencode "sort=-timestamp" --data-urlencode "per_page=100" \
  -G "https://sentry.io/api/0/organizations/$SENTRY_ORG/events/"
```

Notes on adapting this query form to the investigated run rather than a fixed
window:
- `statsPeriod=24h` is a rough relative window (fine for an ad-hoc lookback);
  prefer precise `start`/`end` ISO-8601 params instead when the run's exact
  `startedAt` is known (from Step 1) — e.g. `--data-urlencode
  "start=<RUN_STARTED_AT minus margin>" --data-urlencode "end=<RUN_STARTED_AT
  plus margin, or now>"` in place of `statsPeriod`. Use whichever gives the
  tightest accurate window for this investigation.
- `<search text>` should target the cron/item under investigation (e.g. the
  cron name, item id, or task id) so results aren't just every log line in the
  window.
- `<numeric_project_id>` must be resolved before this call — this skill doesn't
  otherwise enumerate Sentry projects. If it isn't already known, resolve it
  via the project list endpoint, mirroring `error-scan`'s Step 1:
  ```bash
  curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
    "https://sentry.io/api/0/organizations/$SENTRY_ORG/projects/"
  ```
  and pick the project whose `slug` matches the service under investigation
  (e.g. `agent`).
- `per_page=100` caps the page size — if the result looks truncated (exactly
  100 rows returned, or the window is wide), narrow the query text/window or
  page via the response's pagination cursor rather than trusting a single
  page's results as complete.

### Short-circuit

If Sentry surfaces a clear unhandled exception or a smoking-gun log line
inside the run's window, that alone can explain "why did this behave
unexpectedly" — note it plainly in the findings carried into Step 5. Step 5's
synthesis should cite Sentry-sourced findings as `[verified: Sentry]` once the
citation-tagging convention is implemented (out of scope for this step — see
the task that rewrites Step 5's synthesis content).

---

## Step 5: Synthesize the explanation

Produce a plain-language explanation covering:

1. **Cron name** — which cron was investigated (`deploy`, `dev-task`, etc.) — in item
   mode, list every phase that dispatched against the item
2. **Time** — when the session fired (from the resolved run's `startedAt`, or the
   JSONL mtime/first entry timestamp when using the fallback path)
3. **Session ID** — the resolved run's `sessionId` field from the admin API record when
   available (Step 1c's direct lookup), falling back to the JSONL filename (without
   `.jsonl`) matched via the mtime window when `sessionId` is null — either way, this is
   for cross-referencing logs
4. **What it did** — summarize the bash commands and assistant reasoning in 2–5 sentences
5. **Conclusion** — what the cron decided and why (approved, skipped, silenced, errored)
6. **Why (if unexpected)** — if the behavior was surprising, explain the root cause

**Output format (name+time mode):**

```
Cron: <name>
Time: <time> Pacific (session: <session-id>)

What happened:
<2–5 sentence narrative of what the session did>

Conclusion:
<What the cron ultimately decided — and why>

Why (if unexpected):
<Root cause explanation if the result was surprising>
```

**Output format (item mode)** — one entry per dispatch, chronological:

```
Item: <org/repo#N|taskId>
Dispatch history (<N> run(s) across <phases>):

[1] Phase: dev-task  Time: <startedAt> (session: <session-id>)
    What happened: <narrative>
    Conclusion: <decision>

[2] Phase: review  Time: <startedAt> (session: <session-id>)
    ...
```

---

## No match / preCheck skipped

If no matching run/session is found (via the admin API or the fallback ±90
minute window):

```
No session found for cron "<name>" around <time> Pacific.
(or, in item mode: No dispatch history found for item "<item>".)

Possible reasons:
1. The preCheck script returned non-zero — the cron was suppressed before Claude ran.
   Check logs/bodhi.log for "[preCheck]" lines around <time>.
2. The cron was disabled at the time. Verify via:
      curl -s -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
        "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" | jq '.crons[] | select(.name | test("<name>"))'
3. The cron fired in a different workspace — check if $AGENT_HOME differs.
4. Name+time mode only: the ±90 minute fallback search window was too narrow. Try a broader time range.
5. Item mode only: the item was never dispatched through the admin-tracked loop cron —
   check the task store / GitHub directly for its history instead.
```

For case 1, grep bodhi.log:
```bash
grep -i "precheck\|pre-check\|cron" logs/bodhi.log | tail -50
```

---

## Notes

- This skill reads the admin API, the task store, live GitHub state, transcript
  files, and (optionally, Step 4) Sentry — it does **not** require container stdout or
  any external log system beyond `logs/bodhi.log` for the preCheck fallback case. The
  Claude Code session JSONL is the authoritative record of what the model concluded and
  why; the admin API's `AgentCronRun` records are the authoritative record of exactly
  when and against what item a cron fired; the task store and GitHub are the
  authoritative record of an item's *current* state (Step 2); Sentry (Step 4) is the
  authoritative record of unhandled exceptions and structured console output, when
  `SENTRY_ORG`/`SENTRY_AUTH_TOKEN` are configured.
- Prefer the admin-API path (Step 1) over the fallback whenever the admin API is
  reachable and returns run records — it gives an exact `startedAt` instead of a guess,
  and item mode is only possible through it.
- The admin API is now the exact source for session id too, not just `startedAt`: a
  resolved run's `sessionId` field (when non-null) points directly at
  `$TRANSCRIPT_DIR/$SESSION_ID.jsonl` (Step 1c) — no mtime-window search needed. The
  ±5 minute mtime-window match in 3b is now only a fallback for runs where `sessionId`
  is null (pre-CSI-3.1 runs, or a CLI invocation with no stdout).
- Prefer the ground-truth snapshot (Step 2) over transcript extraction whenever it alone
  answers the question — it's cheaper and doesn't require a matching session to exist at
  all. Fall through to Steps 3–5 only when live state is inconclusive.
- Step 4 (Sentry cross-check) is best-effort and never blocking — a missing
  `SENTRY_ORG`/`SENTRY_AUTH_TOKEN` simply skips straight to Step 5 with a printed notice.
- A `[silent]` response is **expected behavior** when the skill found nothing to do —
  look at the bash commands to understand what it checked.
- Multiple sessions in a window: pick the one whose first entry timestamp (not mtime)
  is closest to the target time.
- JSONL entries with `type: "summary"` are condensed context records — skip them
  when extracting the narrative; they don't reflect actual model output.
