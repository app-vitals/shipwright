---
name: investigate-cron
description: >
  Diagnose why a cron run behaved unexpectedly — finds the Claude Code session
  transcript by cron name and approximate time, reads what the model did and why,
  and explains it in plain language. No log files needed; the transcript is the
  source of truth.
---

# investigate-cron

Diagnose a cron run by name and approximate execution time.

**Usage:** `/shipwright:investigate-cron <name> <time>`

- `<name>` — cron name: `deploy`, `review-patch`, `dev-task`, `patch`, `review`
- `<time>` — approximate time the cron fired, e.g. `6pm`, `14:30`, `2:30pm PST`
  Timezone defaults to Pacific if not specified.

**Example:** `/shipwright:investigate-cron deploy 6pm`

---

## Step 0: Bind invocation arguments

Before running any steps, extract the `<name>` and `<time>` arguments the user
provided and bind them to shell variables. Everything else depends on these.

```bash
# Set these from the user's invocation:
#   /shipwright:investigate-cron <name> <time>
CRON_NAME="<the <name> argument the user provided, e.g. deploy>"
TIME_ARG="<the <time> argument the user provided, e.g. 6pm>"
```

For example, if the user ran `/shipwright:investigate-cron deploy 6pm`, then:
```bash
CRON_NAME="deploy"
TIME_ARG="6pm"
```

Do not proceed to Step 1 until both variables are set.

---

## Step 1: Resolve the transcript directory

Derive the transcript directory from the current working directory (CWD).

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

---

## Step 2: Convert the time argument

Parse the `<time>` argument to a Unix epoch in the **Pacific timezone** (default).

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

Search JSONL files in the transcript directory. Use `mtime` as a fast pre-filter:
files modified within ±90 minutes of the target time are candidates.

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

1. **Cron name** — which cron was investigated (`deploy`, `review-patch`, etc.)
2. **Time** — when the session fired (from the JSONL mtime or first entry timestamp)
3. **Session ID** — the JSONL filename (without `.jsonl`), for cross-referencing logs
4. **What it did** — summarize the bash commands and assistant reasoning in 2–5 sentences
5. **Conclusion** — what the cron decided and why (approved, skipped, silenced, errored)
6. **Why (if unexpected)** — if the behavior was surprising, explain the root cause

**Output format:**

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

---

## No match / preCheck skipped

If no matching session is found in the ±90 minute window:

```
No session found for cron "<name>" around <time> Pacific.

Possible reasons:
1. The preCheck script returned non-zero — the cron was suppressed before Claude ran.
   Check logs/bodhi.log for "[preCheck]" lines around <time>.
2. The cron was disabled at the time. Verify via:
      curl -s -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
        "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" | jq '.[] | select(.name | test("<name>"))'
3. The cron fired in a different workspace — check if $AGENT_HOME differs.
4. The ±90 minute search window was too narrow. Try a broader time range.
```

For case 1, grep bodhi.log:
```bash
grep -i "precheck\|pre-check\|cron" logs/bodhi.log | tail -50
```

---

## Notes

- This skill reads only transcript files — it does **not** require container stdout,
  `bodhi.log`, or any external log system. The Claude Code session JSONL is the
  authoritative record of what the model concluded and why.
- A `[silent]` response is **expected behavior** when the skill found nothing to do —
  look at the bash commands to understand what it checked.
- Multiple sessions in the window: pick the one whose first entry timestamp (not mtime)
  is closest to the target time.
- JSONL entries with `type: "summary"` are condensed context records — skip them
  when extracting the narrative; they don't reflect actual model output.
