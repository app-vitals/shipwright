---
description: Address unresolved review findings, BEHIND branches, merge conflicts, and failing CI on own open PRs — queries GitHub directly, fixes in worktree, pushes
---

# Patch

Scan own open PRs for four conditions: unaddressed review/PR comments, branches BEHIND
main that the precheck could not auto-update, merge conflicts with base, and failing CI.
For each PR, apply the appropriate fix. Goes silent when nothing needs addressing.

> **Note:** The patch precheck (`check-patch.ts`) attempts to auto-update BEHIND branches
> via `gh pr update-branch` before this skill runs. If the auto-update succeeds, the PR
> does not appear in List B. If it fails (e.g., transient error), `check-patch.ts` exits 0
> and this skill handles the stuck-BEHIND branch in Step 7.

**This command runs autonomously. Do not pause for user input.**

---

## Step 1: Get Own GH Login

Resolve the current GitHub CLI user once and remember the value — substitute it directly
into all subsequent commands that need it:

```bash
CURRENT_USER=$(gh api /user -q '.login')
```

---

## Step 2: Discover Own Open PRs

Resolve the list of repos to scan. Use the same resolver as other shipwright commands:

```bash
REPOS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/repo" | jq -r '.repo // empty')
```

This returns a single repo. Iterate over the result to scan it.

For each repo, fetch open PRs authored by `CURRENT_USER`:

```bash
gh pr list --state open --repo {org}/{repo} \
  --author "$CURRENT_USER" \
  --json number,title,headRefName,headRefOid,additions,deletions,mergeStateStatus
```

Collect all results into a unified list of PRs with their `org`, `repo`, `number`,
`title`, `headRefName`, and `headRefOid`.

If no own open PRs are found across all repos:
```
No own open PRs found.
```
Append `[silent]` and stop.

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

## Step 3: Classify PRs into Four Lists

Check each PR against all four conditions independently. A PR may appear in multiple lists.

- **List A** — PRs with unresolved review or PR comments
- **List B** — PRs that are BEHIND main and could not be auto-updated by the precheck
- **List C** — PRs with merge conflicts (DIRTY)
- **List D** — PRs with failing CI

Work through all PRs before continuing. When a PR appears in multiple lists, all applicable fixes run — processed in the order the steps execute (C → A → D → B).

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
- At least one review with `state == "COMMENTED"` or `state == "CHANGES_REQUESTED"` has a non-empty `body` (a review body without matching inline threads is itself a finding)

A PR has **no findings** (skip it) when ALL of the following are true:
- All inline threads are resolved (`isResolved == true` for every thread)
- No COMMENTED or CHANGES_REQUESTED review has a non-empty body

If neither condition applies (e.g., no reviews at all, only approved reviews), skip the PR —
it does not belong in List A.

If a PR has unaddressed findings, add it to **List A**. Store the unresolved threads (with their
`id` — needed for the `resolveReviewThread` mutation in Step 5) and review bodies for use in
Step 5.

### Step 3b: Check for BEHIND or DIRTY State

For each PR, check its merge state:

```bash
gh pr view {pr} --repo {org}/{repo} --json mergeStateStatus
```

- If `mergeStateStatus` is `"BEHIND"` → add to **List B**
- If `mergeStateStatus` is `"DIRTY"` → add to **List C**

Store the fetched `mergeStateStatus` — do not re-fetch in Step 3c.

### Step 3c: Check for Failing CI (for PRs not in List C)

For each PR not in List C (DIRTY PRs have unreliable CI until conflicts are resolved), check its CI checks:

```bash
gh api "repos/{org}/{repo}/actions/runs?branch={branch}&per_page=10" \
  -q '.workflow_runs[] | select(.head_sha == "{headRefOid}") | "\(.name): \(.status) \(.conclusion)"'
```

A PR has **failing CI** when at least one workflow run matching the current HEAD SHA has
`conclusion == "failure"` or `conclusion == "timed_out"`.

If failing CI is found, add the PR to **List D**.

### Step 3d: Summary

If all four lists are empty:

```
No PRs need attention.
```
Append `[silent]` and stop.

Print a summary before proceeding:

```
Found {A} PR(s) with unaddressed review findings, {B} PR(s) BEHIND main (not auto-updated), {C} PR(s) with merge conflicts, {D} PR(s) with failing CI:
  Review findings:  {for each in List A: "#{pr} — {title} ({org}/{repo})"}
  Behind main:      {for each in List B: "#{pr} — {title} ({org}/{repo})"}
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

### Step 4b: Dispatch Conflict Resolution Subagent

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

- **DONE**: Record the conflicts resolved. Proceed to Step 4d (cleanup).
- **DONE_WITH_CONCERNS**: Read concerns. If the push already happened, log concerns and
  continue. If the subagent did not push, note it in the final report.
- **BLOCKED**: Log the blocker. Skip cleanup. Move to the next PR in List C.
  Include the blocker in the final report.

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

### Step 5b: Dispatch Fix Subagent

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
  - Stage only the files you changed: `git add {changed files}`
  - Commit with a conventional commit message describing what was fixed:
    "fix: address review findings on #{pr} — {one-line summary of changes}"
  - Push: `git push origin {branch}`

[E] Resolve addressed inline threads
  PR-level comments cannot be resolved programmatically — skip them here.
  For each unresolved **inline review thread** (listed under "Unresolved inline threads"
  above) that was addressed, mark it resolved:
  ```bash
  gh api graphql -f query='
  mutation {
    resolveReviewThread(input: {threadId: "{thread.id}"}) {
      thread { isResolved }
    }
  }'
  ```
  Run this for each Thread ID that was addressed. Skip threads whose findings were not
  applicable or were not addressed. Do not attempt to resolve PR-level comments — they
  have no resolution mechanism.

[F] Report back
  At the end, output:

  STATUS: DONE / DONE_WITH_CONCERNS / BLOCKED

  FINDINGS_ADDRESSED:
  {bullet list of each finding addressed and how}

  CONCERNS: (if DONE_WITH_CONCERNS)
  BLOCKER: (if BLOCKED)
```

### Step 5c: Handle Subagent Status

Parse the subagent's STATUS:

- **DONE**: Record the findings addressed. Proceed to Step 5d (cleanup).
- **DONE_WITH_CONCERNS**: Read concerns. If they are correctness gaps, log them in the
  report but proceed (the push already happened). If the subagent did not push due to
  a concern, note it and include it in the final report.
- **BLOCKED**: Log the blocker. Skip cleanup. Move to the next qualifying PR.
  Include the blocker in the final report.

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

### Step 6c: Dispatch Fix Subagent

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

- **DONE**: Record the failures fixed. Proceed to Step 6e (cleanup).
- **DONE_WITH_CONCERNS**: Read concerns. If the push already happened, log concerns and
  continue. If the subagent did not push, note it in the final report.
- **BLOCKED**: Log the blocker. Skip cleanup. Move to the next PR in List D.
  Include the blocker in the final report.

### Step 6e: Cleanup Worktree

After a successful push (subagent status DONE or DONE_WITH_CONCERNS with push completed):

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
```

---

## Step 7: Update BEHIND Branches

For each PR in List B (branches that are BEHIND base and could not be auto-updated by
the precheck), set up a worktree, attempt a merge, validate, and push. Fully complete
one PR before moving to the next.

### Step 7a: Set Up Worktree

Same pattern as Step 5a — branch slug = branch name with `/` replaced by `-`:

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} fetch origin
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

If the worktree already exists (prior interrupted run):
```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

### Step 7a.5: Detect Project Toolchain

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

### Step 7b: Attempt Auto-Update

Try a fast-path update via the GitHub API:

```bash
gh pr update-branch {number} --repo {org}/{repo}
```

- **Succeeds (exit 0)**: Branch updated cleanly. Proceed to Step 7e (cleanup).
- **Fails (non-zero exit)**: GitHub could not auto-merge. Proceed to Step 7c to dispatch
  a subagent for a manual merge.

### Step 7c: Dispatch Update Subagent

Dispatch a `general-purpose` subagent via the Agent tool with this prompt:

```
You are updating a branch that is behind its base. Merge the base branch, validate,
and push.

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
  - If there are unresolvable conflicts, report BLOCKED — do not force-push or
    discard changes

[B] Validate
  - Run: {lint command}
  - Run: {test command}
  - Fix any failures introduced by the merge
  - Re-run until both pass cleanly

[C] Push
  - Push: `git push origin {branch}`

[D] Report back
  At the end, output:

  STATUS: DONE / DONE_WITH_CONCERNS / BLOCKED

  CONCERNS: (if DONE_WITH_CONCERNS)
  BLOCKER: (if BLOCKED — include conflict details)
```

### Step 7d: Handle Subagent Status

Parse the subagent's STATUS:

- **DONE**: Record the update. Proceed to Step 7e (cleanup).
- **DONE_WITH_CONCERNS**: Log concerns. If the push already happened, continue.
- **BLOCKED**: Log the blocker. Skip cleanup. Move to the next PR in List B.
  Include the blocker in the final report.

### Step 7e: Cleanup Worktree

After a successful push (subagent status DONE or DONE_WITH_CONCERNS with push completed):

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
```

---

## Step 8: Report

After processing all four lists, print a summary:

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

BEHIND MAIN ({B} PR(s)):
{for each PR in List B:
  "#{pr} — {title} ({org}/{repo})
   {if DONE or DONE_WITH_CONCERNS with push: "✓ Updated and pushed"}
   {if BLOCKED: "✗ Blocked: {blocker summary}"}
   {if DONE_WITH_CONCERNS: "⚠ Concerns: {concern summary}"}"}

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
