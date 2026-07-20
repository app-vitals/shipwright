---
description: Address unresolved review findings, merge conflicts, and failing CI on a specific own open PR — queries GitHub directly, fixes in worktree, pushes
argument-hint: "<org/repo#number>"
---

# Patch

Check one given PR for three conditions: unaddressed review/PR comments, merge conflicts
with base, and failing CI. Apply the appropriate fix. Goes silent when nothing needs
addressing, or when no target PR is given.

> **Note:** Branches merely BEHIND main (no conflict) are not patch-worthy. Main is only
> merged into a branch to resolve an actual conflict — see Step 2.5 and Step 4 for the
> conflict-only (DIRTY) path.

**This command runs autonomously. Do not pause for user input.**

> **Task store setup:** This command records patch cycles in the Shipwright task store after pushing fixes. If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke `/shipwright:task-store` for setup instructions.

---

## Arguments

Parse `$ARGUMENTS`:
- `org/repo#number` (e.g. `app-vitals/shipwright#123`): **required** — target a specific
  PR. Fetch just this PR (still scoped to `CURRENT_USER` as author, per the Independence
  Principles' "own PRs only" rule for patch) and classify it into Lists A/C/D as usual from
  Step 3 onward.
- _(no arguments)_: not supported — respond `[silent]` and stop, with no GitHub scan across
  all open PRs (see Step 0).
- Optional trailing **pre-claim marker** — `[preclaim:{recordId}:{commitSha}]` — appended
  after `org/repo#number` by the loop orchestrator (`agent/src/loop-orchestrator.ts`'s
  `formatPreClaimMarker`, CBD-1.3) when it already claimed this PR in the task store before
  dispatch, e.g. `app-vitals/shipwright#123 [preclaim:ckz1abc123:8cb7b38cdb6a...]`. When
  present, strip it before parsing `org/repo#number` above — Step 2 extracts
  `PRECLAIM_RECORD_ID`/`PRECLAIM_COMMIT_SHA` from it once, and each claim site's Pre-Claim
  Fast Path (Steps 4a.6/5a.6/6b.5) independently re-validates the marker against that site's
  freshly-fetched live head before trusting it. A human invoking this command directly never
  supplies this marker; it is only ever produced by the loop orchestrator.

---

## Step 0: Require Explicit Target

If `$ARGUMENTS` is empty, append `[silent]` and stop. An explicit `org/repo#number` target
is required — patch no longer discovers PRs by scanning all own open PRs across configured
repos.

Otherwise, proceed to Step 1.

---

## Step 1: Get Own GH Login

Resolve the current GitHub CLI user once and remember the value — substitute it directly
into all subsequent commands that need it:

```bash
CURRENT_USER=$(gh api /user -q '.login')
```

---

## Step 2: Resolve Target PR

Parse `$ARGUMENTS` for the `org/repo#number` target (per the Arguments section above). If
`$ARGUMENTS` has a trailing `[preclaim:{recordId}:{commitSha}]` marker (see Arguments
section), extract `PRECLAIM_RECORD_ID` and `PRECLAIM_COMMIT_SHA` from it and **strip the
marker** before parsing the rest of the argument — do this once here; each of the three
claim sites (Steps 4a.6/5a.6/6b.5) re-validates the same marker against its own live head
later. If no marker is present, leave `PRECLAIM_RECORD_ID`/`PRECLAIM_COMMIT_SHA` unset — the
claim sites then self-claim as today. Then fetch that PR:

```bash
gh pr view {number} --repo {org}/{repo} \
  --json number,title,headRefName,headRefOid,additions,deletions,mergeStateStatus,state,author
```

- **Not found, or `state != "OPEN"`, or `author.login != CURRENT_USER`**: this PR is not
  workable by patch (per the Independence Principles' "own PRs only" scope). Print
  `⚠ PR {org}/{repo}#{number} not found among own open PRs.` and stop.
- **Match found**: use it as the sole entry in the unified PR list and proceed directly to
  Step 2.5.

---

## Step 2.5: Handle DIRTY PRs (Auto-Rebase Attempt)

For each PR discovered in Step 2, use the `mergeStateStatus` field (already fetched in Step 2) to identify DIRTY PRs.

For each DIRTY PR, attempt an automatic rebase via GitHub:
```bash
gh pr update-branch --rebase {number} --repo {org}/{repo}
```

**If update-branch succeeds (exit 0)**: The merge conflict was auto-resolvable. The PR's branch is now up to date — it will no longer appear as `DIRTY` in Step 3b. Print:
```
↻ PR #{number} was DIRTY — auto-rebased successfully, continuing normal flow
```

**If update-branch fails (non-zero exit)**: Auto-rebase failed. The PR will be classified into **List C** in Step 3b and resolved via worktree in Step 4.

---

## Step 3: Classify PRs into Three Lists

Check each PR against all three conditions independently. A PR may appear in multiple lists.

- **List A** — PRs with unresolved review or PR comments
- **List C** — PRs with merge conflicts (DIRTY)
- **List D** — PRs with failing CI

Work through all PRs before continuing. When a PR appears in multiple lists, all applicable fixes run — processed in the order the steps execute (C → A → D).

**This command does not read `state/reviews.json`.** All data comes from GitHub directly.

### Step 3a: Check for Unaddressed Review Findings

For each PR, issue a single GraphQL query to get all reviews, all inline review threads,
and all PR-level comments:

```bash
gh api graphql -f query='
{
  repository(owner: "{org}", name: "{repo}") {
    pullRequest(number: {pr}) {
      headRefOid
      reviews(first: 50) {
        nodes {
          author { login }
          state
          submittedAt
          body
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              author { login }
              body
              path
              line
            }
          }
        }
      }
      comments(first: 50) {
        nodes {
          author { login }
          body
          createdAt
        }
      }
    }
  }
}'
```

From the response, extract:
- `headRefOid` — current HEAD SHA of the PR
- `reviews.nodes[]` — each with `author.login`, `state`, `submittedAt`, `body`
- `reviewThreads.nodes[]` — each with `id`, `isResolved`, and the first comment's `author.login`, `body`, `path`, `line`
- `comments.nodes[]` — PR-level (non-inline) comments with `author.login`, `body`, `createdAt`

A PR has **unaddressed findings** when ANY of the following are true:
- At least one inline thread has `isResolved == false`
- At least one review with `state == "COMMENTED"` or `state == "CHANGES_REQUESTED"` has a
  non-empty `body` (a review body without matching inline threads is itself a finding),
  excluding clean-APPROVE reviews (see below) and reviews addressed via a subsequent author
  reply (see below)

A PR has **no findings** (skip it) when ALL of the following are true:
- All inline threads are resolved (`isResolved == true` for every thread)
- No COMMENTED or CHANGES_REQUESTED review has a non-empty body, other than clean-APPROVE
  reviews (see below) and reviews addressed via a subsequent author reply (see below)

**Clean-APPROVE exclusion**: A review is excluded from the body check above when its body is
a clean APPROVE verdict, matched either by:
- leading markdown bold markers (`**`) stripped, the body starts with `APPROVE`, or
- a `Verdict: APPROVE` label appears anywhere in the body (case-insensitive, optional bold
  markers around either word) — **not** anchored to end-of-line, since the agent's narrative
  self-reviews often trail reasoning after the verdict on the same line, e.g.
  `"...All 5 acceptance criteria met. Verdict: APPROVE (posted as COMMENT — GitHub disallows
  self-approval via the API)."` (verbatim from shipwright PR #1272, the case that motivated
  this).

Not restricted to self-authored reviews (SRV-1.1): multiple distinct Shipwright agents
operate under different GitHub identities in the same repo, so WHO posted a clean APPROVE
verdict is not meaningful — the verdict text itself is the ground truth. Per review.md's
Step 10 note ("Self-review event override"), GitHub rejects self-APPROVE via the API, so an
agent's own clean approval of its own PR is always posted as `COMMENTED` with a body like
`"APPROVE — looks good, no changes needed."` or a narrative containing `"Verdict: APPROVE"`
instead of an `APPROVED` review. Without this exclusion, that clean approval would look
identical to a real finding and loop the patch cron forever on an already-approved PR. The
exclusion is scoped to clean APPROVE verdicts only — a review whose body neither starts with
`APPROVE` nor contains a `Verdict: APPROVE` label (e.g. it contains `Verdict:
CHANGES_REQUESTED`, meaning the reviewer found a real issue) still counts as a finding,
regardless of who posted it.

**Third-party review body addressed via reply (CPF-2.3)**: A review's non-empty body is
excluded from the finding check when the PR author has posted a PR-level comment (from
`comments.nodes`, already fetched by this same query) with `createdAt` after that review's
`submittedAt`. This exclusion is distinct from and independent of the clean-APPROVE
exclusion above — a review can be excluded by either one on its own.

The self-review "Verdict: APPROVE" rewrite (via the `updatePullRequestReview` mutation)
only works because `updatePullRequestReview` can only edit a review's OWN author's body —
it cannot be used on a third-party reviewer's review (e.g. a review posted by a distinct
GitHub identity like `dodizzle`). When a third-party review flags a real finding, the fix
subagent replies with a rebuttal or fix explanation and resolves the inline thread, but the
review's own body text remains exactly as the third party wrote it — it can never be
rewritten to signal the finding was addressed. A subsequent PR-author reply is therefore
the only available signal that a third-party review's finding was addressed (fixed or
rejected with a rebuttal), so it is treated the same as a body rewrite would be for a
self-authored review. This exclusion still requires all inline threads to be resolved
(`isResolved == true`) — an unresolved thread on the same review continues to count as a
finding regardless of any reply.

If neither condition applies (e.g., no reviews at all, only approved reviews, or only an
excluded clean-APPROVE or reply-addressed review), skip the PR — it does not belong in
List A.

If a PR has unaddressed findings, add it to **List A**. Store the unresolved threads (with their
`id` — needed for the `resolveReviewThread` mutation in Step 5) and review bodies for use in
Step 5.

### Step 3b: Check for DIRTY State

For each PR, check its merge state:

```bash
gh pr view {pr} --repo {org}/{repo} --json mergeStateStatus
```

- If `mergeStateStatus` is `"DIRTY"` → add to **List C**
- Any other state (including `"BEHIND"`) → not patch-worthy on its own; being behind
  main without a conflict does not require action

Store the fetched `mergeStateStatus` — do not re-fetch in Step 3c.

### Step 3c: Check for Failing CI (for PRs not in List C)

For each PR not in List C (DIRTY PRs have unreliable CI until conflicts are resolved), check its CI checks:

```bash
gh api "repos/{org}/{repo}/actions/runs?head_sha={headRefOid}&per_page=20" \
  -q '.workflow_runs[] | {workflow_id, run_number, conclusion}'
```

A PR has **failing CI** when any workflow's **latest run** (highest `run_number` per
`workflow_id`) has `conclusion == "failure"` or `conclusion == "timed_out"`.

**Why deduplicate by workflow:** When a workflow run fails and is rerun, the GitHub API
returns both the original failed run and the new rerun as separate entries with the same
`workflow_id` but different `run_number` values. Evaluating every historical run would
produce a false positive if an older run failed but a newer rerun passed. Deduplication
by keeping only the latest run per workflow mirrors the behavior of `gh pr checks`.

If failing CI is found, add the PR to **List D**.

### Step 3d: Summary

If all three lists are empty:

```
No PRs need attention.
```
Append `[silent]` and stop.

Print a summary before proceeding:

```
Found {A} PR(s) with unaddressed review findings, {C} PR(s) with merge conflicts, {D} PR(s) with failing CI:
  Review findings:  {for each in List A: "#{pr} — {title} ({org}/{repo})"}
  Merge conflicts:  {for each in List C: "#{pr} — {title} ({org}/{repo})"}
  Failing CI:       {for each in List D: "#{pr} — {title} ({org}/{repo})"}
```

---

## Step 4: Resolve Merge Conflicts

For each PR in List C, check out the branch in a worktree, merge the base branch,
resolve conflicts, validate, and push. Fully complete one PR (resolve → push → cleanup)
before moving to the next.

### Step 4a: Set Up Worktree

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} fetch origin
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

Branch slug = branch name with `/` replaced by `-`.

If the worktree already exists (prior interrupted run):
```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

### Step 4a.5: Detect Project Toolchain

From `{worktree-path}`, detect the project toolchain:

1. Scan the project root for config files:
   - `package.json` + lockfile → Node.js (detect manager: pnpm/yarn/npm/bun)
   - `Cargo.toml` → Rust
   - `go.mod` → Go
   - `pom.xml` → Java/Maven (use `./mvnw` wrapper if present, else `mvn`)
   - `build.gradle` / `build.gradle.kts` → Java/Gradle (use `./gradlew` wrapper if present, else `gradle`)
   - `pyproject.toml` / `setup.py` → Python
   - `Gemfile` → Ruby
   - `Makefile` → Generic Make

2. For Node.js: read `package.json` scripts for `test` and `lint`

3. Store detected commands:
   - **{lint command}**: e.g., `bun run lint`, `cargo clippy`, `golangci-lint run`
   - **{test command}**: e.g., `bun test`, `cargo test`, `go test ./...`, `pytest`

Refer to `references/toolchain-patterns.md` for the full detection lookup table.

### Step 4a.6: Claim PR Record (pre-work lock)

The conflict-resolution subagent dispatched next can run long enough to overlap with
another patch run (or a stale leftover claim from `/shipwright:review`, e.g. a
still-claimed `phase: "review"` record left behind after posting — the record stays
claimed until released or reaped). Without a pre-work claim, two overlapping patch runs
could both dispatch competing fix subagents against the same branch. Claim the PR record
with `phase: "patch"` now, before starting the merge/resolve, mirroring deploy.md's Step
4a pre-merge claim:

**Pre-Claim Fast Path (CBD-1.5).** If a pre-claim marker was captured in Step 2, validate
it against this site's live head before trusting it — the head can have moved since Step 2
(or since an earlier List's fix ran), so re-fetch fresh here rather than trusting the
Step 2 parse:

```bash
headRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```

- **`headRefOid == PRECLAIM_COMMIT_SHA`** (marker is current): trust it. Set
  `PR_RECORD_ID = PRECLAIM_RECORD_ID` and **skip this site's own `/prs/claim` call below**
  — the orchestrator's `/prs/claim` already holds this PR under `phase: "patch"`. Proceed
  directly to Step 4b (`PR_RECORD_ID` is reused by the post-fix update in Step 4c.5, same
  as the self-claim path).
- **`headRefOid != PRECLAIM_COMMIT_SHA`** (stale marker — new commits landed between the
  orchestrator's claim and now) **or no marker present**: fall back to self-claiming
  exactly as today — run the claim below unchanged.

```bash
HEAD_SHA_PRE_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
PR_CLAIM=$(curl -s -o /tmp/pr_claim_patch.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"$HEAD_SHA_PRE_PATCH\", \"phase\": \"patch\"}")
PR_RECORD_ID=$(jq -r '.id // empty' /tmp/pr_claim_patch.json)
```

**If `PR_CLAIM` is `409`** (another patch run already claimed this PR at phase `patch`):
do NOT dispatch the conflict-resolution subagent. Print:
```
⏸ PR #{pr} is already claimed by another patch run — skipping.
```
Skip the rest of Step 4 for this PR. Move to the next candidate PR in List C. If no
candidates remain, continue to Step 5.

**Otherwise** (`200` or `201`): the claim succeeded. `PR_RECORD_ID` is reused by the
post-fix update in Step 4c.5 — no second claim call is needed. Proceed to Step 4b.

### Step 4b: Dispatch Conflict Resolution Subagent

Renew the claim heartbeat now, before dispatching — conflict resolution can run long
enough on its own to threaten the claim TTL, in addition to the renewal after it
completes in Step 4c.5:

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"
```

Dispatch a `general-purpose` subagent via the Agent tool with this prompt:

```
You are resolving merge conflicts on a pull request. Merge the base branch, resolve all
conflicts, validate, and push.

PR: #{pr} — {title}
Repo: {org}/{repo}
Branch: {branch}
Base branch: {base}
Worktree: {worktree-path}

TOOLCHAIN:
  Lint command: {lint command}
  Test command: {test command}

INSTRUCTIONS — follow in order:

[A] Merge the base branch
  - From the worktree: `git merge origin/{base}`
  - This will produce conflict markers in the affected files

[B] Resolve conflicts
  - Read each conflicted file
  - Resolve conflicts by keeping the PR's changes where they don't overlap with base
    changes, and integrating base changes where they don't conflict with PR intent
  - If both sides changed the same logic, prefer the PR's intent — the PR author's
    changes are the goal; base is just catching up
  - Stage resolved files: `git add {file}`

[C] Validate
  - Run: {lint command}
  - Run: {test command}
  - Fix any failures introduced by the merge
  - Re-run until both pass cleanly

[D] Commit and push
  - Complete the merge: `git commit -m "Merge branch '{base}' into {branch}"`
    (or `git merge --continue` if git is waiting for a commit)
  - Push: `git push origin {branch}`

[E] Report back
  At the end, output:

  STATUS: DONE / DONE_WITH_CONCERNS / BLOCKED

  CONFLICTS_RESOLVED:
  {bullet list of each conflicted file and how it was resolved}

  CONCERNS: (if DONE_WITH_CONCERNS)
  BLOCKER: (if BLOCKED)
```

### Step 4c: Handle Subagent Status

Parse the subagent's STATUS:

- **DONE**: Record the conflicts resolved. Proceed to Step 4c.5 (upsert PR record).
- **DONE_WITH_CONCERNS**: Read concerns. If the push already happened, log concerns and
  proceed to Step 4c.5 (upsert PR record). If the subagent did not push, note it in the
  final report and skip Step 4c.5.
- **BLOCKED**: Release the pre-work claim from Step 4a.6 so a subsequent patch/review-patch
  run within the reaper's TTL is not 409-blocked by a stale `phase: "patch"` lock — the fix
  never completed, so nothing is actually in flight:
  ```bash
  [ -n "$PR_RECORD_ID" ] && curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"
  ```
  Log the blocker. Skip Steps 4c.5 and 4d. Move to the next PR in List C.
  Include the blocker in the final report.

### Step 4c.5: Upsert PR Record

The record was already claimed pre-work in Step 4a.6 — `PR_RECORD_ID` is already set, so
this renews the claim's heartbeat and increments `patchCycles` rather than re-claiming.
Warn and continue on any failure — do not stop.

```bash
if [ -n "$PR_RECORD_ID" ]; then
  curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat" || \
    echo "⚠ heartbeat renewal failed — continuing"
  HEAD_SHA_POST_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
  curl -sf -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/patch" \
    -d "{\"commitSha\": \"$HEAD_SHA_POST_PATCH\"}" > /dev/null 2>&1 || \
    echo "⚠ POST /prs/$PR_RECORD_ID/patch failed — continuing"
else
  echo "⚠ no PR_RECORD_ID from pre-work claim — skipping PR record update"
fi
```

Proceed to Step 4d (cleanup).

### Step 4d: Cleanup Worktree

After a successful push (subagent status DONE or DONE_WITH_CONCERNS with push completed):

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
```

---

## Step 5: Address Findings in Worktree

For each qualifying PR in List A, work through the fixes in sequence. Fully complete one
PR (fix → push → cleanup) before moving to the next.

### Step 5a: Set Up Worktree

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} fetch origin
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

Branch slug = branch name with `/` replaced by `-`.

If the worktree already exists (prior interrupted run):
```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

All subsequent steps for this PR run from `~/worktrees/{repo}-{branch-slug}/`.

### Step 5a.5: Detect Project Toolchain

From `{worktree-path}`, detect the project toolchain:

1. Scan the project root for config files:
   - `package.json` + lockfile → Node.js (detect manager: pnpm/yarn/npm/bun)
   - `Cargo.toml` → Rust
   - `go.mod` → Go
   - `pom.xml` → Java/Maven (use `./mvnw` wrapper if present, else `mvn`)
   - `build.gradle` / `build.gradle.kts` → Java/Gradle (use `./gradlew` wrapper if present, else `gradle`)
   - `pyproject.toml` / `setup.py` → Python
   - `Gemfile` → Ruby
   - `Makefile` → Generic Make

2. For Node.js: read `package.json` scripts for `test` and `lint`

3. Store detected commands:
   - **{lint command}**: e.g., `bun run lint`, `cargo clippy`, `golangci-lint run`
   - **{test command}**: e.g., `bun test`, `cargo test`, `go test ./...`, `pytest`

Refer to `references/toolchain-patterns.md` for the full detection lookup table.

From inside the worktree, collect the full picture of what needs fixing:

1. **PR diff against base**:
   ```bash
   base=$(gh pr view {pr} --repo {org}/{repo} --json baseRefName -q '.baseRefName')
   git diff "$base"...HEAD
   ```

2. **Unresolved inline threads** (from Step 3a — already fetched, reuse):
   Each thread with `isResolved == false` — include `id`, `path`, `line`, and comment body.

3. **Review body text**: for each COMMENTED or CHANGES_REQUESTED review from Step 3a
   with a non-empty `body`, include the full body text.

4. **PR-level comments** (from Step 3a — already fetched, reuse):
   Include all non-bot comments as additional context.

### Step 5a.6: Claim PR Record (pre-work lock)

The fix subagent dispatched next can run long enough to overlap with another patch run
(or a stale leftover claim from `/shipwright:review`, e.g. a still-claimed
`phase: "review"` record left behind after posting — the record stays claimed until
released or reaped). Without a pre-work claim, two overlapping patch runs could both
dispatch competing fix subagents against the same branch. Claim the PR record with
`phase: "patch"` now, before starting the fix, mirroring deploy.md's Step 4a pre-merge
claim:

**Pre-Claim Fast Path (CBD-1.5).** If a pre-claim marker was captured in Step 2, validate
it against this site's live head before trusting it — the head can have moved since Step 2
(or since List C's fix ran), so re-fetch fresh here rather than trusting the Step 2 parse:

```bash
headRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```

- **`headRefOid == PRECLAIM_COMMIT_SHA`** (marker is current): trust it. Set
  `PR_RECORD_ID = PRECLAIM_RECORD_ID` and **skip this site's own `/prs/claim` call below**
  — the orchestrator's `/prs/claim` already holds this PR under `phase: "patch"`. Proceed
  to Step 5a.7 (`PR_RECORD_ID` is reused by the post-fix update in Step 5c.5, same as the
  self-claim path).
- **`headRefOid != PRECLAIM_COMMIT_SHA`** (stale marker — new commits landed between the
  orchestrator's claim and now) **or no marker present**: fall back to self-claiming
  exactly as today — run the claim below unchanged.

```bash
HEAD_SHA_PRE_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
PR_CLAIM=$(curl -s -o /tmp/pr_claim_patch.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"$HEAD_SHA_PRE_PATCH\", \"phase\": \"patch\"}")
PR_RECORD_ID=$(jq -r '.id // empty' /tmp/pr_claim_patch.json)
```

**If `PR_CLAIM` is `409`** (another patch run already claimed this PR at phase `patch`):
do NOT dispatch the fix subagent. Print:
```
⏸ PR #{pr} is already claimed by another patch run — skipping.
```
Skip the rest of Step 5 for this PR. Move to the next qualifying PR in List A. If no
candidates remain, continue to Step 6.

**Otherwise** (`200` or `201`): the claim succeeded. `PR_RECORD_ID` is reused by the
post-fix update in Step 5c.5 — no second claim call is needed. Proceed to Step 5a.7.

### Step 5a.7: Second-Round Escalation Check (RPF-1.3)

RPF-1.1/1.2 let a REJECTed finding get rebutted (a PR-author comment posted via
`gh pr comment`) and `reviewState` reset to `pending` so a fresh review can re-evaluate the
rebuttal. If that fresh review still flags the same (or an equivalent) issue, another
rebuttal+reset cycle would repeat indefinitely — the reviewer and the fix subagent disagree,
and that is a genuine human-judgment deadlock, not something another automated pass will
resolve. Before dispatching the fix subagent (which is where RPF-1.1's rebuttal-comment step
lives, in Step 5b Instructions [D]), check whether this PR's List A finding is a *second*
round of the same disagreement.

For each qualifying review from Step 3a (`state == "COMMENTED"` or `"CHANGES_REQUESTED"`,
contributing to this PR's List A membership), check the PR-level
comments already fetched in Step 3a (`comments.nodes`) for an author reply: a comment whose
`author.login == CURRENT_USER` with `createdAt` **before** that review's `submittedAt`. This
mirrors `check-patch.ts`'s `isAddressedByAuthorReply` (an author reply *after* a review marks
that review addressed) but checks the opposite direction — a reply dated *before* the
current review means we already rebutted once, the reviewer looked at that rebuttal, and
still raised a finding this round.

**If any qualifying review has an author-reply comment dated before its `submittedAt`**
(second round on the same disagreement): escalate instead of looping. Skip the rest of Step
5 for this PR entirely — do not dispatch the fix subagent, do not post another rebuttal, and
do not reset `reviewState`.

1. Resolve the linked task from the PR record claimed in Step 5a.6:
   ```bash
   PR_TASK_ID=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID" | jq -r '.taskId // empty')
   ```
2. If `PR_TASK_ID` is non-empty, PATCH it to `hitl: true` so the task is flagged for a human
   decision:
   ```bash
   curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID" \
     -d '{"hitl": true}' > /dev/null 2>&1 || \
     echo "⚠ PATCH /tasks/$PR_TASK_ID hitl flag failed — continuing"
   ```
   If `PR_TASK_ID` is empty (no linked task on the PR record), log a warning and skip the
   PATCH — still post the PR comment below.
3. Post a single PR comment stating a human decision is needed. Write the body to a temp
   file first, same convention as the rebuttal comment in Step 5b [D] (heredocs break
   permission glob matching):
   ```bash
   # Write to /tmp/shipwright-patch-escalation-{pr}.txt:
   #   This finding was already rebutted once and the review still disagrees after
   #   re-evaluating that rebuttal — this looks like a genuine disagreement between the
   #   reviewer and the automated fix, not something another automated pass will resolve.
   #   Flagging for a human decision instead of rebutting again.
   gh pr comment {pr} --repo {org}/{repo} --body-file /tmp/shipwright-patch-escalation-{pr}.txt
   rm /tmp/shipwright-patch-escalation-{pr}.txt
   ```
   The temp file path MUST include the PR number to avoid collisions — `/tmp` is shared
   across all worktrees.
4. Resolve **all** currently-unresolved inline threads on this PR (from Step 3a's
   `reviewThreads.nodes[]`) — not just threads tied to the qualifying second-round review.
   Step 3a's query carries no field linking a thread back to the review that raised it
   (only `id`, `isResolved`, and the first comment's `author.login`/`body`/`path`/`line`),
   so scoping resolution to "threads belonging to" a specific review isn't something this
   step can actually determine. Escalating already means giving up on automated resolution
   for this cycle — the PR comment posted in step 3 above tells the human reader that
   everything was escalated for manual review, not silently fixed, so resolving every
   open thread here carries no silent-dismissal risk. Leaving any thread unresolved,
   however, would leave it `isResolved == false`, so Step 3a's List A criteria would
   re-flag this same PR next cycle and re-fire this same escalation indefinitely — the
   exact loop this step exists to close. Use the same mutation as Step 5b [D]/[E]:
   ```bash
   gh api graphql -f query='
   mutation {
     resolveReviewThread(input: {threadId: "{thread.id}"}) {
       thread { isResolved }
     }
   }'
   ```
   Run this for the Thread ID of every thread in Step 3a's `reviewThreads.nodes[]` with
   `isResolved == false`. If there are none, there is nothing to resolve — move on.
5. Release the pre-work claim from Step 5a.6 — no fix is in flight, this cycle intentionally
   stops short of dispatching one:
   ```bash
   curl -s -o /dev/null -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"
   ```
6. Print:
   ```
   ⏸ PR #{pr} — second-round disagreement detected, escalating to HITL (task {PR_TASK_ID or "none"}). Skipping rebuttal/reset for this cycle.
   ```
7. Move to the next qualifying PR in List A. If no candidates remain, continue to Step 6.

**Otherwise** (no qualifying review has an author-reply comment dated before its
`submittedAt` — a first-round rebuttal, or no rebuttal history at all): this is unaffected
by RPF-1.3 — proceed normally to Step 5b, and RPF-1.1/1.2 behavior applies as before.

### Step 5b: Dispatch Fix Subagent

Renew the claim heartbeat now, before dispatching — addressing review findings can run
long enough on its own to threaten the claim TTL, in addition to the renewal after it
completes in Step 5c.5:

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"
```

Dispatch a `general-purpose` subagent via the Agent tool with this prompt:

```
You are addressing review findings on a pull request. Apply fixes, validate, commit, push,
and resolve the addressed GitHub threads.

PR: #{pr} — {title}
Repo: {org}/{repo}
Branch: {branch}
Worktree: {worktree-path}

TOOLCHAIN:
  Lint command: {lint command}
  Test command: {test command}

REVIEW FINDINGS TO ADDRESS:

Review submissions (COMMENT/CHANGES_REQUESTED):
{for each review with state COMMENTED or CHANGES_REQUESTED and non-empty body:
  "- @{login} ({state}, submitted at {submittedAt}):
     {review body}"}

Unresolved inline threads:
{for each unresolved thread:
  "- Thread ID: {thread.id}
     {path}:{line} — {body}"}

PR-level comments:
{for each PR comment:
  "- @{login} ({createdAt}): {body}"}

PR DIFF (against base):
{git diff output gathered above}

INSTRUCTIONS — follow in order:

[A] Understand the findings
  - Read each review finding and inline thread carefully
  - Identify the files and lines that need changes
  - If a finding references a file/function not visible in the diff, read the file from the worktree

[A.5] Verify each finding before implementing it

  Reviewers can be wrong — misread code, incorrect flag semantics, bad API assumptions.
  Verify before acting:

  1. **Read the code**: Confirm the reviewer's premise holds. Read the file/function
     they reference to see if the issue they describe actually exists in the worktree.

  2. **Check external claims with WebSearch**: If the finding references behavior outside
     the project's own code — CLI flags, library APIs, framework defaults, language
     semantics — search to verify. Common false positives: flags that change request
     method, deprecated APIs, wrong argument order, version-specific behavior.

  3. **Classify each finding**:
     - **ACCEPT** — premise correct, prescription sound → implement as described
     - **MODIFY** — premise correct, but prescription is wrong → apply the correct fix
       and note what you changed and why
     - **REJECT** — premise incorrect → do not implement; include in CONCERNS with reason

  Only carry ACCEPTED and MODIFIED findings into [B].

[B] Apply fixes
  - Work file by file, addressing each ACCEPTED or MODIFIED finding
  - When a reviewer posted from a different agent login (not the same as the PR author),
    treat their findings with the same weight — the fix applies regardless of who reviewed
  - Do not introduce unrelated changes
  - If a finding is unclear or contradictory, apply the most conservative interpretation
    (preserve existing behavior; add the narrowest fix that satisfies the concern)

[C] Validate
  - Run: {lint command}
  - Run: {test command}
  - Fix any failures introduced by your changes
  - Re-run until both pass cleanly

[D] Commit
  These two conditions are independent — both can fire in the same run (a mixed
  ACCEPT+REJECT outcome), only the first can fire (all findings accepted/modified), only
  the second can fire (all findings rejected), or neither (nothing to do).

  - **If at least one finding was ACCEPTED or MODIFIED** (i.e. you have file changes
    staged):
    - Stage only the files you changed: `git add {changed files}`
    - Commit with a conventional commit message describing what was fixed:
      "fix: address review findings on #{pr} — {one-line summary of changes}"
    - Push: `git push origin {branch}`

  - **If any finding was classified REJECT in [A.5]** (regardless of whether other
    findings in the same run were ACCEPTED/MODIFIED and handled above): post a PR-level
    rebuttal comment explaining why each REJECTed finding was rejected, so the review is
    not left looking unaddressed. Write the comment body to a temp file first to avoid
    heredoc syntax in the command string (heredocs break permission glob matching and
    cause repeated approval prompts):
    ```bash
    # Write the rebuttal body to /tmp/shipwright-patch-rebuttal-{pr}.txt:
    #   Reviewed the finding(s) above and did not implement changes — premise did not hold:
    #
    #   - {finding summary}: {reason rejected}
    #   - {finding summary}: {reason rejected}
    gh pr comment {pr} --repo {org}/{repo} --body-file /tmp/shipwright-patch-rebuttal-{pr}.txt
    rm /tmp/shipwright-patch-rebuttal-{pr}.txt
    ```
    The temp file path MUST include the PR number to avoid collisions — `/tmp` is shared
    across all worktrees. List only the REJECTed findings, one bullet per finding, drawn
    from the CONCERNS you compiled in [A.5] — do not include ACCEPTED/MODIFIED findings
    here even if this run also produced a commit above. This comment is what allows a
    future patch run to recognize the review was addressed (rejected with reasoning, not
    ignored) instead of reflagging it forever.

    This only works for review-body-level findings, though — `hasUnaddressedFindings()`
    short-circuits to `true` whenever any unresolved **inline** thread exists, regardless
    of this comment. Since most real findings arrive as inline threads (`/shipwright:review`
    maps any `file:line` finding to an inline comment), also resolve the inline threads for
    the REJECTed findings now, right after posting the rebuttal comment:
    ```bash
    gh api graphql -f query='
    mutation {
      resolveReviewThread(input: {threadId: "{thread.id}"}) {
        thread { isResolved }
      }
    }'
    ```
    Run this for the Thread ID of every unresolved inline thread whose finding was
    REJECTed in [A.5] — the rebuttal comment you just posted is the explanation for why
    that thread is being resolved without a code change. Do this whether or not the
    commit/push condition above also fired in this same run.

[E] Resolve addressed inline threads
  PR-level comments cannot be resolved programmatically — skip them here.
  For each remaining unresolved **inline review thread** (listed under "Unresolved inline
  threads" above) whose finding was ACCEPTED or MODIFIED and fixed in [B], mark it
  resolved:
  ```bash
  gh api graphql -f query='
  mutation {
    resolveReviewThread(input: {threadId: "{thread.id}"}) {
      thread { isResolved }
    }
  }'
  ```
  Run this for each Thread ID whose finding was fixed. Threads for REJECTed findings were
  already handled by [D]'s rebuttal+resolve condition above, whenever at least one finding
  was REJECTed — do not process them again here. Skip only threads whose findings were
  genuinely inapplicable for some other reason (e.g., stale/already-fixed on main,
  unrelated to this PR) without a rebuttal explaining why — those stay unresolved. Do not
  attempt to resolve PR-level comments — they have no resolution mechanism.

[F] Report back
  At the end, output:

  STATUS: DONE / DONE_WITH_CONCERNS / BLOCKED

  FINDINGS_ADDRESSED:
  {bullet list of each finding addressed and how}

  CONCERNS: (if DONE_WITH_CONCERNS)
  {whenever CONCERNS lists any REJECTed finding — whether every finding was REJECT and no
  push happened, or this was a mixed ACCEPT+REJECT run where a push also happened —
  explicitly confirm here that the [D] rebuttal comment was posted AND that the inline
  threads for the REJECTed findings were resolved. All-REJECT example: "All findings
  rejected (premise incorrect) — no code changes; posted rebuttal comment via gh pr comment
  summarizing why each was rejected, and resolved the corresponding inline threads." Mixed
  example: "2 of 3 findings fixed and pushed (commit abc1234); 1 finding rejected (premise
  incorrect) — posted rebuttal comment via gh pr comment explaining why, and resolved that
  finding's inline thread." Otherwise, describe the correctness gap as usual.}
  BLOCKER: (if BLOCKED)
```

### Step 5c: Handle Subagent Status

Parse the subagent's STATUS:

- **DONE**: Record the findings addressed. A `DONE` status always followed a push (no-push
  cycles only ever report `DONE_WITH_CONCERNS` per Step 5b Instructions [D]), so this cycle
  does not qualify for the `reviewState` reset:
  ```bash
  NO_PUSH_REBUTTAL_CONFIRMED=false
  ```
  Proceed to Step 5c.5 (upsert PR record).
- **DONE_WITH_CONCERNS**: Read concerns. If any concern reports a REJECTed finding (per
  Step 5b Instructions [D], this fires whenever at least one finding was REJECTed —
  whether every finding in the run was REJECTed with no push at all, one branch of a mixed
  ACCEPT+REJECT run where a push also happened, or a mixed run where no push happened
  because every ACCEPTED/MODIFIED finding in that run resolved to a zero-diff no-op
  alongside the REJECTed one(s)), confirm the subagent's CONCERNS text reports both that it
  already posted the required `gh pr comment` rebuttal AND that it resolved the inline
  threads for the REJECTed findings. Both are needed — the rebuttal activates the
  `isAddressedByAuthorReply` escape hatch in `check-patch.ts`, but
  `hasUnaddressedFindings()` short-circuits to `true` on any unresolved inline thread before
  that escape hatch is even consulted, so the threads must also be resolved or the review
  stops being reflagged only for body-level findings, not inline ones (the common case).
  Do not post the comment here or resolve the threads here; Step 5c only verifies it
  already happened. If the report doesn't confirm both, treat it as a concern in the final
  report (the reflagging loop will otherwise persist regardless of which no-push variant
  produced it). For other, non-REJECT correctness-gap concerns, just log them in the
  report. Either way, always proceed to Step 5c.5 (upsert PR record) — when a push happened
  there IS a new commit SHA to record, and when no push happened Step 5c.5 still needs to
  run so it can reset `reviewState` to `pending` (see below), even though there is no new
  commit SHA. Carry forward into Step 5c.5 whether this cycle had no push
  (`HEAD_SHA_POST_PATCH` unchanged from before dispatch) with at least one REJECTed finding
  rebuttal-confirmed — regardless of whether every finding in the run was REJECTed — that's
  the condition that gates the `reviewState` reset there. Make this explicit by setting
  `NO_PUSH_REBUTTAL_CONFIRMED` before proceeding to Step 5c.5:
  ```bash
  if [ "$HEAD_SHA_POST_PATCH" = "$HEAD_SHA_PRE_PATCH" ] && \
     [ <at least one REJECTed finding this cycle, with rebuttal comment posted and its
        inline thread(s) resolved, per the confirmation check above> ]; then
    NO_PUSH_REBUTTAL_CONFIRMED=true
  else
    NO_PUSH_REBUTTAL_CONFIRMED=false
  fi
  ```
  The second condition is a judgment call from the subagent's STATUS/CONCERNS report, not a
  literal shell test — evaluate it the same way you just evaluated the "confirm ... rebuttal
  ... AND ... resolved the inline threads" check earlier in this bullet, then set the
  variable accordingly before Step 5c.5 reads it.
- **BLOCKED**: Release the pre-work claim from Step 5a.6 so a subsequent patch/review-patch
  run within the reaper's TTL is not 409-blocked by a stale `phase: "patch"` lock — the fix
  never completed, so nothing is actually in flight:
  ```bash
  [ -n "$PR_RECORD_ID" ] && curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"
  ```
  Log the blocker. Skip Steps 5c.5 and 5d. Move to the next qualifying PR.
  Include the blocker in the final report.

### Step 5c.5: Upsert PR Record

The record was already claimed pre-work in Step 5a.6 — `PR_RECORD_ID` is already set, so
this renews the claim's heartbeat and increments `patchCycles` rather than re-claiming.
Warn and continue on any failure — do not stop.

```bash
if [ -n "$PR_RECORD_ID" ]; then
  curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat" || \
    echo "⚠ heartbeat renewal failed — continuing"
  HEAD_SHA_POST_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
  curl -sf -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/patch" \
    -d "{\"commitSha\": \"$HEAD_SHA_POST_PATCH\"}" > /dev/null 2>&1 || \
    echo "⚠ POST /prs/$PR_RECORD_ID/patch failed — continuing"
  if [ "$NO_PUSH_REBUTTAL_CONFIRMED" = "true" ]; then
    curl -sf -X PATCH \
      -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
      -H "Content-Type: application/json" \
      "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID" \
      -d '{"reviewState": "pending"}' > /dev/null 2>&1 || \
      echo "⚠ PATCH /prs/$PR_RECORD_ID reviewState reset failed — continuing"
  fi
else
  echo "⚠ no PR_RECORD_ID from pre-work claim — skipping PR record update"
fi
```

`NO_PUSH_REBUTTAL_CONFIRMED` is assigned in Step 5c, before this step runs — see there for
the exact condition. It does not require every finding in the run to be REJECTed — a mixed
run where the ACCEPTED/MODIFIED findings all resolved to zero-diff no-ops still qualifies,
since what matters for the commit-SHA-based dedup is whether the SHA actually changed, not
how the findings were classified. The rest of this paragraph is the "why": in this no-push
case, `headRefOid` never changes, so without this reset the PR's `reviewState` would stay
at whatever the prior review left it and the PR could never re-qualify as a review
candidate in `check-review.ts`'s dedup — resetting it to `pending` here makes it re-qualify
despite the unchanged commit SHA, so a fresh review can evaluate the rebuttal and post an
actual APPROVE. Any cycle where a push did happen re-qualifies naturally via the changed
commit SHA, so the `reviewState` reset must not fire there.

Proceed to Step 5d (cleanup).

### Step 5d: Cleanup Worktree

After a successful push (subagent status DONE or DONE_WITH_CONCERNS with push completed):

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
```

---

## Step 6: Fix Failing CI in Worktree

For each PR in List D, set up a worktree, collect CI failure output, and dispatch a fix
subagent. Fully complete one PR (fix → push → cleanup) before moving to the next.

### Step 6a: Set Up Worktree

Same pattern as Step 5a — branch slug = branch name with `/` replaced by `-`:

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} fetch origin
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

If the worktree already exists:
```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

### Step 6a.5: Detect Project Toolchain

From `{worktree-path}`, detect the project toolchain:

1. Scan the project root for config files:
   - `package.json` + lockfile → Node.js (detect manager: pnpm/yarn/npm/bun)
   - `Cargo.toml` → Rust
   - `go.mod` → Go
   - `pom.xml` → Java/Maven (use `./mvnw` wrapper if present, else `mvn`)
   - `build.gradle` / `build.gradle.kts` → Java/Gradle (use `./gradlew` wrapper if present, else `gradle`)
   - `pyproject.toml` / `setup.py` → Python
   - `Gemfile` → Ruby
   - `Makefile` → Generic Make

2. For Node.js: read `package.json` scripts for `test` and `lint`

3. Store detected commands:
   - **{lint command}**: e.g., `bun run lint`, `cargo clippy`, `golangci-lint run`
   - **{test command}**: e.g., `bun test`, `cargo test`, `go test ./...`, `pytest`

Refer to `references/toolchain-patterns.md` for the full detection lookup table.

### Step 6b: Collect CI Failure Output

Find the most recent failing run on the PR's branch and collect its logs:

```bash
# Get the most recent failed run ID
RUN_ID=$(gh run list --branch {branch} --repo {org}/{repo} \
  --json databaseId,conclusion \
  --jq '[.[] | select(.conclusion == "failure")] | first | .databaseId')

# Collect failure logs (last 200 lines to keep context manageable)
gh run view "$RUN_ID" --log --failed --repo {org}/{repo} 2>&1 | tail -200
```

Store the log output for use in the subagent prompt.

### Step 6b.5: Claim PR Record (pre-work lock)

The fix subagent dispatched next can run long enough to overlap with another patch run
(or a stale leftover claim from `/shipwright:review`, e.g. a still-claimed
`phase: "review"` record left behind after posting — the record stays claimed until
released or reaped). Without a pre-work claim, two overlapping patch runs could both
dispatch competing fix subagents against the same branch. Claim the PR record with
`phase: "patch"` now, before starting the fix, mirroring deploy.md's Step 4a pre-merge
claim:

**Pre-Claim Fast Path (CBD-1.5).** If a pre-claim marker was captured in Step 2, validate
it against this site's live head before trusting it — the head can have moved since Step 2
(or since List C's/List A's fix ran), so re-fetch fresh here rather than trusting the
Step 2 parse:

```bash
headRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```

- **`headRefOid == PRECLAIM_COMMIT_SHA`** (marker is current): trust it. Set
  `PR_RECORD_ID = PRECLAIM_RECORD_ID` and **skip this site's own `/prs/claim` call below**
  — the orchestrator's `/prs/claim` already holds this PR under `phase: "patch"`. Proceed
  directly to Step 6c (`PR_RECORD_ID` is reused by the post-fix update in Step 6d.5, same
  as the self-claim path).
- **`headRefOid != PRECLAIM_COMMIT_SHA`** (stale marker — new commits landed between the
  orchestrator's claim and now) **or no marker present**: fall back to self-claiming
  exactly as today — run the claim below unchanged.

```bash
HEAD_SHA_PRE_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
PR_CLAIM=$(curl -s -o /tmp/pr_claim_patch.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"$HEAD_SHA_PRE_PATCH\", \"phase\": \"patch\"}")
PR_RECORD_ID=$(jq -r '.id // empty' /tmp/pr_claim_patch.json)
```

**If `PR_CLAIM` is `409`** (another patch run already claimed this PR at phase `patch`):
do NOT dispatch the fix subagent. Print:
```
⏸ PR #{pr} is already claimed by another patch run — skipping.
```
Skip the rest of Step 6 for this PR. Move to the next PR in List D. If no candidates
remain, continue to Step 7.

**Otherwise** (`200` or `201`): the claim succeeded. `PR_RECORD_ID` is reused by the
post-fix update in Step 6d.5 — no second claim call is needed. Proceed to Step 6c.

### Step 6c: Dispatch Fix Subagent

Renew the claim heartbeat now, before dispatching — fixing CI can run long enough on its
own to threaten the claim TTL, in addition to the renewal after it completes in Step 6d.5:

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"
```

Dispatch a `general-purpose` subagent via the Agent tool with this prompt:

```
You are fixing failing CI on a pull request. Diagnose the failures, apply fixes, validate locally, commit, and push.

PR: #{pr} — {title}
Repo: {org}/{repo}
Branch: {branch}
Worktree: {worktree-path}

TOOLCHAIN:
  Lint command: {lint command}
  Test command: {test command}

CI FAILURE OUTPUT (last 200 lines):
{log output from Step 6b}

INSTRUCTIONS — follow in order:

[A] Diagnose the failures
  - Read the CI failure output carefully
  - Identify which tests, lint rules, or build steps are failing
  - Read the relevant files from the worktree to understand the root cause

[B] Apply fixes
  - Work file by file, addressing each failure
  - Do not introduce unrelated changes
  - If a failure is caused by a flaky test or an external dependency, note it in concerns
    rather than patching around it

[C] Validate
  - Run: {lint command}
  - Run: {test command}
  - Fix any failures introduced by your changes
  - Re-run until both pass cleanly

[D] Commit
  - Stage only the files you changed: `git add {changed files}`
  - Commit with a conventional commit message describing what was fixed:
    "fix: resolve CI failures on #{pr} — {one-line summary of changes}"
  - Push: `git push origin {branch}`

[E] Report back
  At the end, output:

  STATUS: DONE / DONE_WITH_CONCERNS / BLOCKED

  FAILURES_FIXED:
  {bullet list of each CI failure addressed and how}

  CONCERNS: (if DONE_WITH_CONCERNS)
  BLOCKER: (if BLOCKED)
```

### Step 6d: Handle Subagent Status

Parse the subagent's STATUS:

- **DONE**: Record the failures fixed. Proceed to Step 6d.5 (upsert PR record).
- **DONE_WITH_CONCERNS**: Read concerns. If the push already happened, log concerns and
  proceed to Step 6d.5 (upsert PR record). If the subagent did not push, note it in the
  final report and skip Step 6d.5.
- **BLOCKED**: Release the pre-work claim from Step 6b.5 so a subsequent patch/review-patch
  run within the reaper's TTL is not 409-blocked by a stale `phase: "patch"` lock — the fix
  never completed, so nothing is actually in flight:
  ```bash
  [ -n "$PR_RECORD_ID" ] && curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"
  ```
  Log the blocker. Skip Steps 6d.5 and 6e. Move to the next PR in List D.
  Include the blocker in the final report.

### Step 6d.5: Upsert PR Record

The record was already claimed pre-work in Step 6b.5 — `PR_RECORD_ID` is already set, so
this renews the claim's heartbeat and increments `patchCycles` rather than re-claiming.
Warn and continue on any failure — do not stop.

```bash
if [ -n "$PR_RECORD_ID" ]; then
  curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat" || \
    echo "⚠ heartbeat renewal failed — continuing"
  HEAD_SHA_POST_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
  curl -sf -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/patch" \
    -d "{\"commitSha\": \"$HEAD_SHA_POST_PATCH\"}" > /dev/null 2>&1 || \
    echo "⚠ POST /prs/$PR_RECORD_ID/patch failed — continuing"
else
  echo "⚠ no PR_RECORD_ID from pre-work claim — skipping PR record update"
fi
```

Proceed to Step 6e (cleanup).

### Step 6e: Cleanup Worktree

After a successful push (subagent status DONE or DONE_WITH_CONCERNS with push completed):

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
```

---

## Step 7: Report

After processing all three lists, print a summary:

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
