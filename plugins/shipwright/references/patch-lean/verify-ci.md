# patch-lean: verify CI after patch (Step 6.5) and report (Step 7)

Lanes 4, 5 and 6 each push independently, and a conflict resolution or review-finding fix can leave
CI red in a way no lane re-checks (lane 6 only fires when List D flagged the PR *before* this cycle's
pushes). Before reporting success, verify the PR's current head SHA is green.

## Gate: only if something was pushed

If no lane reached its upsert with a changed head SHA this run, the CI state is what Step 3c already
evaluated. Print and go to Step 7:

```
⏭ No commit pushed this cycle — skipping CI verification.
```

## Step 6.5a: poll for the final CI result

Same "poll the Actions API, dedupe by latest run per workflow, skip cleanly when nothing is
configured" pattern as `references/dev-task/push-and-ci.md`'s CI gate, with a tighter cap: every 30
seconds, up to 10 times (~5 minutes). The lane worktrees are already removed, so re-fetch live:

```bash
REPO="{org}/{repo}"
HEAD_SHA=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```

On **each** iteration renew the heartbeat, then fetch runs:

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"

RUNS_JSON=$(gh api "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=20" \
  --jq '[.workflow_runs[] | {id, name, workflow_id, run_number, status, conclusion}]')
```

Filter to `head_sha == HEAD_SHA`; keep polling while any run is `queued`, `in_progress`, or `waiting`.
Deduplication (latest run per `workflow_id`) is handled inside the shared classifier (CIG-1.1).

- **No CI configured** (no matching runs after 60 s / 2 polls): print
  `⏭ No CI checks configured — skipping CI verification gate` and go to Step 7.
- **Classify**:
  ```bash
  ALL_GREEN=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/is-ci-green.ts" "$RUNS_JSON")
  ```
  `success`, `skipped` and `neutral` count as green. `"true"` → print `✓ CI checks passed after patch`
  and go to Step 7.
- **Window exhausted with anything still failing or pending** → still-red; Step 6.5b.

## Step 6.5b: one bonus CI-fix subagent on still-red

Collect fresh logs the Step 6b way:

```bash
RUN_ID=$(gh run list --branch {branch} --repo {org}/{repo} \
  --json databaseId,conclusion \
  --jq '[.[] | select(.conclusion == "failure")] | first | .databaseId')

gh run view "$RUN_ID" --log --failed --repo {org}/{repo} 2>&1 | tail -200
```

Re-set up the worktree ([lane-shared.md](lane-shared.md) section 1), then dispatch **exactly one** bonus
CI-fix subagent with the Step 6c template from [lane-ci.md](lane-ci.md), substituting these logs for
`CI FAILURE OUTPUT`; `model: PATCH_MODEL`, `run_in_background: false`. Do not re-poll or retry after it
reports back, whatever the outcome — a single bonus attempt, not a new fix loop.

- **DONE / DONE_WITH_CONCERNS with a push**: log the fix, clean up the worktree, go to Step 7.
- **BLOCKED**: reuse Step 6d's escalation exactly (same `status: 'blocked'` PATCH to the linked task,
  or the PR record when none is linked; same comment convention; same claim release). Log the blocker
  and go to Step 7.

## Step 7: report template

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PATCH COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REVIEW FINDINGS ({A} PR(s)):
{for each PR in List A:
  "#{pr} — {title} ({org}/{repo})
   {if DONE or DONE_WITH_CONCERNS with push: "✓ Fixed and pushed"}
   {if BLOCKED: "✗ Blocked: {blocker summary}"}
   {if DONE_WITH_CONCERNS: "⚠ Concerns: {concern summary}"}
   Findings addressed:
   {bullet list from subagent FINDINGS_ADDRESSED}"}

MERGE CONFLICTS ({C} PR(s)):
{for each PR in List C:
  "#{pr} — {title} ({org}/{repo})
   {if DONE or DONE_WITH_CONCERNS with push: "✓ Conflicts resolved and pushed"}
   {if BLOCKED: "✗ Blocked: {blocker summary}"}
   {if DONE_WITH_CONCERNS: "⚠ Concerns: {concern summary}"}
   Conflicts resolved:
   {bullet list from subagent CONFLICTS_RESOLVED}"}

FAILING CI ({D} PR(s)):
{for each PR in List D:
  "#{pr} — {title} ({org}/{repo})
   {if DONE or DONE_WITH_CONCERNS with push: "✓ Fixed and pushed"}
   {if BLOCKED: "✗ Blocked: {blocker summary}"}
   {if DONE_WITH_CONCERNS: "⚠ Concerns: {concern summary}"}
   Failures fixed:
   {bullet list from subagent FAILURES_FIXED}"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Also state any settle-with-rejected refs (5c.5) and out-of-scope `ci:` refs (6b.9) under the
corresponding list.
