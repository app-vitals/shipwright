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

`--item` mode skips time parsing entirely (Step 2 does not apply) — there is no
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

### 1b. List runs for the loop cron and filter client-side

`GET /agents/{id}/crons/{cronId}/runs` only supports `limit`/`offset` — there is
**no server-side `phaseId` or `itemId` query filter**. Fetch pages of runs and
filter the returned `items` array in your own script; do not pass `phaseId=` or
`itemId=` as query params, the server ignores them.

```bash
# Paginate through runs (limit=100 per page, cap at 5 pages / 500 runs).
ALL_RUNS_FILE=$(mktemp)
echo "[]" > "$ALL_RUNS_FILE"
OFFSET=0
LIMIT=100
for PAGE in 1 2 3 4 5; do
  PAGE_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
    "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/$LOOP_CRON_ID/runs?limit=$LIMIT&offset=$OFFSET")
  ITEMS=$(echo "$PAGE_JSON" | jq '.items')
  TOTAL=$(echo "$PAGE_JSON" | jq -r '.total')
  ALL_RUNS_FILE_NEW=$(mktemp)
  jq -s '.[0] + .[1]' "$ALL_RUNS_FILE" <(echo "$ITEMS") > "$ALL_RUNS_FILE_NEW"
  mv "$ALL_RUNS_FILE_NEW" "$ALL_RUNS_FILE"
  OFFSET=$((OFFSET + LIMIT))
  if [ "$OFFSET" -ge "$TOTAL" ]; then
    break
  fi
done
echo "Fetched $(jq 'length' "$ALL_RUNS_FILE") total runs for loopCronId=$LOOP_CRON_ID"
```

**Name+time mode** — filter client-side to `phaseId === <PHASE_ID>`, then pick
the run whose `startedAt` is closest to `TARGET_EPOCH` (computed in Step 2):

```bash
BEST_RUN=$(jq -r --arg phase "$PHASE_ID" --argjson target "$TARGET_EPOCH" '
  map(select(.phaseId == $phase))
  | map(. + {distance: ((((.startedAt | sub("\\.[0-9]+Z$"; "Z")) | fromdateiso8601) - $target) | if . < 0 then -. else . end)})
  | sort_by(.distance)
  | first
' "$ALL_RUNS_FILE")

if [ "$BEST_RUN" = "null" ] || [ -z "$BEST_RUN" ]; then
  echo "No runs found for phaseId=$PHASE_ID within the fetched page cap — fall back to the pre-admin-API path."
else
  RUN_STARTED_AT=$(echo "$BEST_RUN" | jq -r '.startedAt')
  echo "Matched run: $(echo "$BEST_RUN" | jq -r '.id') startedAt=$RUN_STARTED_AT"
fi
```

**Item mode** — filter client-side to `itemId === <ITEM_ARG>`, returning every
matching run across all four phases, sorted chronologically:

```bash
ITEM_RUNS=$(jq -r --arg item "$ITEM_ARG" '
  map(select(.itemId == $item)) | sort_by(.startedAt)
' "$ALL_RUNS_FILE")

echo "Found $(echo "$ITEM_RUNS" | jq 'length') dispatch(es) for item \"$ITEM_ARG\":"
echo "$ITEM_RUNS" | jq -r '.[] | "  \(.startedAt)  phaseId=\(.phaseId)  outcome=\(.outcome)  skipped=\(.skipped)"'
```

If `ITEM_RUNS` is empty, no run was ever dispatched for that PR/task through the
admin-tracked loop cron — either it predates run tracking, or the item was
never processed. Fall back to the pre-admin-API path only if you have a rough
time window to search from another source (e.g. `gh pr view` timestamps);
otherwise report that no dispatch history exists.

### 1c. From the resolved run to a transcript

Once you have the run's exact `startedAt` (name+time mode: `RUN_STARTED_AT`;
item mode: each entry in `ITEM_RUNS`), use it as a **tight window** — a few
minutes, not ±90 — around the transcript directory's file mtimes in Step 3,
since this is now a known exact event time rather than a guess. The transcript
directory itself is still resolved the same way (see Step 3).

---

## Step 2: Convert the time argument (name+time mode only)

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

---

## Step 3: Find matching sessions

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

**With an admin-API run resolved (preferred path):** you have an exact
`startedAt` for the run (Step 1c). Use a tight window (e.g. ±5 minutes) around
that timestamp against the `.jsonl` file mtimes to find the matching transcript
— this is a precision narrowing step now, not the primary matching mechanism.
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
matching `<name>`, no runs returned for the resolved `phaseId`/`itemId` within
the pagination cap) have no exact `startedAt` to anchor on. For those, fall
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

---

## Step 4: Extract what happened

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

## Step 5: Synthesize the explanation

Produce a plain-language explanation covering:

1. **Cron name** — which cron was investigated (`deploy`, `dev-task`, etc.) — in item
   mode, list every phase that dispatched against the item
2. **Time** — when the session fired (from the resolved run's `startedAt`, or the
   JSONL mtime/first entry timestamp when using the fallback path)
3. **Session ID** — the JSONL filename (without `.jsonl`), for cross-referencing logs
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

- This skill reads only the admin API and transcript files — it does **not** require
  container stdout or any external log system beyond `logs/bodhi.log` for the preCheck
  fallback case. The Claude Code session JSONL is the authoritative record of what the
  model concluded and why; the admin API's `AgentCronRun` records are the authoritative
  record of exactly when and against what item a cron fired.
- Prefer the admin-API path (Step 1) over the fallback whenever the admin API is
  reachable and returns run records — it gives an exact `startedAt` instead of a guess,
  and item mode is only possible through it.
- A `[silent]` response is **expected behavior** when the skill found nothing to do —
  look at the bash commands to understand what it checked.
- Multiple sessions in a window: pick the one whose first entry timestamp (not mtime)
  is closest to the target time.
- JSONL entries with `type: "summary"` are condensed context records — skip them
  when extracting the narrative; they don't reflect actual model output.
