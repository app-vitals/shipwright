---
description: Merge and deploy a PR through the Deploy → Canary → Promote pipeline
argument-hint: "[org/repo#number | number]"
---

# Deploy

Merge a PR and drive it through the Deploy → Canary → Promote pipeline. Monitors each
stage, detects ARC desync, opens a revert PR on canary failure, and updates todos and
metrics on success.

**This command runs autonomously. Do not pause for user input unless pre-flight fails.**

> **Task store setup:** This command updates task status in the Shipwright task store on deploy completion. If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke `/shipwright:task-store` for setup instructions.

---

## Arguments

Parse `$ARGUMENTS` to extract `org`, `repo`, and `pr` number:
- `org/repo#number` (e.g. `app-vitals/shipwright#123`): explicit
- `number` or `#number`: infer org/repo from the agent config (`curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -r '.repos[0] // empty'`),
  defaulting to `app-vitals/shipwright`.
  **Limitation**: bare numbers only check the first configured repo (`repos[0]`). Multi-repo agents should use the full `org/repo#number` form to target a PR in any repo beyond the first.
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
REPOS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -r '.repos[]')
```

For each configured repo, fetch all open PRs authored by `AGENT_LOGIN`:
```bash
gh pr list --state open --repo {org}/{repo} --author "$AGENT_LOGIN" \
  --json number,headRefOid,author,reviewDecision
```

For each PR, check in order:

1. **Approval** — if `reviewDecision == "APPROVED"`: approved. Otherwise, if
   `allow_self_review` is true: fetch the PR's reviews and check if any review authored
   by `AGENT_LOGIN` has a clean APPROVE body — either a leading `APPROVE` (stripping
   leading markdown bold markers (`**`) first, since the review skill posts
   `"**APPROVE**"`) or a `Verdict: APPROVE` label anywhere in the body (the narrative
   self-review convention, case-insensitive, optional `**` around either word — mirrors
   `check-helpers.ts`'s `isCleanApproveBody`, shared by `check-deploy.ts`'s
   `hasSelfApproveReview` and `check-patch.ts`'s `isSelfCleanApprove`):
   ```bash
   gh pr view {pr} --repo {org}/{repo} --json reviews \
     --jq '[.reviews[] | select(.author.login == "'$AGENT_LOGIN'") | .body] | any(
       (sub("^\\s*";"") | sub("^\\*+";"") | startswith("APPROVE"))
       or test("verdict\\**\\s*:\\s*\\**approve\\b"; "i")
     )'
   ```
   Skip if neither source shows approval.

2. **CI green** — fetch CI runs for the PR's head commit:
   ```bash
   gh api "repos/{org}/{repo}/actions/runs?head_sha={headRefOid}&per_page=20" \
     --jq '[.workflow_runs[] | select(.name == "CI") | {status, conclusion}]'
   ```
   Skip if no CI run has `status == "completed"` and `conclusion == "success"`.

Keep the ordered list of qualifying PRs as `CANDIDATE_LIST`. Pick the **first** entry
as the primary candidate. If none qualify, respond `[silent]` and stop — no output.

Once a qualifying PR is found, proceed to Step 2 with that PR number and repo as the target.
If Step 4a's pre-merge claim later hits a 409 conflict, control returns here to retry with
the next untried entry in `CANDIDATE_LIST`.

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
reviews from GitHub and check if any review from `AGENT_LOGIN` has a clean APPROVE body —
either a leading `APPROVE` (strip any leading markdown bold markers (`**`) first, since
the review skill posts `"**APPROVE**"`) or a `Verdict: APPROVE` label anywhere in the body
(the narrative self-review convention, case-insensitive, optional `**` around either word
— mirrors `check-helpers.ts`'s `isCleanApproveBody`, shared by `check-deploy.ts`'s
`hasSelfApproveReview` and `check-patch.ts`'s `isSelfCleanApprove`):

```bash
gh pr view {pr} --repo {org}/{repo} --json reviews \
  --jq '[.reviews[] | select(.author.login == "'$AGENT_LOGIN'") | .body] | any(
    (sub("^\\s*";"") | sub("^\\*+";"") | startswith("APPROVE"))
    or test("verdict\\**\\s*:\\s*\\**approve\\b"; "i")
  )'
```

A matching review is one whose stripped body `startsWith("APPROVE")` or that contains a
`Verdict: APPROVE` label. If a matching review is found: Record `approval_source =
"self_review"` and proceed to Step 3b.
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

### 4a. Claim PR Record (pre-merge lock)

Before merging, claim the PR record with `phase: "deploy"`. GitHub itself prevents a PR
from being double-merged, but without this claim, two overlapping deploy runs can both
pass Step 3's approval/CI checks and both proceed into post-merge CI-watch polling and
canary-revert logic — risking duplicate work and potentially duplicate revert PRs on a
canary failure.

```bash
HEAD_SHA_PRE_MERGE=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
PR_CLAIM=$(curl -s -o /tmp/pr_claim_deploy.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"$HEAD_SHA_PRE_MERGE\", \"phase\": \"deploy\"}")
PR_RECORD_ID=$(jq -r '.id // empty' /tmp/pr_claim_deploy.json)
```

**If `PR_CLAIM` is `409`** (another deploy run already claimed this PR at phase `deploy`):
do NOT merge. Print:
```
⏸ PR #{pr} is already claimed by another deploy run — skipping.
```
- **Scan mode**: return to Step 1a's `CANDIDATE_LIST` and retry Steps 2 through 4a with the
  next candidate PR. If no candidates remain, respond `[silent]` and stop.
- **Explicit-target mode**: there is no other candidate to fall back to. Stop here.

**Otherwise** (`200` or `201`): the claim succeeded. `PR_RECORD_ID` is reused by the
post-merge update in Step 4c — no second claim call is needed. Proceed to Step 4b.

### 4b. Squash Merge

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

If the state has not become `"MERGED"` after 60 seconds, release the pre-merge claim from
Step 4a so a subsequent retry is not blocked by a stale `phase: "deploy"` lock — the merge
never completed, so nothing is actually in flight:

```bash
[ -n "$PR_RECORD_ID" ] && curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"
```

Then print and stop:
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

### 4c. Update PullRequest Record (post-merge)

The record was already claimed pre-merge in Step 4a — `PR_RECORD_ID` is already set, so
this is a plain update against the existing claim, not a redundant claim call:

```bash
if [ -n "$PR_RECORD_ID" ]; then
  curl -sf -X PATCH \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID" \
    -d "{\"state\": \"merged\", \"mergedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"reviewState\": \"approved\", \"commitSha\": \"$SQUASH_SHA\"}" \
    > /dev/null 2>&1 || echo "⚠ PATCH /prs/$PR_RECORD_ID failed — continuing"
else
  echo "⚠ Failed to upsert PullRequest record — continuing"
fi
```

---

## Step 5: Poll Deploy → Canary → Promote

Mark the task `deploying` — the merge has landed and the deploy pipeline is now in
flight. This stamps `deployingAt`, the start of the deploy window (`deployedAt − deployingAt`
is the deploy duration). Skip if in deploy-only mode:

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d "{\"status\": \"deploying\", \"deployingAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | jq .
```

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

**Renew the claim heartbeat at the midpoint** (elapsed ≈ 15 minutes, the midpoint of the
30-minute budget): the `PullRequest` record claimed in Step 4 has a TTL shorter than this
poll's full budget, so a pipeline that runs the full 30 minutes would otherwise let the
claim go stale before Promote resolves. Renew once, best-effort:

```bash
if [ -n "$PR_RECORD_ID" ]; then
  curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"
fi
```

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
PR #{pr} was merged to main and deployed. The canary suite failed
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

## Step 8: Update Task Store

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
