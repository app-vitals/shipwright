---
description: Merge and deploy a PR through the Deploy → Canary → Promote pipeline
argument-hint: "[org/repo#number | number]"
---

# Deploy

Merge a PR and drive it through the Deploy → Canary → Promote pipeline. Monitors each
stage, detects ARC desync, opens a revert PR on canary failure, and updates todos and
metrics on success.

**This command runs autonomously. Do not pause for user input unless pre-flight fails.**

---

## Arguments

Parse `$ARGUMENTS` to extract `org`, `repo`, and `pr` number:
- `org/repo#number` (e.g. `app-vitals/shipwright#123`): explicit
- `number` or `#number`: infer org/repo from the task store (`curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks/repo" | jq -r '.repo // empty'`),
  defaulting to `app-vitals/shipwright`
- _(no arguments)_: scan mode — find the next ready PR to deploy (see Step 1)

---

## Step 1: Scan Mode (no arguments)

When invoked with no arguments, find the next PR ready to deploy autonomously.

### 1a. Find Qualifying PRs

Get the current agent's own GH login and read `allow_self_review` from
`state/agent-policy.md` (default: true):

```bash
AGENT_LOGIN=$(gh api user --jq '.login')
```

Resolve the configured repos:
```bash
REPOS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks/repo" | jq -r '.repo // empty')
```

For each configured repo, fetch all open PRs authored by `AGENT_LOGIN`:
```bash
gh pr list --state open --repo {org}/{repo} --author "$AGENT_LOGIN" \
  --json number,headRefOid,author,reviewDecision
```

For each PR, check in order:

1. **Approval** — if `reviewDecision == "APPROVED"`: approved. Otherwise, if
   `allow_self_review` is true: fetch the PR's reviews and check if any review authored
   by `AGENT_LOGIN` has a body where `trimStart().startsWith("APPROVE")`:
   ```bash
   gh pr view {pr} --repo {org}/{repo} --json reviews \
     --jq '[.reviews[] | select(.author.login == "'$AGENT_LOGIN'") | .body] | any(startswith("APPROVE"))'
   ```
   Skip if neither source shows approval.

2. **CI green** — fetch CI runs for the PR's head commit:
   ```bash
   gh api "repos/{org}/{repo}/actions/runs?head_sha={headRefOid}&per_page=20" \
     --jq '[.workflow_runs[] | select(.name == "CI") | {status, conclusion}]'
   ```
   Skip if no CI run has `status == "completed"` and `conclusion == "success"`.

Pick the **first** PR that passes all checks. If none qualifies, respond `[silent]`
and stop — no output.

Once a qualifying PR is found, proceed to Step 2 with that PR number and repo as the target.

---

## Step 2: Resolve Target PR

If arriving from scan mode (Step 1a): use the `org`, `repo`, and `pr` already resolved
there — skip argument parsing entirely.

If invoked with explicit arguments: parse `$ARGUMENTS` using the rules in the Arguments
section above to extract `org`, `repo`, and `pr`.

Look up the task via the task store:

```bash
TASK_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks?pr={pr}" | jq .)
TASK_ID=$(echo "$TASK_JSON" | jq -r '.tasks[0].id // empty')
TASK_TITLE=$(echo "$TASK_JSON" | jq -r '.tasks[0].title // empty')
TASK_STATUS=$(echo "$TASK_JSON" | jq -r '.tasks[0].status // empty')
```

If `TASK_ID` is empty or `TASK_STATUS` is not `"pr_open"`, proceed in **deploy-only mode** — no
todos update will be performed.

### 2a. Own-PRs-Only Check

Get the current agent's own GH login and verify the PR was authored by the agent:

```bash
AGENT_LOGIN=$(gh api user --jq '.login')
PR_AUTHOR=$(gh pr view {pr} --repo {org}/{repo} --json author --jq '.author.login')
```

If `PR_AUTHOR != AGENT_LOGIN`, this PR was not authored by the current agent — skip it silently and stop. Only PRs we authored go through this deploy pipeline.

Print:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEPLOY: PR #{pr}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Repo:   {org}/{repo}
Task:   {task_id} — {task_title}  (or "standalone deploy" if no task found)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 2b. Bundle Completeness Gate

Before running pre-flight checks, verify that all tasks on this branch are `pr_open` or
beyond (i.e., no bundle-mates are still in flight). This prevents deploying a PR while
sibling tasks on the same branch are still being developed or are blocked.

```bash
HEAD_BRANCH=$(gh pr view {pr} --repo {org}/{repo} --json headRefName --jq '.headRefName')
BRANCH_TASKS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks?branch=$HEAD_BRANCH" 2>/dev/null || echo '{"tasks":[],"total":0,"limit":50,"offset":0}')
INCOMPLETE_TASKS=$(echo "$BRANCH_TASKS" | jq '[.tasks[] | select(.status == "pending" or .status == "in_progress" or .status == "blocked") | {id, status}]')
INCOMPLETE=$(echo "$INCOMPLETE_TASKS" | jq 'length')
```

If `INCOMPLETE > 0`: print and stop [silent]:
```
⏸ Bundle gate: {INCOMPLETE} task(s) on branch {HEAD_BRANCH} are still in flight:
  {for each item in INCOMPLETE_TASKS: "  - {id} ({status})"}
  Waiting for bundle-mates to reach pr_open before deploying.
```

If `INCOMPLETE == 0` (no tasks tracked, or all tasks are `pr_open` or beyond): proceed to Step 3.

---

## Step 3: Pre-flight Checks (GitHub API — no local state)

All pre-flight checks query GitHub directly. No worktree or local clone is needed.

### 3a. Verify PR Approval

Check the PR's review status from GitHub:

```bash
gh pr view {pr} --repo {org}/{repo} --json reviewDecision,reviews \
  --jq '{decision: .reviewDecision, approvals: [.reviews[] | select(.state == "APPROVED") | .author.login]}'
```

**If `reviewDecision` is `"APPROVED"`**: Record `approval_source = "github"` and `approvers = [list]`. Proceed to Step 3b.

**If `reviewDecision` is not `"APPROVED"`**: Read `allow_self_review` from
`state/agent-policy.md` (default: true). If `allow_self_review` is true AND the PR is
authored by the current agent (`PR_AUTHOR == AGENT_LOGIN` from Step 2a), fetch the PR's
reviews from GitHub and check if any review from `AGENT_LOGIN` has a body where
`trimStart().startsWith("APPROVE")`:

```bash
gh pr view {pr} --repo {org}/{repo} --json reviews \
  --jq '[.reviews[] | select(.author.login == "'$AGENT_LOGIN'") | .body]'
```

If a matching review is found: Record `approval_source = "self_review"` and proceed to Step 3b.
Print:
```
ℹ No GitHub approval (solo-authored PR). Proceeding on self-posted APPROVE review.
```

If no matching review is found (or `allow_self_review` is false), print and stop:
```
✗ Pre-flight failed: PR #{pr} is not approved.
  GitHub reviewDecision: {decision}
  No APPROVE review found on GitHub for this PR.
  Options:
    1. Have a human approve the PR on GitHub, or
    2. Run /shipwright:review on the PR — once an APPROVE review is posted, re-run /shipwright:deploy.
```

### 3b. Verify CI is Green

Fetch the most recent CI runs on the PR's head commit:

```bash
HEAD_SHA=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid --jq '.headRefOid')
REPO="{org}/{repo}"
gh api "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=20" \
  --jq '[.workflow_runs[] | select(.name == "CI") | {status, conclusion}]'
```

If no CI run has `conclusion == "success"` (or no CI run exists at all), print and stop:
```
✗ Pre-flight failed: CI is not green on PR #{pr} head ({HEAD_SHA[0..7]}).
  Resolve CI failures before deploying.
```

### 3c. Pre-flight Summary

If both checks pass:
```
✓ Pre-flight passed
  Approval:    {if approval_source == "github": "GitHub — approved by: {approvers}" | if approval_source == "self_review": "Self-review — APPROVE found in GitHub review body"}
  CI:          green ({HEAD_SHA[0..7]})
```

---

## Step 4: Merge

Record `deploy_started_at` as the current ISO timestamp. This is used for pipeline
timing in Step 8.

Squash merge the PR. The merge command depends on the approval source from Step 3a:

- **GitHub approval** (`approval_source == "github"`): queue via auto-merge (waits for branch protection to clear):
  ```bash
  gh pr merge {pr} --repo {org}/{repo} --squash --auto
  ```

- **Self-review** (`approval_source == "self_review"`): merge immediately with `--admin` to bypass the "require approval" branch protection rule (GitHub cannot approve a PR authored by the same user — CI green is already verified in Step 3b, so safety properties are preserved):
  ```bash
  gh pr merge {pr} --repo {org}/{repo} --squash --admin
  ```

Poll for the merge to complete — check `gh pr view {pr} --json state --jq '.state'` every
5 seconds, up to 60 seconds. When the state becomes `"MERGED"`, capture the squash SHA:

```bash
SQUASH_SHA=$(gh api "repos/{org}/{repo}/git/refs/heads/main" --jq '.object.sha')
```

If the state has not become `"MERGED"` after 60 seconds, print and stop:
```
✗ Merge did not complete within 60 seconds (last state: {state}).
  Check the PR on GitHub — it may require a human to resolve a merge conflict or branch protection issue.
```

Print:
```
✓ Merged PR #{pr} → main
  Squash SHA: {SQUASH_SHA[0..7]}
```

Mark the task merged via the task store — skip if in deploy-only mode:

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d "{\"status\": \"merged\", \"mergedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | jq .
```

### Upsert PullRequest record

Upsert a PullRequest record to mark this PR as merged. First, claim or create the record:

```bash
PR_RECORD=$(curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"$SQUASH_SHA\"}" 2>&1)
PR_RECORD_ID=$(echo "$PR_RECORD" | jq -r '.id // empty')
```

If `PR_RECORD_ID` is non-empty, update the record to mark it as merged:

```bash
[ -n "$PR_RECORD_ID" ] && curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID" \
  -d "{\"state\": \"merged\", \"mergedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"reviewState\": \"approved\"}" 2>/dev/null
```

If the claim or patch call fails (or `PR_RECORD_ID` is empty), print a warning and continue:

```bash
if [ -z "$PR_RECORD_ID" ]; then
  echo "⚠ Failed to upsert PullRequest record — continuing"
fi
```

---

## Step 5: Poll Deploy → Canary → Promote

### 5a. No-Pipeline Detection

Before starting the full 30-minute pipeline watch, poll for a Deploy workflow run matching `SQUASH_SHA` for up to **5 minutes** (poll every 30 seconds, up to 10 polls):

```bash
REPO="{org}/{repo}"
gh api "repos/$REPO/actions/runs?per_page=50" \
  --jq "[.workflow_runs[] | select(.head_sha == \"$SQUASH_SHA\" and .name == \"Deploy\") | {id, name, status, conclusion}]"
```

- **Deploy workflow appears**: Break the 5-minute poll early and proceed to the main pipeline watch (Step 5b).
- **No Deploy workflow after 5 minutes**: The repo has no deploy pipeline. Print:
  ```
  ⏭  No Deploy workflow triggered — watching post-merge CI runs on {SQUASH_SHA[0..7]}
  ```
  Then proceed to Step 5c to watch post-merge CI and build runs before marking the task deployed.

### 5c. Post-Merge CI Watch (no Deploy pipeline)

Poll for CI and build runs on `SQUASH_SHA` for up to **10 minutes** (poll every 30 seconds, up to 20 polls):

```bash
REPO="{org}/{repo}"
gh api "repos/$REPO/actions/runs?per_page=50" \
  --jq "[.workflow_runs[] | select(.head_sha == \"$SQUASH_SHA\") | {id, name, status, conclusion}]"
```

Print progress on each poll:
```
[{elapsed}m] {name}: {status}/{conclusion} | {name}: {status}/{conclusion} | ...
```

Use `-` for runs not yet seen.

**Terminal conditions:**

**All runs completed successfully** (at least one run must be seen, AND `conclusion == "success"` for every run seen):
```
✓ Post-merge CI passed ({elapsed}m)
  {name}: success
  {name}: success
  ...
```
Compute `pipeline_minutes = elapsed`. Update the task store — skip if deploy-only mode:
```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d "{\"status\": \"deployed\", \"deployedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | jq .
```
Fire `shipwright_task_deployed` — skip if deploy-only mode:
```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && [ -n "$TASK_ID" ] && python3 "$POSTHOG_SCRIPT" shipwright_task_deployed \
  --project {repo} --task "$TASK_ID" \
  canary_result=no_pipeline pipeline_minutes={pipeline_minutes}
```
Print the handoff block (Step 9) with `Pipeline: post-merge CI ({pipeline_minutes}m)`. Stop.

**Any run fails** (`conclusion == "failure"` on any run):
```
✗ Post-merge CI failed — {name}
  Logs: gh run view {id} --log --failed
```
Update via task store — skip if deploy-only mode:
```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d "{\"status\": \"blocked\", \"note\": \"Post-merge CI failed — run ID: {id}\"}" | jq .
```
Stop.

**Budget exhausted (10 minutes)** with runs still pending:
```
⚠ Post-merge CI still pending after 10 minutes — marking deployed.
  Check manually: gh api repos/{org}/{repo}/actions/runs?head_sha={SQUASH_SHA}
```
Update the task store to `status=deployed` — skip if deploy-only mode:
```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d "{\"status\": \"deployed\", \"deployedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | jq .
```
Fire `shipwright_task_deployed` — skip if deploy-only mode:
```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && [ -n "$TASK_ID" ] && python3 "$POSTHOG_SCRIPT" shipwright_task_deployed \
  --project {repo} --task "$TASK_ID" \
  canary_result=no_pipeline pipeline_minutes=10
```
Print the handoff block (Step 9) with `Pipeline: post-merge CI (pending at timeout)`. Stop.

---

### 5b. Monitor Pipeline (Deploy → Canary → Promote)

Monitor the three-stage pipeline via GitHub Actions. `SQUASH_SHA` is the source of
truth — only watch runs whose `head_sha` matches this value.

**Budget: 30 minutes from merge. Poll interval: 60 seconds.**

Each poll fetches all runs matching the squash SHA:

```bash
REPO="{org}/{repo}"
gh api "repos/$REPO/actions/runs?per_page=50" \
  --jq "[.workflow_runs[] | select(.head_sha == \"$SQUASH_SHA\") | {id, name, status, conclusion, created_at}]"
```

Track three stages by workflow name (`.name`):

| Workflow Name    | Stage   |
|------------------|---------|
| `"Deploy"`       | Deploy  |
| `"Canary"`       | Canary  |
| `"Promote to Prod"` | Promote |

Print progress on each poll:
```
[{elapsed}m] Deploy: {status}/{conclusion} | Canary: {status}/{conclusion} | Promote: {status}/{conclusion}
```

Use `-` for stages not yet seen (no run exists yet).

### ARC Desync Detection

If the Deploy stage (or any stage) has `status: "queued"` for 15 or more minutes with no
`in_progress` runs visible:

```
⚠ ARC desync suspected — Deploy has been queued {N} minutes with no runner.

  Fix:
    kubectl delete pod -n arc-systems $(kubectl get pods -n arc-systems --no-headers | grep listener | awk '{print $1}')

  The listener pod restarts in ~30s and picks up queued jobs.
  Continuing to poll — run the fix if the queue does not clear in 2 minutes.
```

Re-surface this message every 5 minutes while the queue remains stuck.

### Terminal Conditions

**Deploy stage failed** (`conclusion == "failure"` on the Deploy run):
```
✗ Deploy stage failed — nothing reached prod.
  Run ID: {id}
  Collect logs: gh run view {id} --log --failed
```
Update via task store — skip if deploy-only mode:
```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d "{\"status\": \"blocked\", \"note\": \"Deploy stage failed — run ID: {id}\"}" | jq .
```
Stop.

**Canary failed** (`conclusion == "failure"` on the Canary run):
Go to Step 6.

**Canary passed but Promote skipped** (Promote run absent or `conclusion == "skipped"` after Canary success):
```
⚠ Canary passed but Promote was skipped.
  This is a canary-blocked state — the promote workflow's `if` guard did not fire.
  Check: gh api repos/{org}/{repo}/actions/runs?per_page=10 --jq '.workflow_runs[] | select(.name == "Promote to Prod")'
  Likely cause: Promote workflow's `workflow_run.conclusion` did not match `success`.
```
Update via task store — skip if deploy-only mode:
```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d '{"status": "blocked", "note": "canary_blocked: Promote skipped after canary success"}' | jq .
```
Stop.

**Promote succeeded** (`conclusion == "success"` on the Promote run):
Go to Step 7.

**Budget exhausted (30 minutes)**:
```
✗ Pipeline timeout after 30 minutes.
  Last known state:
    Deploy:  {status}/{conclusion}
    Canary:  {status}/{conclusion}
    Promote: {status}/{conclusion}
```
Update via task store — skip if deploy-only mode:
```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d '{"status": "blocked", "note": "Pipeline timeout after 30 minutes"}' | jq .
```
Stop.

---

## Step 6: Canary Failure — Open Revert PR

If Canary fails, the code is already in prod (the Deploy stage ran successfully). Open a
revert PR automatically. Do NOT auto-merge it — a human must review and merge the revert.

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} fetch origin
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-revert-{task_id_or_pr} origin/main -b revert/canary-{task_id_or_pr}
git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-revert-{task_id_or_pr} revert {SQUASH_SHA} --no-edit
git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-revert-{task_id_or_pr} push origin revert/canary-{task_id_or_pr}
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-revert-{task_id_or_pr}
```

Write the PR body to a temp file:
```
Reverts {SQUASH_SHA[0..7]} after canary failure.

## Context
PR #{pr} was merged to main and deployed to GKE. The canary suite failed
after deployment. This revert restores the previous state.

**Canary run:** {canary_run_url}

## Action Required
Review this revert and merge manually. The revert is NOT auto-merged — a human
must confirm before it lands.

Generated with [Claude Code](https://claude.com/claude-code)
```

```bash
gh pr create \
  --repo {org}/{repo} \
  --title "revert: canary failure — PR #{pr}" \
  --body-file /tmp/shipwright-revert-{pr}.txt \
  --base main
rm /tmp/shipwright-revert-{pr}.txt
```

Print:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CANARY FAILED — REVERT PR OPENED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Canary suite failed after deploy. A revert PR has been opened:
{revert_pr_url}

The revert is NOT auto-merged. Review and merge manually to restore prod.

Canary logs: gh run view {canary_run_id} --log --failed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Update via task store — skip if deploy-only mode:

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d "{\"status\": \"blocked\", \"blockedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"note\": \"Canary failed after deploy. Revert PR opened: {revert_pr_url}\"}" | jq .
```

Fire `shipwright_task_blocked` — only if a task was found (skip in deploy-only mode):
```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && [ -n "{task_id}" ] && python3 "$POSTHOG_SCRIPT" shipwright_task_blocked \
  --project {repo} --task {task_id} reason="canary_failure"
```

Stop.

---

## Step 7: Promote Success — Health Probe

After Promote succeeds, probe the health endpoint:
```bash
curl -sf https://<your-service-host>/health
```

**If health check passes (HTTP 200):**
```
✓ Health check passed — https://<your-service-host>/health
```

**If health check returns 503 or fails:**
```
⚠ Health check returned {status}. The service may be unhealthy.

  Cloud Logging query (replace PROJECT_ID with your GCP project):
    gcloud logging read \
      'resource.type="k8s_container" AND resource.labels.namespace_name="<your-namespace>" AND resource.labels.container_name="api" AND severity>=ERROR' \
      --project=<your-gcp-project> \
      --freshness=10m \
      --format="table(timestamp,textPayload)"

  The deploy is recorded as successful — investigate manually.
```

Continue regardless of health check result — it is informational, not a gate.

---

## Step 8: Update Todos + Metrics + Fire PostHog

### 8a. Compute Pipeline Duration

```
pipeline_minutes = floor((now - deploy_started_at) / 60)
```

### 8b. Update task store

Skip if no task was found (deploy-only mode):

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d "{\"status\": \"deployed\", \"deployedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | jq .
```

### 8c. Enrich Metrics JSONL

Find the metrics file at `planning/{session}/metrics.jsonl`. Locate the line where
`task.id == {task_id}`. Add or update the `deploy` object on that line:

```json
"deploy": {
  "canary_result": "success",
  "pipeline_minutes": {pipeline_minutes},
  "reverted": false
}
```

Write the updated line back.

Skip if no session or metrics file exists.

### 8d. Fire shipwright_task_deployed

Skip if no task was found (deploy-only mode). Re-resolve the script path inline:
```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && [ -n "{task_id}" ] && python3 "$POSTHOG_SCRIPT" shipwright_task_deployed \
  --project {repo} --task {task_id} \
  canary_result=success pipeline_minutes={pipeline_minutes} reverted=false
```

---

## Step 9: Print Handoff

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEPLOYED: {task_id}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PR:       #{pr} — {pr_title}
SHA:      {SQUASH_SHA[0..7]}
Pipeline: {pipeline_minutes}m (Deploy → Canary → Promote)
Health:   {✓ passing | ⚠ {status} — investigate}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
