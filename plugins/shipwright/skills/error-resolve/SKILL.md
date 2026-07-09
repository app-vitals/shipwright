---
name: error-resolve
description: Read the error-patrol ledger, check each linked task's current status via the task store, and resolve the corresponding Sentry issue once its gating task has reached deployed/done. Never resolves on merged or pr_open.
---

# Error Resolve

Read `state/error-patrol-ledger.json`'s `taskLinks` entries (written by `/error-fix`), look up
each linked task's **current** status via the task store, and call Sentry's issue-resolve
endpoint for any issue whose gating task has reached `deployed` or `done`. This skill makes
**no code changes** and queues no tasks — it only reads the ledger/task store and mutates
Sentry issue state (plus the ledger entry, once the Sentry call succeeds).

This skill hardcodes Sentry as the backend (no provider abstraction) — see
`planning/error-patrol/PLAN.md` for the rationale, same as `/error-scan` and `/error-fix`.

---

## Setup: Parse Arguments

Before starting, check if any flags were passed:

- `--dry-run` — run the full check (task-store status lookups, gating decision per issue) but
  make **no Sentry mutation** and **no ledger write**. Print what would have been resolved
  instead.

---

## Step 0: Preconditions

1. Confirm `SHIPWRIGHT_TASK_STORE_URL` and `SHIPWRIGHT_TASK_STORE_TOKEN` are set in the
   environment. If either is missing, print:
   ```
   error-resolve requires SHIPWRIGHT_TASK_STORE_URL and SHIPWRIGHT_TASK_STORE_TOKEN to be set.
   Invoke /shipwright:task-store for setup instructions. Skipping resolve.
   ```
   and stop. Do not touch the ledger or Sentry.
2. Confirm `SENTRY_ORG` and `SENTRY_AUTH_TOKEN` are set (`echo "org=$SENTRY_ORG
   token_set=$([ -n "$SENTRY_AUTH_TOKEN" ] && echo yes || echo no)"`). If either is unset or
   empty, print:
   ```
   error-resolve requires SENTRY_ORG and SENTRY_AUTH_TOKEN to be set in the environment.
   Skipping resolve.
   ```
   and stop.
3. All Sentry API calls in this skill use:
   ```bash
   curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" "https://sentry.io/api/0/..."
   ```
   and the resolve call additionally sends `-X PUT -H "Content-Type: application/json" -d
   '{"status": "resolved"}'`. Never print `$SENTRY_AUTH_TOKEN`, never write it to any file,
   and never echo the literal value of `$SENTRY_ORG` into a comment or log line that could get
   pasted somewhere persistent — always reference these as their env var names in output and
   in this file.
4. All task-store calls use:
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}"
   ```
   Never print or persist `$SHIPWRIGHT_TASK_STORE_TOKEN`.

---

## Step 1: Read the Ledger

The ledger lives at `state/error-patrol-ledger.json` — **one level up from the repo checkout,
in agent workspace state, not tracked inside this repo** (same tier as
`state/entropy-patrol-last-run.json`; sibling of the repo checkouts, same path-resolution
convention as `/error-scan`'s Step 5 and `/error-fix`'s Step 9).

1. If the file does not exist, print:
   ```
   No state/error-patrol-ledger.json found. Nothing to resolve.
   ```
   and stop cleanly. This is a normal outcome (error-scan/error-fix haven't run yet, or
   nothing has ever been queued), not a fatal error.
2. If it exists, read and parse it. If it has no top-level `taskLinks` key, or `taskLinks` is
   an empty object, print:
   ```
   No taskLinks entries in the ledger. Nothing to resolve.
   ```
   and stop cleanly — also not an error.
3. Otherwise, collect every `<sentry_issue_id> -> {primary, companion}` entry from
   `taskLinks` for processing in Step 2. Recall the shape (written by `/error-fix`'s Step 9):
   ```json
   {
     "taskLinks": {
       "<sentry_issue_id>": {
         "primary": "<task id, or null if this issue only got a companion task>",
         "companion": "<task id, omitted if none was queued>"
       }
     }
   }
   ```

---

## Step 2: Determine the Gating Task Per Issue

For each `taskLinks` entry, decide which task's status actually gates resolution of that
Sentry issue. **Design decision (documented here, not just implicit in the logic):**

- If `primary` is **non-null**, the primary task is the actual fix for the issue's underlying
  bug — landing it is what makes the Sentry issue itself go away. **Gate resolution on the
  primary task's status alone.** The companion task (if present) is a separate,
  independent observability improvement at the same call site, not a fix for the reported
  error — its status **never blocks or gates** resolution, even if it's still pending or HITL
  long after the primary fix has shipped.
- If `primary` is **null** (the pure-noise case — the issue only ever got a companion task,
  no primary fix task exists), there is no other task to gate on. **Gate resolution on the
  companion task's status instead**, since it's the only task associated with that issue.

So: **gating task = `primary` if non-null, else `companion`.** If `primary` is null and
`companion` is also absent (should not normally happen given `/error-fix`'s Step 9, but treat
defensively), there is no task to check status on at all — skip that issue this run, noting
it in the summary as "no linked task to check."

---

## Step 3: Query the Task Store for Each Gating Task's Current Status

**CRITICAL (acceptance criterion 1): query the task store for the CURRENT status of every
gating task before taking any Sentry action.** The ledger itself never stores task status —
it only stores task IDs — so this is always a live lookup on this run, never a cached value.

For each issue's gating task ID from Step 2:

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{gating_task_id}"
```

- **200** — record the returned task's `status` field for use in Step 4.
- **404** — the task no longer exists (deleted, or outside this token's scope). Record this
  issue as `missing` for Step 4/the summary — **do not treat as ready to resolve.** Don't
  crash the run; continue with the next issue.
- Any other non-2xx (e.g. 401, 5xx) — record this issue as a lookup failure for the summary
  (distinct from `missing`) and continue with the next issue; do not abort the whole run over
  one failed lookup.

If the gating task's status is `cancelled`, treat it the same as `missing` for gating
purposes: **not ready to resolve.** A cancelled task means the fix was abandoned, not shipped
— resolving the Sentry issue would be wrong. Record it as `cancelled` (distinct from
`missing`) in the summary so a human can see why that issue is stuck.

---

## Step 4: Decide Readiness Per Issue

**CRITICAL (acceptance criterion 2): an issue resolves only when its gating task (Step 2) has
reached `deployed` or `done` status — never `merged`, never `pr_open`, never any other
status.**

For each issue with a successfully-looked-up gating task status (Step 3):

- Gating task status is `deployed` or `done` → **ready to resolve.**
- Gating task status is anything else (`pending`, `in_progress`, `pr_open`, `approved`,
  `merged`, `deploying`, `blocked`, or any other non-terminal/non-`deployed`/non-`done`
  value) → **not ready.** Record the blocking status for the summary (Step 8) so a human can
  see exactly what's still pending. `merged` and `pr_open` are explicitly **not** sufficient
  even though they're further along than `pending` — the task must have actually shipped
  (`deployed`) or been marked fully complete (`done`), not merely merged into the base
  branch or opened as a PR.
- Gating task was `missing` (404) or `cancelled` (Step 3) → **not ready.** Included in the
  summary under a distinct "missing/cancelled" bucket, not conflated with "not yet ready."
- Gating task lookup failed for another reason (non-404 error) → **not ready**, included
  under a distinct "lookup failed" bucket for the summary. Retry on a future run.

Issues classified as anything other than "ready to resolve" are left completely untouched
this run — no Sentry call, no ledger write for them.

---

## Step 5: Dry-Run Output (if --dry-run)

If `--dry-run` was passed, skip Step 6 (Sentry mutation) and Step 7 (ledger write) entirely.
For every issue classified as "ready to resolve" in Step 4, print what would have happened:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ERROR RESOLVE — DRY RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Would resolve {N} Sentry issues:

  <sentry_issue_id> — gating task {task_id} status={deployed|done}

Would leave {N} issues untouched (not yet ready):
  <sentry_issue_id> — gating task {task_id} status={status}

{N} issues skipped (missing/cancelled gating task):
  <sentry_issue_id> — gating task {task_id} ({missing|cancelled})

No Sentry calls made. No ledger changes.
Re-run without --dry-run to resolve.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing.

---

## Step 6: Call the Sentry Resolve Endpoint

Skip this step entirely if `--dry-run` was passed (handled in Step 5).

For each issue classified as "ready to resolve" in Step 4:

```bash
curl -sS -X PUT \
  -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "resolved"}' \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/{issue_id}/"
```

This call uses the `event:write` scope already granted on `SENTRY_AUTH_TOKEN` (same token
`/error-scan` and `/error-fix` use for read calls — no separate token needed).

Treat the call as successful only if **both**:
1. The HTTP response is 2xx, **and**
2. The response body's `status` field is `"resolved"` (parse the JSON response and check —
   don't assume success from the status code alone).

If either condition fails, treat this issue's resolve as **failed** this run:
- Do not proceed to Step 7 for this issue — its ledger entry is left completely untouched.
- Record the failure (issue ID + whatever error detail is available: HTTP status, response
  body) for the Step 8 summary.
- Continue processing the remaining ready issues — one failed resolve call does not abort the
  run.

---

## Step 7: Update the Ledger (Only After a Successful Resolve)

**CRITICAL (acceptance criterion 3): only mutate an issue's ledger entry after its Step 6
Sentry resolve call has succeeded.** Never touch the ledger for an issue before or in place of
a successful Sentry call — if the call fails or is skipped, that issue's `taskLinks` entry
(and its `issues` entry, if present) is left exactly as-is for a future run to retry.

Skip this step entirely if `--dry-run` was passed.

**Ledger mutation approach (documented decision):** for each issue that was successfully
resolved in Step 6, remove that issue's entry from the top-level `taskLinks` map entirely.
Rationale: once an issue is resolved in Sentry, there is nothing further for `error-resolve`
to track for it — `taskLinks` exists solely to let this skill find issues that still need a
resolve check, so a resolved issue's entry is stale weight, not useful history. (This mirrors
`/error-scan`'s own `issues` map, which separately already tracks a `"status": "resolved"`
transition for the general issue history — this skill does not duplicate that; it only owns
`taskLinks`.) If the issue also has an entry under the ledger's top-level `issues` map (owned
by `/error-scan`), leave that alone — this skill never touches `issues`, `lastRun`, or
`serviceRepoMap`.

This is a **partial merge, not a full overwrite** — same discipline as `/error-fix`'s Step 9:

1. Read the current on-disk ledger fresh (in case it changed since Step 1, e.g. a concurrent
   `/error-fix` run added new links).
2. Remove only the specific `taskLinks` keys for issues resolved in Step 6 this run.
3. Leave every other top-level key (`lastRun`, `issues`, `serviceRepoMap`) and every other
   `taskLinks` entry that wasn't resolved this run completely untouched.
4. Write the updated ledger back to `state/error-patrol-ledger.json`.
5. Print: `Ledger updated: state/error-patrol-ledger.json (taskLinks entries cleared for
   resolved issues)`

If the ledger write itself fails (e.g. disk error), log the failure. The Sentry issue is
already resolved at this point (Step 6 succeeded before this step ran) — do not attempt to
"unresolve" it to compensate. A missed `taskLinks` cleanup just means this issue's now-stale
entry gets re-checked (and found already resolved, or simply produces a redundant no-op
resolve call) on a future run; note this in the summary as a ledger-write failure distinct
from a Sentry-call failure.

---

## Step 8: Print Summary

Whether or not `--dry-run` was passed, always print a summary to stdout after the run
(dry-run uses Step 5's format instead of this one):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ERROR RESOLVE COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Ledger entries checked:   {N}

  RESOLVED         {N} issues
  NOT YET READY    {N} issues
  MISSING/CANCELLED gating task: {N} issues
  LOOKUP FAILED     {N} issues (task-store error, retry next run)
  SENTRY CALL FAILED {N} issues (retry next run)

{If any resolved:}
Resolved:
  <sentry_issue_id> — gating task {task_id} reached {deployed|done}

{If any not yet ready:}
Not yet ready:
  <sentry_issue_id> — gating task {task_id} still {status}

{If any missing/cancelled:}
Missing/cancelled gating task (not resolved):
  <sentry_issue_id> — gating task {task_id} ({missing|cancelled})

{If any lookup failures:}
Task-store lookup failed (retry next run):
  <sentry_issue_id> — gating task {task_id}: {error detail}

{If any Sentry call failures:}
Sentry resolve call failed (ledger untouched, retry next run):
  <sentry_issue_id> — {HTTP status / error detail}

{If --dry-run: "Dry run — no Sentry calls made, no ledger changes."}
{Else: "Ledger updated: state/error-patrol-ledger.json"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing — this is the sole final output.

---

## Error Handling

- **Missing `SHIPWRIGHT_TASK_STORE_URL`/`SHIPWRIGHT_TASK_STORE_TOKEN` or `SENTRY_ORG`/
  `SENTRY_AUTH_TOKEN`**: handled in Step 0 — print the message and stop without touching
  anything.
- **Ledger missing, or missing/empty `taskLinks`**: handled in Step 1 — print a clean
  "nothing to resolve" message and stop. Not a fatal error.
- **Gating task 404 or `cancelled`**: handled in Step 3/4 — not ready to resolve, recorded
  distinctly in the summary, run continues with remaining issues.
- **Task-store lookup fails for another reason (401, 5xx)**: handled in Step 3 — recorded as
  a distinct lookup failure, run continues; retry on a future run.
- **Sentry resolve call fails (non-2xx or response `status` isn't `"resolved"`)**: handled in
  Step 6 — that issue's ledger entry is left completely untouched, the failure is recorded in
  the summary, and the run continues with remaining ready issues.
- **Ledger write fails after a successful Sentry resolve**: handled in Step 7 — log the
  failure, do not attempt to reverse the Sentry resolve; note it in the summary as a
  ledger-write failure.

---

## Constraints (Do Not Violate)

- **Always a live task-store lookup.** Every gating task's status is queried fresh via `GET
  /tasks/:id` on this run (Step 3) before any Sentry action is taken. The ledger never stores
  task status and is never trusted as a status cache.
- **Only `deployed`/`done` gates resolution.** `merged` and `pr_open` — and every other
  status — are explicitly insufficient. Never call the Sentry resolve endpoint for an issue
  whose gating task hasn't reached `deployed` or `done`.
- **Primary gates over companion.** When an issue has both a `primary` and a `companion`
  task, only the `primary` task's status gates resolution — the companion is a separate
  observability improvement, not the fix, and its status never blocks or unblocks resolution.
  Only when `primary` is `null` (pure-noise, companion-only case) does the companion's status
  become the gate.
- **Never mutate the ledger before the Sentry call succeeds.** An issue's `taskLinks` entry is
  only touched (removed) after its Step 6 resolve call has returned success (2xx **and**
  response `status: "resolved"`). A failed or skipped Sentry call always leaves that issue's
  ledger entry untouched for a future retry.
- **Ledger update is a partial merge.** Only the resolved issues' `taskLinks` entries are
  removed. `lastRun`, `issues`, `serviceRepoMap`, and every other `taskLinks` entry are read
  fresh and written back untouched.
- **Never log or persist `$SENTRY_AUTH_TOKEN` or `$SHIPWRIGHT_TASK_STORE_TOKEN`.** Not in the
  ledger, not in stdout output, not in any file.
- **No hardcoded org, service, or repo names.** `$SENTRY_ORG` is read from the environment at
  runtime and never written literally into this file or into any output.
- **No code changes, no task queueing.** This skill only reads the ledger/task store and
  mutates Sentry issue state (plus the ledger, post-success). It never opens a PR, never
  writes to the task store, and never queues new tasks — that's `/error-fix`'s job.
- **`--dry-run` mutates nothing.** No Sentry PUT call, no ledger write. Everything that would
  happen is printed to stdout instead.
- **One failure doesn't abort the run.** A 404/cancelled gating task, a task-store lookup
  error, or a failed Sentry call for one issue is recorded in the summary and the run
  continues processing the remaining issues.
