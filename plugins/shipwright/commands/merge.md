---
description: Merge an approved, CI-green PR, mark its task-store records merged, and watch post-merge CI — the loop's merge phase, no canary/promote
argument-hint: "[org/repo#number | number]"
---

# Merge

Merge a PR, mark its linked task-store records merged, and watch post-merge CI on the squash
commit. This is the loop's merge phase: the orchestrator dispatches it for approved, CI-green
PRs. There is no Deploy → Canary → Promote pipeline —
merging and watching post-merge CI is its entire scope. A post-merge CI failure blocks the
affected tasks for a human; there is no canary and no promote.

**This command runs autonomously. Do not pause for user input unless pre-flight fails.**

> **Task store setup:** This command updates task status in the Shipwright task store on merge completion. If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke `/shipwright:task-store` for setup instructions.

---

## Arguments

Parse `$ARGUMENTS` to extract `org`, `repo`, and `pr` number. `$ARGUMENTS` is required —
this command always targets an explicit PR:
- `org/repo#number` (e.g. `app-vitals/shipwright#123`): explicit
- `number` or `#number`: infer org/repo from the agent config (`curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -r '.repos[0] // empty'`),
  defaulting to `app-vitals/shipwright`.
  **Limitation**: bare numbers only check the first configured repo (`repos[0]`). Multi-repo agents should use the full `org/repo#number` form to target a PR in any repo beyond the first.
- _(no arguments)_: respond `[silent]` and stop — no GitHub scan across own open PRs.

- Optional trailing **pre-claim marker** — `[preclaim:{recordId}:{commitSha}]` — appended
  after `org/repo#number`/`number` by the loop orchestrator (`agent/src/loop-orchestrator.ts`'s
  `formatPreClaimMarker`) when it already claimed this PR in the task store (phase `merge`)
  before dispatch, e.g. `app-vitals/shipwright#123 [preclaim:ckz1abc123:8cb7b38cdb6a...]`.
  When present, strip it before parsing `org/repo#number`/`number` above and extract
  `PRECLAIM_RECORD_ID` and `PRECLAIM_COMMIT_SHA` from it. If absent, leave both unset. See
  Step 3a's Pre-Claim Fast Path for how the marker is validated against the live head. A human
  invoking this command directly never supplies this marker.

---

## Step 1: Resolve Target PR

Parse `$ARGUMENTS` using the rules in the Arguments section above to extract `org`, `repo`,
and `pr`.

Look up the task via the task store:

```bash
TASK_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks?repo={org}/{repo}&pr={pr}" | jq .)
TASK_ID=$(echo "$TASK_JSON" | jq -r '.tasks[0].id // empty')
TASK_TITLE=$(echo "$TASK_JSON" | jq -r '.tasks[0].title // empty')
TASK_STATUS=$(echo "$TASK_JSON" | jq -r '.tasks[0].status // empty')
TASK_IDS=$(echo "$TASK_JSON" | jq -r '[.tasks[] | select(.status == "pr_open") | .id] | join(" ")')
```

**Bundled PRs (`TASK_IDS`).** A single PR can carry several tasks. `TASK_IDS` is the
space-separated list of every `pr_open` task on this PR, including the primary — bundle-mates
already past `pr_open` (e.g. `deployed`/`done`) are excluded so they are never regressed to
`merged`. Marking merged (Step 3b)
and the post-merge CI watch (Step 4) loop over `TASK_IDS`, so bundle-mates are merged and
watched or blocked together.

**Releasing a pre-claim.** If a pre-claim marker was supplied, the orchestrator already holds
a `phase: "merge"` claim on this PR. Every early exit below (not authored by us, bundle gate,
pre-flight failure) must release it first so the PR is not stuck until the claim TTL:

```bash
[ -n "$PRECLAIM_RECORD_ID" ] && curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PRECLAIM_RECORD_ID/release"
```

If `TASK_ID` is empty or `TASK_STATUS` is not `"pr_open"`, proceed in **merge-only mode** — no
todos update will be performed. Set `MERGE_ONLY=true` for this case (else `MERGE_ONLY=false`);
Step 4's failure path reads it.

### 1a. Own-PRs-Only Check

Get the current agent's own canonical GH login (via the login-identity helper — the REST `/user` endpoint 403s under installation tokens) and verify the PR was authored by the agent:

```bash
AGENT_LOGIN=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/login-identity.ts")
PR_AUTHOR=$(gh pr view {pr} --repo {org}/{repo} --json author --jq '.author.login')
```

Compare canonical forms on both sides — `gh pr view` reports a bot as `app/<slug>`, which `AGENT_LOGIN` never carries:

```bash
PR_AUTHOR_CANON=$(printf '%s' "$PR_AUTHOR" | sed -E 's#^app/##; s#\[bot\]$##' | tr '[:upper:]' '[:lower:]')
```

If `PR_AUTHOR_CANON != AGENT_LOGIN`, this PR was not authored by the current agent — release any pre-claim (see above), skip it silently and stop. Only PRs we authored go through this merge command.

Print:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MERGE: PR #{pr}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Repo:   {org}/{repo}
Task:   {task_id} — {task_title}  (or "standalone merge" if no task found)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 1b. Bundle Completeness Gate

Before running pre-flight checks, verify that all tasks on this branch are `pr_open` or
beyond (i.e., no bundle-mates are still in flight). This prevents merging a PR while
sibling tasks on the same branch are still being developed or are blocked.

```bash
HEAD_BRANCH=$(gh pr view {pr} --repo {org}/{repo} --json headRefName --jq '.headRefName')
BRANCH_TASKS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks?branch=$HEAD_BRANCH" 2>/dev/null || echo '{"tasks":[],"total":0,"limit":50,"offset":0}')
INCOMPLETE_TASKS=$(echo "$BRANCH_TASKS" | jq '[.tasks[] | select(.status == "pending" or .status == "in_progress" or .status == "blocked") | {id, status}]')
INCOMPLETE=$(echo "$INCOMPLETE_TASKS" | jq 'length')
```

**If `INCOMPLETE > 0`**: do NOT proceed to pre-flight. Release any pre-claim first, then print:
```
⏸ Bundle gate: {INCOMPLETE} task(s) on branch {HEAD_BRANCH} are still in flight:
  {for each item in INCOMPLETE_TASKS: "  - {id} ({status})"}
  Waiting for bundle-mates to reach pr_open before merging.
```
Stop here. There is no other candidate to fall back to. Emit `[skip-reason:merge:bundle-incomplete:{HEAD_BRANCH}]`
alongside `[silent]` (interpolating `{HEAD_BRANCH}` from the value fetched above) — order
relative to `[silent]` does not matter, both are recognized regardless of position. The
skip-reason marker records exactly which branch's bundle gate blocked this dispatch in the
`AgentCronRun.skipReason` field, visible in the admin cron-logs UI, instead of the generic
`command:no-work` reason the loop orchestrator falls back to for silent dispatches that
don't tag a specific reason (see `agent/src/loop-orchestrator.ts` and `agent/src/markers.ts`).

**Otherwise** (`INCOMPLETE == 0` — no tasks tracked, or all tasks are `pr_open` or beyond):
proceed to Step 2.

---

## Step 2: Pre-flight Checks (GitHub API — no local state)

All pre-flight checks query GitHub directly. No worktree or local clone is needed.

### 2a. Verify PR Approval

Check the PR's review status from GitHub:

```bash
gh pr view {pr} --repo {org}/{repo} --json reviewDecision,reviews \
  --jq '{decision: .reviewDecision, approvals: [.reviews[] | select(.state == "APPROVED") | .author.login]}'
```

**If `reviewDecision` is `"APPROVED"`**: Record `approval_source = "github"` and `approvers = [list]`. Proceed to Step 2b.

**If `reviewDecision` is not `"APPROVED"`**: Read `allow_self_review` DB-first,
then hardcoded default — the same order as review.md's Step 1:
```bash
ALLOW_SELF_REVIEW=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -r '.allowSelfReview | select(. != null)')
```
Use `select(. != null)`, **not** `// empty` — jq's `//` treats `false` as absent, so
`// empty` would silently discard a deliberately-set `allowSelfReview: false` from the DB
and fall through to the hardcoded default. Same idiom as review.md's Step 1.

If `ALLOW_SELF_REVIEW` is empty (the DB has no record yet, or the config fetch failed), use the hardcoded
`allow_self_review` default: false. If
`allow_self_review` is true, fetch the PR's
reviews from GitHub and check if any review has a clean APPROVE body — either a leading
`APPROVE` (strip any leading markdown bold markers (`**`) first, since the review skill
posts `"**APPROVE**"`) or a `Verdict: APPROVE` label anywhere in the body (the narrative
self-review convention, case-insensitive, optional `**` around either word — mirrors
`agent/src/check-helpers.ts`'s `isCleanApproveBody`, shared by `agent/src/check-merge.ts`'s
`hasSelfApproveReview` and `agent/src/check-patch.ts`'s `isSelfCleanApprove`):

```bash
gh pr view {pr} --repo {org}/{repo} --json reviews \
  --jq '[.reviews[] | .body] | any(
    (sub("^\\s*";"") | sub("^\\*+";"") | startswith("APPROVE"))
    or test("verdict\\**\\s*:\\s*\\**approve\\b"; "i")
  )'
```

A matching review is one whose stripped body `startsWith("APPROVE")` or that contains a
`Verdict: APPROVE` label. If a matching review is found: Record `approval_source =
"self_review"` and proceed to Step 2b.
Print:
```
ℹ No GitHub approval. Proceeding on clean APPROVE review.
```

If no matching review is found (or `allow_self_review` is false), release any pre-claim
(`/prs/$PRECLAIM_RECORD_ID/release`, see Step 1), then print and stop:
```
✗ Pre-flight failed: PR #{pr} is not approved.
  GitHub reviewDecision: {decision}
  No APPROVE review found on GitHub for this PR.
  Options:
    1. Have a human approve the PR on GitHub, or
    2. Run /shipwright:review on the PR — once an APPROVE review is posted, re-run /shipwright:merge.
```

### 2b. Verify All Checks Are Green

Fetch the PR's head commit, then query the Actions API directly for every workflow run at
that SHA (Actions:Read scope — works on public and private repos with a fine-grained PAT,
unlike `statusCheckRollup`, which requires the GitHub Checks permission that fine-grained
PATs cannot be granted on private repos):

```bash
HEAD_SHA=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
RUNS_JSON=$(gh api "repos/{org}/{repo}/actions/runs?head_sha=$HEAD_SHA" --jq '.workflow_runs')
ALL_GREEN=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/is-ci-green.ts" "$RUNS_JSON")
```

No workflow-name filter is applied — every run for the head SHA is fetched and handed to the
shared `is-ci-green.ts` classifier (CIG-1.1), which dedups the runs by `workflow_id` (keeping
only the highest `run_number` per workflow) so a fixed-and-rerun workflow isn't permanently
blocked by its own stale failure. This catches every required check (e.g. `pr-title-lint`, or
any other repo-specific required workflow), not just a single named CI workflow.

A run is green when its latest-per-`workflow_id` entry has `conclusion` of `success`,
`skipped`, or `neutral`. All latest-per-workflow runs must be green, and there must be at
least one run — an empty run list is not green (fail-closed).

If `ALL_GREEN` is not `"true"` (or the run list is empty), release any pre-claim
(`/prs/$PRECLAIM_RECORD_ID/release`, see Step 1), then print and stop:
```
✗ Pre-flight failed: not all checks are green on PR #{pr} head ({HEAD_SHA[0..7]}).
  Resolve check failures before merging.
```

### 2c. Pre-flight Summary

If both checks pass:
```
✓ Pre-flight passed
  Approval:    {if approval_source == "github": "GitHub — approved by: {approvers}" | if approval_source == "self_review": "Self-review — APPROVE found in GitHub review body"}
  Checks:      all green ({HEAD_SHA[0..7]})
```

---

## Step 3: Merge

### 3a. Claim PR Record (pre-merge lock)

Before merging, claim the PR record with `phase: "merge"`. GitHub itself prevents a PR from
being double-merged, but without this claim, two overlapping merge runs can both pass Step 2's
approval/CI checks and both proceed to merge and watch post-merge CI, risking duplicate work.

```bash
HEAD_SHA_PRE_MERGE=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```

**Pre-Claim Fast Path.** If a pre-claim marker was captured in Step 1, validate it against
`HEAD_SHA_PRE_MERGE` — the live head just fetched above — before trusting it; the head can
have moved since the orchestrator claimed (Step 2's pre-flight checks take time):

- **`HEAD_SHA_PRE_MERGE == PRECLAIM_COMMIT_SHA`** (marker is current): trust it. Set
  `PR_RECORD_ID = PRECLAIM_RECORD_ID` and **skip the claim call below** — the orchestrator's
  pre-claim already holds this PR under `phase: "merge"`. Proceed directly to Step 3b
  (`PR_RECORD_ID` is reused by the post-merge update in Step 3c).
- **`HEAD_SHA_PRE_MERGE != PRECLAIM_COMMIT_SHA`** (stale marker — new commits landed between
  the orchestrator's claim and now) **or no marker present**: self-claim with the call below.
  If the marker was stale, release the stale pre-claim (`/prs/$PRECLAIM_RECORD_ID/release`)
  first.

```bash
PR_CLAIM=$(curl -s -o /tmp/pr_claim_merge.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "$(jq -n --arg repo "{org}/{repo}" --argjson prNumber {pr} --arg commitSha "$HEAD_SHA_PRE_MERGE" \
        --arg authorLogin "$PR_AUTHOR" --arg headRef "$HEAD_BRANCH" \
        --arg claimedBy "${SHIPWRIGHT_AGENT_ID:-local}" \
        '{claimedBy: $claimedBy, repo: $repo, prNumber: $prNumber, commitSha: $commitSha, phase: "merge", authorLogin: $authorLogin, headRef: $headRef}')")
PR_RECORD_ID=$(jq -r '.id // empty' /tmp/pr_claim_merge.json)
```

**If `PR_CLAIM` is `409`** (another merge run already claimed this PR at phase `merge`):
do NOT merge. Print:
```
⏸ PR #{pr} is already claimed by another merge run — skipping.
```
There is no other candidate to fall back to. Stop here.

**Otherwise** (`200` or `201`): the claim succeeded. `PR_RECORD_ID` is reused by the
post-merge update in Step 3c — no second claim call is needed. Proceed to Step 3b.

### 3b. Squash Merge

Squash merge the PR — regardless of `approval_source` from Step 2a — capturing combined
output and exit code explicitly rather than trusting an unchecked exit:

```bash
MERGE_OUTPUT=$(gh pr merge {pr} --repo {org}/{repo} --squash 2>&1)
MERGE_EXIT=$?
```

This no longer forces the merge through unconditionally: the command now defers to GitHub's
branch protection natively rather than bypassing it. In practice this rarely blocks — both
maintainer accounts are configured as `bypass_actors` on the active CODEOWNERS ruleset
(`require_code_owner_review: true`, ruleset id `18495740`) enforced on `main`, and other
repos this agent merges into may have no review requirement configured at all — so the
branch-protection-block detection below is a defensive backstop for the rare case (a PR
opened under a different identity, or ruleset config drift), not the common path.

**If `MERGE_EXIT != 0`** (the merge command itself failed — nothing to poll for), check
whether the failure is a branch-protection block:

```bash
if echo "$MERGE_OUTPUT" | grep -qi "base branch policy prohibits the merge"; then
  IS_BRANCH_PROTECTION_BLOCK=true
else
  IS_BRANCH_PROTECTION_BLOCK=false
fi
```

**Branch-protection-block case** (`IS_BRANCH_PROTECTION_BLOCK=true`, per the
`auto-bump-chart.yml` PR #1084 precedent — GitHub's GraphQL error text when a required
review is missing and no bypass applies): release the pre-merge claim from Step 3a first,
then mark the task/PR record `blocked`. The `blockedReason` must name the underlying gap
explicitly — a self-review APPROVE body does not satisfy GitHub's native required-review
rule, which nothing here forces past anymore:

```bash
[ -n "$PR_RECORD_ID" ] && curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"

if [ -n "$TASK_ID" ]; then
  curl -sf -X PATCH \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
    -d '{"status": "blocked", "blockedReason": "Merge blocked by branch protection — a self-review APPROVE does not satisfy the native GitHub required-review rule; a human must add a real approval or configure this identity as a ruleset bypass actor."}' | jq .
elif [ -n "$PR_RECORD_ID" ]; then
  curl -sf -X PATCH \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID" \
    -d '{"blocked": true, "blockedReason": "Merge blocked by branch protection — a self-review APPROVE does not satisfy the native GitHub required-review rule; a human must add a real approval or configure this identity as a ruleset bypass actor."}' | jq .
fi
```

Print and stop:
```
✗ Merge blocked by branch protection — PR #{pr} requires a real GitHub approval.
  A self-review APPROVE does not satisfy GitHub's native required-review rule.
  A human must add a real approval, or configure this identity as a ruleset bypass actor.
```

**Generic merge-failure case** (`MERGE_EXIT != 0` but `IS_BRANCH_PROTECTION_BLOCK=false`):
release the pre-merge claim first, then mark the task/PR record `blocked` with a reason
referencing the captured output for diagnosis. Build the JSON body with `jq -n --arg` rather
than interpolating `$MERGE_OUTPUT` directly into a quoted string — `gh`'s error output can
contain quotes or newlines that would otherwise produce invalid JSON:

```bash
[ -n "$PR_RECORD_ID" ] && curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"

if [ -n "$TASK_ID" ]; then
  curl -sf -X PATCH \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
    -d "$(jq -n --arg reason "Squash merge failed — $MERGE_OUTPUT" '{"status": "blocked", "blockedReason": $reason}')" | jq .
elif [ -n "$PR_RECORD_ID" ]; then
  curl -sf -X PATCH \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID" \
    -d "$(jq -n --arg reason "Squash merge failed — $MERGE_OUTPUT" '{"blocked": true, "blockedReason": $reason}')" | jq .
fi
```

Print and stop:
```
✗ Squash merge failed on PR #{pr}.
  {MERGE_OUTPUT}
  Check the PR on GitHub — a human may need to resolve this manually.
```

**Success case** (`MERGE_EXIT == 0`): fall through to the existing poll-for-completion step
below — the merge command succeeded, but GitHub may still take a moment to reflect the
`"MERGED"` state.

Poll for the merge to complete — check `gh pr view {pr} --json state --jq '.state'` every
5 seconds, up to 60 seconds. When the state becomes `"MERGED"`, capture the squash SHA:

```bash
SQUASH_SHA=$(gh api "repos/{org}/{repo}/git/refs/heads/main" --jq '.object.sha')
```

If the state has not become `"MERGED"` after 60 seconds, release the pre-merge claim from
Step 3a so a subsequent retry is not blocked by a stale `phase: "merge"` lock — the merge
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

**Do not PATCH the task to `status: "blocked"` here.** A merge conflict is routine and
self-recoverable — `check-patch.ts`'s candidate logic already detects any `DIRTY` PR
independent of task status and fixes it automatically, no human required. Marking the task
`blocked` would hide it from candidate lists that explicitly skip PRs whose linked task is
`blocked`, even after patch resolves the conflict, stranding it until a human notices and
corrects the record by hand. Leave the task's status exactly as it was.

Print:
```
✓ Merged PR #{pr} → main
  Squash SHA: {SQUASH_SHA[0..7]}
```

Mark the task (and every bundle-mate task on `TASK_IDS`) merged via the task store — skip if
in merge-only mode:

```bash
for tid in $TASK_IDS; do
  curl -sf -X PATCH \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks/$tid" \
    -d "$(jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{"status": "merged", "mergedAt": $at}')" | jq .
done
```

### 3c. Update PullRequest Record (post-merge)

The record was already claimed pre-merge in Step 3a — `PR_RECORD_ID` is already set, so
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

Release the claim now that the merge and record update are done, so the PR is not held
until the claim TTL (the post-merge CI watch below does not need it):

```bash
[ -n "$PR_RECORD_ID" ] && curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"
```

---

## Step 4: Post-Merge CI Watch

Poll CI on `SQUASH_SHA` every 30 seconds for up to 10 minutes (20 polls). This watch never
runs canary or promote and never marks anything deployed — it only decides whether the merged
tasks stay `merged` or get `blocked` for a human.

```bash
REPO="{org}/{repo}"
RUNS_JSON=$(gh api "repos/$REPO/actions/runs?per_page=50" \
  --jq "[.workflow_runs[] | select(.head_sha == \"$SQUASH_SHA\") | {id, name, workflow_id, run_number, status, conclusion}]")
ALL_GREEN=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/is-ci-green.ts" "$RUNS_JSON")
```

Print progress on each poll: `[{elapsed}m] {name}: {status}/{conclusion} | ...` (use `-` for
runs not yet seen). `is-ci-green.ts` dedups by `workflow_id` (latest `run_number`), treats
`success`, `skipped` and `neutral` as green, and fails closed on an empty run list.

**Green** (`ALL_GREEN == "true"`):
```
✓ Post-merge CI passed ({elapsed}m)
```
Tasks stay `merged` — no further task-store writes. Proceed to Step 5.

**Failed run** (`ALL_GREEN` is not `"true"` and a latest-per-workflow run has a terminal
non-green `conclusion` — `failure`, `cancelled`, `timed_out`, `action_required`, `stale`, or
`startup_failure`):
```
✗ Post-merge CI failed — {name}
  Logs: gh run view {id} --log --failed
```
Block every task on `TASK_IDS` (not just the primary — bundle-mates were merged together and
fail together). Only do so when Step 3b actually marked them merged: in merge-only mode
(`MERGE_ONLY=true`) the tasks were never moved to `merged`, so PATCHing `blocked` onto them
would regress their status (e.g. an already `deployed`/`done` task). In merge-only mode, or when
no task is linked, flag the PR record instead:
```bash
if [ "$MERGE_ONLY" != "true" ] && [ -n "$TASK_IDS" ]; then
  for tid in $TASK_IDS; do
    curl -sf -X PATCH \
      -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
      -H "Content-Type: application/json" \
      "$SHIPWRIGHT_TASK_STORE_URL/tasks/$tid" \
      -d "{\"status\": \"blocked\", \"blockedReason\": \"Post-merge CI failed — run ID: {id}\"}" | jq .
  done
elif [ -n "$PR_RECORD_ID" ]; then
  curl -sf -X PATCH \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID" \
    -d "{\"blocked\": true, \"blockedReason\": \"Post-merge CI failed — run ID: {id}\"}" | jq .
fi
```
Proceed to Step 5.

**Pending at timeout** (10 minutes elapsed, `ALL_GREEN` still not `"true"`, every run still
`queued`/`in_progress`): leave the tasks `merged` — do not block them and do not change their
status. Print:
```
⚠ Post-merge CI still pending after 10 minutes.
  Check manually: gh api repos/{org}/{repo}/actions/runs?head_sha={SQUASH_SHA}
```
Proceed to Step 5.

---

## Step 5: Print Handoff

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MERGED: {task_id}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PR:   #{pr} — {pr_title}
SHA:  {SQUASH_SHA[0..7]}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
