---
description: Simple loop orchestrator — delegates to /shipwright:patch and /shipwright:review as clean sub-agents
---

# Review Patch

Loop orchestrator that delegates to `/shipwright:patch` and `/shipwright:review` as
isolated sub-agents. Uses `check-patch` and `check-review` precheck scripts to decide
when to spawn each. Loops until both prechecks return exit 1 or a 25-minute budget
is exhausted. Goes `[silent]` when neither precheck triggers on the first pass.

**This command runs autonomously. Do not pause for user input.**

---

## Step 1: Record Start Time

Record the start time for budget tracking:

```bash
START_TIME=$(date +%s)
```

Store `START_TIME` — it is used in every subsequent iteration to check elapsed time.

---

## Step 2: Initial Precheck Pass

Resolve the plugin scripts directory from the cache:

```bash
CHECK_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "check-patch.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
```

Run both prechecks to determine if there is anything to do:

```bash
bun "$CHECK_SCRIPTS/check-patch.ts"
PATCH_EXIT=$?

bun "$CHECK_SCRIPTS/check-review.ts"
REVIEW_EXIT=$?
```

If **both** prechecks return exit 1 (i.e. `PATCH_EXIT=1` AND `REVIEW_EXIT=1`):

```
Nothing to do — check-patch and check-review both returned exit 1.
```

Append `[silent]` and stop.

---

## Step 3: Loop Until Done or Timeout

Loop, repeating the following block until the exit condition is met:

### Step 3a: Check Elapsed Time

```bash
NOW=$(date +%s)
ELAPSED=$(( NOW - START_TIME ))
```

If `ELAPSED` is greater than 1500 (25 minutes in seconds), print a timeout notice and stop:

```
Review-patch timeout: 25-minute budget exceeded after {ELAPSED}s. Stopping loop.
Patch sub-agent ran: {N} time(s). Review sub-agent ran: {M} time(s).
```

### Step 3b: Run check-patch — spawn /shipwright:patch if triggered

Run the precheck:

```bash
bun "$CHECK_SCRIPTS/check-patch.ts"
```

If this exits 0, spawn `/shipwright:patch` as a sub-agent via the Agent tool:

```
Spawn sub-agent: /shipwright:patch
```

Use the Agent tool to dispatch `shipwright:patch` as a fresh sub-agent session. Pass no
additional arguments — the patch skill discovers its own inputs from GitHub.

### Step 3c: Run check-review — spawn /shipwright:review if triggered

Run the precheck:

```bash
bun "$CHECK_SCRIPTS/check-review.ts"
```

If this exits 0, spawn `/shipwright:review` as a sub-agent via the Agent tool:

```
Spawn sub-agent: /shipwright:review
```

Use the Agent tool to dispatch `shipwright:review` as a fresh sub-agent session. Pass no
additional arguments — the review skill discovers its own inputs from GitHub.

### Step 3d: Re-run both prechecks — break if done

Re-run both prechecks:

```bash
bun "$CHECK_SCRIPTS/check-patch.ts"
PATCH_EXIT=$?

bun "$CHECK_SCRIPTS/check-review.ts"
REVIEW_EXIT=$?
```

If **both** return exit 1 (`PATCH_EXIT=1` AND `REVIEW_EXIT=1`):

```
Both prechecks returned exit 1 — nothing left to do. Breaking loop.
```

Break the loop and proceed to Step 4.

Otherwise, continue the loop from Step 3a.

---

## Step 4: Summary

Print a summary of what was done:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REVIEW PATCH COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Patch sub-agent ran:  {N} time(s)
Review sub-agent ran: {M} time(s)
Elapsed:              {ELAPSED}s
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Migration Notes

**Backward compatibility**: The cron invocation format is unchanged — `/shipwright:review-patch` works the same as before. No cron prompt updates are needed.

**Scope expansion**: The new orchestrator delegates to `/shipwright:patch` (Lists B/C/D — BEHIND branches, merge conflicts, failing CI) and `/shipwright:review`, expanding scope beyond the old List A–only behavior. A single review-patch cron now covers all PR health checks.

**Cron overlap**: Agents running all three crons (review, patch, review-patch) on separate schedules risk concurrent sessions working the same PRs. Recommended configuration: use review-patch as the sole cron (replacing separate review and patch crons), since it now subsumes both. If all three must run, ensure non-overlapping schedules.
