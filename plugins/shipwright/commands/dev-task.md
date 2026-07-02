---
description: Execute the next ready task from the queue — build feature, simplify, verify, ship PR
---

# Dev Task

Pick the next ready task from the task store, build the feature, simplify, verify requirements, and ship a PR. Follow all steps in order.

**This command runs autonomously. Do not pause for user input unless a build or test failure cannot be auto-resolved.**

> **Task store setup:** This command reads from and writes to the Shipwright task store. If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke `/shipwright:task-store` for setup instructions.

---

## Step 0: Detect Project Toolchain

Auto-detect the project toolchain (run once, reuse throughout). Skip this step until the repo is known (Step 1 sets the repo).

## Step 1: Pick Task

**First, check for an interrupted task** — if a prior session left a task `in_progress`, resume it. The task-store list endpoint does not reliably scope bare `status=` queries by assignee for agent tokens with repo-level access, so filter to this agent's own tasks client-side — otherwise this can pick up (and start committing to) a task assigned to a completely different agent:

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=in_progress" \
  | jq --arg me "$SHIPWRIGHT_AGENT_ID" '.tasks | map(select(.assignee == $me))'
```

If the filtered result is non-empty, use the first task (`result[0]`). The Step 2 orphan check will clean up any stale branch/PR from the prior session before restarting. Print:

```
↩ Resuming interrupted task: {id} — {title}
```

Record `task_started_at` (current ISO timestamp) for metrics.

**If no in_progress task**, pick the next ready pending task:

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?ready=true" | jq '.tasks'
```

The command returns `pending` shipwright tasks whose dependencies are all satisfied, sorted by `addedAt`. Pick the first result from `.tasks`.

If the output is an empty JSON array (`[]`), respond `[silent]` and stop.

**Validate required fields.** If the selected task has no `branch` field (null, undefined, or empty string), do not proceed. Post:

```
⚠ Task {id} has no branch field set. Set it with:
  curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
    -d '{"branch": "feat/{id-lowercase}"}' | jq .
Then re-run /shipwright:dev-task.
```

Before stopping, mark the task blocked so the cron does not keep re-queuing it:

```bash
curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
  -d '{"status": "blocked"}' | jq .
```

Post the message above and stop. A missing branch cannot be recovered from at runtime — worktree creation will fail silently if attempted.

Print:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TASK: {id}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{title}
Session: {session} | Repo: {repo}
Layer:   {layer}   | Hours: {hours}
Deps:    {dependencies or "none"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Record `task_started_at` (current ISO timestamp) for metrics.

Now detect the project toolchain for `{repo}` (used throughout):

### 0b. Detect Project Toolchain

Auto-detect the project toolchain (run once, reuse throughout):

1. Scan the project root for config files:
   - `package.json` + lockfile → Node.js (detect manager: pnpm/yarn/npm/bun)
   - `Cargo.toml` → Rust
   - `go.mod` → Go
   - `pom.xml` → Java/Maven (use `./mvnw` wrapper if present, else `mvn`)
   - `build.gradle` / `build.gradle.kts` → Java/Gradle (use `./gradlew` wrapper if present, else `gradle`)
   - `pyproject.toml` / `setup.py` → Python
   - `Gemfile` → Ruby
   - `Makefile` → Generic Make

2. For Node.js: read `package.json` scripts for `validate`, `build`, `test`, `lint`, `typecheck`/`check`

3. Check for monorepo indicators

4. Store the detected commands:
   - **validate**: Full validation command (e.g., `pnpm validate`, `cargo clippy && cargo test`, `make check`)
   - **test**: Test command (e.g., `pnpm test`, `cargo test`, `go test ./...`, `pytest`)
   - **lint**: Lint command (e.g., `pnpm lint`, `cargo clippy`, `golangci-lint run`, `ruff check`)
   - **typecheck**: Type check command if applicable (e.g., `pnpm -r check`, `tsc --noEmit`)
   - **build**: Build command (e.g., `pnpm build`, `cargo build`, `go build ./...`)

Refer to `references/toolchain-patterns.md` for the full detection lookup table.


## Step 2: Mark In-Progress

### Orphan Check (prior session recovery)

If the task's current status is already `in_progress`:

1. Check for an orphaned branch: `git ls-remote --heads origin {branch}`
2. Check for an orphaned PR: `gh pr list --head {branch} --state open --json number,title`
3. If an orphaned PR exists, close it: `gh pr close {number} --comment "Shipwright cleanup — resuming task from prior session"`
4. If a remote branch exists, delete it: `git push origin --delete {branch}`
5. Print:
   ```
   ↩ Recovered orphaned session for {id}
   {If PR closed: "Closed PR #{number}"}
   {If branch deleted: "Deleted branch {branch}"}
   Starting fresh.
   ```

### Mark In-Progress

```bash
STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
  -d "{\"status\": \"in_progress\", \"startedAt\": \"$STARTED_AT\"}" | jq .
```

## Step 3: Build Feature-Dev Prompt

Construct the implementation prompt from the task fields in the task store:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMPLEMENTATION BRIEF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{title}

Description:
{description}

Acceptance Criteria:
{acceptanceCriteria items}

Layer: {layer}

AUTONOMOUS MODE: Proceed directly from discovery to
architecture to implementation. Auto-fix all quality issues.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Step 4: Set Up Worktree

All work happens in a worktree — see workspace `CLAUDE.md` for the convention. Branch slug = branch name with `/` replaced by `-`.

First, pull and check whether the branch already exists on the remote (indicates a bundled task joining an existing PR):

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} pull
git ls-remote --heads origin {branch}
```

**If the branch does NOT exist on remote** (new task, standard flow):
```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/main -b {branch}
```

**If the branch DOES exist on remote** (bundled task — joining an existing branch/PR):

First, check whether the remote branch belongs to a merged PR. The check runs before the worktree exists, so derive the repo from the git remote explicitly:

```bash
GH_REPO=$(git -C ${SHIPWRIGHT_REPO_DIR:-repos}/{repo} remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$||')
gh pr list --head {branch} --state merged --limit 1 --json number,title --repo "$GH_REPO"
```

**If a merged PR is found** (stale bundle branch — the branch was already merged and should not be reused):

Print a warning:
```
⚠ Branch {branch} has a merged PR (#{number}). Treating as stale — deleting remote branch and starting fresh from origin/main.
```

Then delete the stale remote branch:
```bash
git push origin --delete {branch}
```

Fall through to the standard fresh-start flow (same as branch-absent path):
```bash
git -C ${SHIPWRIGHT_REPO_DIR:-repos}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-worktrees}/{repo}-{branch-slug} origin/main -b {branch}
```

**If no merged PR** (open PR or no PR — genuine bundled task, joining an existing branch/PR):
```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} fetch origin
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch} --track -b {branch}
```

If the worktree already exists (interrupted prior run), remove it first regardless of branch status:
```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
# then run the appropriate add command above
```

All subsequent file operations and commands run from `${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug}/`.

Print:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
READY TO START
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Branch: {branch}
Task:   {id} — {title}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```


## Step 5: Dispatch Implementation Subagent

**TDD REQUIRED**: The subagent below must follow red-green-refactor. No production code is written before a failing test exists. Expected Tests in the brief are the starting point for the RED phase.

To preserve context quality for the post-implementation steps (Simplify, Spec Check, Requirements Verification), all implementation work is dispatched to a fresh subagent. Construct the subagent prompt from context already in session, then hand it off.

### 5a. Prepare Subagent Context

Before dispatching:
1. Read `CLAUDE.md` at project root (pass full contents to subagent)
2. Glob the worktree to identify the files most likely relevant to the task

### 5b. Dispatch Implementation Subagent

Dispatch a `general-purpose` subagent with this prompt (fill in all `{placeholders}` from context already collected). Pass `model: task.model ?? 'sonnet'` to the Agent() call so tasks can opt into a different model tier. At dispatch time, set `EFFECTIVE_MODEL = task.model ?? 'sonnet'` — this variable tracks the model the implementation subagent actually runs on, and is written back to the task store as `model` in Step 10a.

```
You are implementing a feature task. Follow TDD (red-green-refactor) strictly — write failing tests BEFORE writing implementation code.

Working directory: {worktree-path}
Do NOT create a new branch. Commit your work with conventional commit messages.

━━━━ IMPLEMENTATION BRIEF ━━━━
{Full implementation brief from Step 3}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PROJECT CONVENTIONS (from CLAUDE.md):
{CLAUDE.md contents}

TOOLCHAIN:
  Test command:     {test command from Step 0}
  Validate command: {validate command from Step 0}
  Typecheck:        {typecheck command from Step 0, or "none"}

INSTRUCTIONS — follow in order:

[A] Discovery
  - Glob the project structure and read the files most relevant to this task
  - Spawn the shipwright:researcher agent via the Agent tool, passing: task ID "{id}", title "{title}", description "{description}", layer "{layer}", and the project docs directory path
  - Use research output to inform architecture and patterns

[B] Architecture — use the simplest approach that fits existing patterns:
  Plan which files to create/modify and what patterns to follow.

[C] Testing — RED (Write failing tests first)
  {If Expected Tests are specified in the brief:
  "Start with these Expected Tests — write them exactly as specified, then run them to confirm they fail."}
  1. Detect the test framework from existing test files
  2. Follow test patterns found in nearby test files
  3. Write tests covering each acceptance criterion
  4. Run: {test command}
     → Tests MUST FAIL at this point. A test passing immediately means it is testing existing behavior or is incorrectly written — fix it.

[D] Implementation — GREEN (Make tests pass)
  1. Write minimal code to make the failing tests pass
  2. Follow CLAUDE.md conventions and existing codebase patterns
  3. Handle: {edge cases from planning doc}
  4. Apply: {error handling strategy from planning doc}
  5. Respect scope: {scope boundaries from planning doc}
  6. Run: {test command} — ALL tests must pass before continuing

[E] Refactor — Keep tests green
  1. Clean up: remove duplication, improve naming, simplify complexity
  2. No new behavior during refactor
  3. Rerun tests after each change — must stay green

[F] Validation
  1. Run: {validate command}
  2. Fix any errors
  3. {If Test Type specified: "Ensure a {test-type} test exists and passes"}

Commit all changes: use conventional commit format (e.g., "feat: {task title}")

━━━━ REPORT BACK ━━━━
At the end, output a block in this exact format:

STATUS: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED

CONCERNS: {if DONE_WITH_CONCERNS: describe them here}
BLOCKER:  {if BLOCKED: describe what is blocking you}
━━━━━━━━━━━━━━━━━━━━
```

### 5c. Handle Subagent Status

Parse the subagent's STATUS report:

- **DONE**: Proceed to Step 6.
- **DONE_WITH_CONCERNS**: Read the concerns. If they indicate correctness or scope gaps, address them before Step 6. If they are observations only (e.g., "this file is growing large"), note them and proceed.
- **NEEDS_CONTEXT**: Provide the missing context and re-dispatch with the same prompt augmented with the answer.
- **BLOCKED**: First, attempt a model upgrade: if the effective model (`task.model ?? 'sonnet'`) is 'haiku', re-dispatch with 'sonnet' and set `EFFECTIVE_MODEL = 'sonnet'`; if the effective model is 'sonnet', re-dispatch with 'opus' and set `EFFECTIVE_MODEL = 'opus'`. Re-dispatch the subagent once at the upgraded tier with the same prompt plus the blocker context appended. If still BLOCKED after the upgrade re-dispatch, or if the effective model is already 'opus', assess the blocker: if it is a context problem, provide more context; if the task is too large, break it into smaller sub-tasks; if the plan is wrong, escalate to the user.

> **CRITICAL — DO NOT SKIP STEPS 6–10**
> After the implementation subagent completes (Step 5), you MUST continue through ALL remaining steps: Simplify (6), Spec Compliance Check (6.5), Requirements Verification (7), Pre-Ship Checks (8), Auto-Refresh Docs (8.5), Push & PR (9), CI Gate (9b), Handoff (10). Do NOT stop or ask to run a separate workflow.

## Step 6: Simplify

After implementation completes, run a simplification pass:

1. Review `git diff main...HEAD` to see all changes on this branch
2. Look for and fix:
   - **DRY violations**: Duplicated code that should be extracted
   - **Dead code**: Unused imports, variables, or functions introduced
   - **Naming**: Unclear or inconsistent names
   - **Complexity**: Over-engineered solutions that can be simplified
   - **Consistency**: Patterns that don't match the rest of the codebase
3. Apply fixes using the Edit tool
4. **Tally simplify fixes**: After applying fixes, count how many were applied in each category:
   - `simplify_dry`: count of DRY violation fixes
   - `simplify_dead_code`: count of dead code removals
   - `simplify_naming`: count of naming improvements
   - `simplify_complexity`: count of complexity reductions
   - `simplify_consistency`: count of consistency fixes
   - `simplify_total`: sum of above
   Store these counts for the Step 10d handoff summary. If no fixes were needed, all counts are 0.
5. Run the detected typecheck command (if applicable) to verify types still pass after cleanup

---

## Step 6.5: Spec Compliance Check

Before creating a PR, launch an independent spec compliance subagent to verify the implementation actually satisfies the acceptance criteria. This is an independent review — the subagent has no knowledge of implementation decisions made in Step 7, only the spec and the diff.

**Dispatch a `general-purpose` subagent** with `model: 'haiku'` (spec compliance is a lightweight structured review) and this prompt:

```
You are performing a spec compliance review. Review the implementation diff against the acceptance criteria and report whether each criterion is MET, PARTIAL, or NOT MET.

Task: {task-id} — {task title}

Feature Overview:
{parent feature Overview section from Step 2}

Acceptance Criteria:
{each acceptance criterion from Step 2, as a list}

Implementation Diff:
{output of: git diff main...HEAD}

Implementation Decisions (context):
- Edge Cases: {edge cases from planning doc}
- Error Handling: {error handling from planning doc}
- Scope Boundaries: {scope boundaries from planning doc}

For each criterion, evaluate the diff and assign:
  MET     — clear evidence in the diff that this criterion is satisfied
  PARTIAL — partially implemented but incomplete
  NOT MET — no evidence of implementation in the diff

Respond with:
| Criterion | Status | Evidence |
|-----------|--------|----------|
{one row per criterion}

At the end, list any NOT MET criteria explicitly under "## Gaps Found".
If all criteria are MET, write "## All Criteria Met".
```

**Handle the result:**

- **All MET**: Proceed to Step 8.
- **Any NOT MET**:
  1. Fix the gaps (re-enter the implementation subagent from Step 5b with specific fix instructions)
  2. Run `{validate command}` to confirm the fix doesn't break existing tests
  3. Re-dispatch the spec compliance subagent to confirm all criteria are now MET
  4. Repeat until all are MET
- **PARTIAL**: Treat the same as NOT MET — auto-fix before proceeding.
---

## Step 7: Requirements Verification

Using the acceptance criteria extracted in Step 2, run `git diff main...HEAD` to see all changes on this branch.

For each acceptance criterion, evaluate against the diff:

| Status | Meaning |
|--------|---------|
| MET | Clear evidence in the diff that this criterion is satisfied |
| PARTIAL | Some progress but incomplete implementation |
| NOT MET | No evidence of implementation |
| UNVERIFIABLE | Cannot determine from code alone (e.g., "feels snappy") |

Present results in a table:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIREMENTS VERIFICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
{one row per criterion}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Tally requirement statuses**: Count the verdicts from the table above:
- `req_met`: count of MET criteria
- `req_partial`: count of PARTIAL criteria
- `req_not_met`: count of NOT_MET criteria
- `req_unverifiable`: count of UNVERIFIABLE criteria
- `req_total`: total criteria evaluated
Store these counts for the Step 10d handoff summary.

If any criterion is PARTIAL or NOT MET after the fix loop, mark the task blocked via the task store API:

```bash
curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
  -d '{"status": "blocked", "blockedReason": "requirements_not_met"}' | jq .
```
Stop.

## Step 8: Pre-Ship Checks

Run the detected validation commands from Step 0. For multi-ecosystem projects, run all applicable commands.

Examples based on detected toolchain:
- Node.js: `{manager} validate` (or `{manager} lint && {manager} test && {manager} build`)
- Rust: `cargo clippy --workspace -- -D warnings && cargo test --workspace`
- Go: `go vet ./... && go test ./...`
- Python: `pytest` (or `poetry run pytest`, `uv run pytest`)
- Ruby: `bundle exec rspec` (or `bundle exec rake test`)

### Coverage Gate

Run coverage checks for each package that has changed files on this branch:

1. **Detect changed packages**: From the diff, identify which packages/modules were modified
2. **Run tests with coverage**: Use the detected test command with coverage enabled (e.g., `--coverage` flag for most frameworks)
3. **Report**:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COVERAGE REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Package | Type | Lines | Branches | Target | Status |
|---------|------|-------|----------|--------|--------|
{one row per package+type}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Coverage threshold**: Use the threshold from the planning doc's Project Metadata (default: 90%).

**Capture coverage delta**: Record coverage measurements for metrics:
- `coverage_before`: If the test framework reports a baseline (e.g., from a prior run on main, or a coverage badge), use it. Otherwise, set to `null`.
- `coverage_after`: The line coverage percentage reported for changed packages (use the lowest package coverage if multiple).
- `coverage_delta`: `coverage_after - coverage_before` if both are available, otherwise `null`.
Store these values for the Step 10d handoff summary. Coverage measurement is best-effort — if the toolchain doesn't support baseline comparison, only `coverage_after` is populated.

If any coverage is below the threshold, log the warning and auto-proceed — do not stop.

Do NOT silently skip this check. Coverage must be measured and reported even if the user chooses to continue below threshold.

### Build & Lint

**Pause point (conditional):** Only if a check fails and cannot be auto-fixed, stop and let the user resolve.

## Step 8.5: Auto-Refresh Docs

Before pushing, check whether the changes on this branch made any `docs/*.md` stale, and if so, refresh them in a separate commit so the doc updates land in the same PR.

This step is always-on and self-no-ops cheaply when there are no docs to refresh — there is no flag to disable it.

### 8.5a. Dispatch the docs-refresher Agent

Use the Agent tool to dispatch the `shipwright:docs-refresher` agent with this prompt:

```
You are refreshing docs for the current branch.

Branch:    {branch}
Base ref:  main
Worktree:  ~/worktrees/{repo}-{branch-slug}

Follow your agent instructions exactly. Pre-filter docs by diff overlap, run the
staleness recipe on candidates, edit only stale sections, commit as
"docs: refresh ..." on this branch if anything was edited, and emit the
AUTO_DOCS_METRICS block at the end.

Do NOT push. The dev-task pipeline handles pushing in Step 9.
```

### 8.5b. Parse the Result

Parse the `AUTO_DOCS_METRICS` block from the agent's output. Extract:

- `auto_docs_updated`: boolean (`true` or `false`)
- `auto_docs_files_changed`: integer
- `auto_docs_lines_changed`: integer
- `auto_docs_skipped_reason`: string or null (one of: `null`, `"no_docs_dir"`, `"no_source_changes"`, `"no_stale_refs"`, `"commit_failed"`, `"agent_error"`)
- `auto_docs_commit_sha`: short SHA or null

**If no parseable `AUTO_DOCS_METRICS` block is found** — the agent crashed, hit a
tool error, ran out of turns, or emitted prose instead of the block — do NOT
stall and do NOT block the PR. Treat it as a recorded failure:

- `auto_docs_updated` = `false`
- `auto_docs_files_changed` = `0`
- `auto_docs_lines_changed` = `0`
- `auto_docs_skipped_reason` = `"agent_error"`
- `auto_docs_commit_sha` = `null`

Print `⚠ Docs refresh result unparseable — recording agent_error and continuing`,
then proceed normally so a broken refresher does not block the PR.

Store these values for the Step 10d handoff summary.

### 8.5c. Print Outcome

If `auto_docs_updated == true`:
```
✓ Docs refreshed: {auto_docs_files_changed} file(s), {auto_docs_lines_changed} lines ({auto_docs_commit_sha})
```

If `auto_docs_updated == false`:
```
⏭ Docs refresh skipped ({auto_docs_skipped_reason})
```

---

## Step 9: Push & PR

1. Run `git status` and `git diff --stat`
2. Push to remote (use `-u origin {branch}` if no upstream exists)

Check if a PR already exists for this branch:
```bash
gh pr list --head {branch} --state open --json number,url
```

**If a PR already exists** (bundled task — joining an existing PR):
- The push above added the commits to the existing branch/PR — no new PR needed
- Set `pr: {existing-pr-number}` and `prCreatedAt: "{ISO timestamp}"` in the task store for this task
- Print the existing PR URL
- Skip PR creation and proceed to Step 9b

**If no PR exists** (standard flow — create a new one):

Draft a PR body:

```
## Summary
- {1-3 bullet points summarizing the changes}

## Acceptance Criteria
{Copy the acceptance criteria table from Step 7, or list criteria from the task}

## Test Plan
- {Key test scenarios verified}
- [x] Pre-commit checks passing

Generated with [Claude Code](https://claude.com/claude-code)
```

**Write the PR body to a temp file** to avoid heredoc syntax in the command string (heredocs break permission glob matching and cause repeated approval prompts during `/dev-loop`):
```
Write the PR body content to /tmp/shipwright-pr-body-{task-id}.txt
gh pr create --title "{title}" --body-file /tmp/shipwright-pr-body-{task-id}.txt
rm /tmp/shipwright-pr-body-{task-id}.txt
```
The temp file path MUST include the task ID to avoid collisions — `/tmp` is shared across all worktrees.
Do NOT use `--body "$(cat <<'EOF'..."` — this produces a different command string each time and cannot be matched by `Bash(gh pr create:*)`.

Display the PR URL. Store it as `{pr-url}` for use in Step 9b.5.

### PR Failure Cleanup

If PR creation fails, OR if CI checks fail after max retries (Step 9b.5), after 2 retries:

1. Check for orphaned PRs on this branch:
   `gh pr list --head {branch} --state open --json number,title`

2. If orphaned PRs found, close each:
   `gh pr close {pr-number} --comment "Shipwright cleanup — PR creation/merge failed"`

3. Delete the remote branch (if it exists):
   `git push origin --delete {branch}`

4. Return to main and clean up local branch:
   `git checkout main && git branch -D {branch}`

5. Reset the task status in the planning doc from `[🔨]` back to `[ ]`

6. Commit: `chore: reset {task-id} after PR failure`

7. Print cleanup summary:
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CLEANUP: {task-id}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Closed PR(s): {list or "none"}
   Deleted branch: {branch}
   Task status: reset to [ ]
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```

This cleanup ensures no orphaned PRs or branches are left behind. Mark the task blocked via the task store API:

```bash
curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
  -d '{"status": "blocked", "blockedReason": "pr_creation_failed"}' | jq .
```
The execution cron will not pick it up until a human intervenes.

## Step 9b: CI Gate

After PR creation, update the branch from main and monitor GitHub Actions CI checks before proceeding.

### 9b.1. Update from Main

Merge the latest main into the PR branch to satisfy branch protection rules:

```
git fetch origin main
git merge origin/main
```

If the merge **succeeds** (no conflicts):

Check whether the merge actually brought in new commits:
```
git diff HEAD @{1} --quiet
```
If no changes (exit code 0 = already up to date), skip the push — CI is already running against the current code. Proceed directly to 9b.2.

If there are changes:
```
git push
```
The push triggers new CI runs against the updated code. Proceed to 9b.2.

If the merge produces **conflicts**: do NOT commit the merge. Instead, abort it (`git merge --abort`) and jump directly to 9b.4 (Fix Loop) with the conflict details as the failure context. The fix subagent will run `git merge origin/main`, resolve the conflicts, commit, and push.

### 9b.2. Wait for Checks

Use the GitHub Actions API — agent PATs do not have Checks API access, so `gh pr checks` will not work.

Resolve owner/repo and current HEAD SHA:
```bash
REPO=$(git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$||')
HEAD_SHA=$(git rev-parse HEAD)
```

Poll every 30 seconds for up to **10 minutes** (20 polls max). On each poll:
```bash
gh api "repos/$REPO/actions/runs?branch={branch}&per_page=10" \
  --jq '[.workflow_runs[] | select(.head_sha == "'$HEAD_SHA'") | {id, name, status, conclusion}]'
```

Filter to runs where `head_sha == HEAD_SHA`. Keep polling while any matching run has `status` of `queued`, `in_progress`, or `waiting`. If the poll times out at 10 minutes, treat it as a failure.

**No CI configured:** If no matching runs appear after 60 seconds (2 polls), skip the rest of Step 9b and proceed to Step 10. Print:
```
⏭ No CI checks configured — skipping CI gate
```

**All checks pass:** If all matching runs have `conclusion == "success"`, print and proceed to Step 10:
```
✓ CI checks passed
```

**Any check fails:** If any run has `conclusion != "success"` (e.g., `failure`, `cancelled`, `timed_out`), continue to 9b.3.

### 9b.3. Collect Failure Logs

Initialize: `ci_checks = []` (accumulates structured check data from each failed run; surfaced in the Step 10d handoff).

1. Get failed run IDs from the Actions API (reuse `$REPO` and `$HEAD_SHA` from 9b.2):
   ```bash
   gh api "repos/$REPO/actions/runs?branch={branch}&per_page=10" \
     --jq '.workflow_runs[] | select(.head_sha == "'$HEAD_SHA'" and .conclusion == "failure") | {id, name}'
   ```

2. For each failed run, get per-job results:
   `gh api "repos/$REPO/actions/runs/{run-id}/jobs" --jq '.jobs[] | {name, conclusion, steps: [.steps[] | select(.conclusion == "failure") | .name]}'`

3. For each failed run, get the logs (truncated to last 200 lines per run to avoid context blowup):
   `gh run view {run-id} --log --failed 2>&1 | tail -200`

Collect all failure output into a single context block for the fix subagent. If `--failed` is not supported by the installed `gh` version, fall back to `gh run view {run-id} --log 2>&1 | tail -200`.

4. **Record structured check data**: For each failed run, extract job names and conclusions into the `ci_checks` array: append each `{name: job.name, conclusion: job.conclusion}` to `ci_checks`.

5. **Record failure summary**: Append a one-line description of the CI failure to the `ci_failures[]` array (e.g., `"jest: 2 test suites failed"`, `"eslint: 4 lint errors in src/api/routes.ts"`, `"merge conflict with origin/main"`). Keep each entry under 100 characters.

### 9b.4. Fix Loop

Initialize: `ci_attempt = 0`, `ci_max_retries = 6`, `ci_fix_history = []` (accumulates a one-line summary of what each attempt tried).

While `ci_attempt < ci_max_retries`:

1. Increment `ci_attempt`.

2. Print:
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CI FIX: attempt {ci_attempt}/{ci_max_retries}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```

3. **Launch fix subagent** using the Agent tool:

   - **Type**: `general-purpose`
   - **Prompt**:
     ```
     You are fixing CI failures (or merge conflicts) on an open pull request.
     Do NOT create a new PR or branch. Fix the code on the current branch and push.

     Task: {task-id} — {task title}
     Branch: {branch}
     PR: #{pr-number}

     Current failure context:
     {If merge conflict: "Merging origin/main produced conflicts. Run `git merge origin/main`, resolve all conflicts, then commit and push."}
     {If CI failure: collected failure logs from 9b.3}

     {If ci_attempt > 1:}
     Previous fix attempts (do NOT repeat these — try a different approach):
     {ci_fix_history formatted as numbered list}

     PR diff (for context):
     {output of gh pr diff {pr-number}}

     Instructions:
     1. Analyze the failure logs (or conflict markers) to identify the root cause
     2. Read the relevant source files
     3. Fix the failing code, tests, or merge conflicts — if a previous attempt already tried an approach that didn't work, take a different angle
     4. Run the project's local validation commands to confirm the fix
     5. Commit with message: "fix: {brief description}"
     6. Push to the branch: git push
     ```

4. After the subagent completes, **append a one-line summary** of what this attempt tried to `ci_fix_history` (e.g., `"Attempt 1: updated failing snapshot in UserCard.test.tsx"`, `"Attempt 2: fixed type error in api/auth.ts — wrong return type"`).

5. **Loop back to 9b.1** — update from main again (main may have moved while the fix was in progress), then re-wait for CI in 9b.2.

5. **All checks pass:** Break the loop. Print:
   ```
   ✓ CI checks passed (after {ci_attempt} fix attempt(s))
   ```
   Proceed to Step 10.

6. **Checks still failing:** Collect new failure logs (repeat 9b.3) and continue the loop.

### 9b.5. Max Retries Exhausted

If `ci_attempt >= ci_max_retries` and checks are still failing:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CI GATE FAILED: {task-id}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{ci_max_retries} fix attempts exhausted.
Failing checks:
  {list of still-failing check names}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**When merge-mode is OFF (standalone):**
Run PR Failure Cleanup (Step 9) and stop. Mark the task blocked via the task store API:

```bash
curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
  -d '{"status": "blocked", "blockedReason": "ci_max_retries_exhausted"}' | jq .
```

## Step 10: Update Queue & Handoff

### 10a. Update Queue

```bash
PR_CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
  -d "{\"status\": \"pr_open\", \"pr\": {pr_number}, \"prCreatedAt\": \"$PR_CREATED_AT\", \"ciFixAttempts\": {ci_attempt}, \"simplifyTotal\": {simplify_total}, \"simplifyDry\": {simplify_dry}, \"simplifyDeadCode\": {simplify_dead_code}, \"simplifyNaming\": {simplify_naming}, \"simplifyComplexity\": {simplify_complexity}, \"simplifyConsistency\": {simplify_consistency}, \"coverageDelta\": {coverage_delta}, \"model\": \"{EFFECTIVE_MODEL}\"}" | jq .
```

### 10d. Print Handoff

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DONE: {id}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PR: #{pr_number} — {pr_url}
Simplify: {simplify_total} fixes
CI:       {Pass | {ci_fix_attempts} fix attempt(s)}
Coverage: {coverage_before}% → {coverage_after}%
Reqs:     {req_met}/{req_total} met
Docs:     {if updated: "{auto_docs_files_changed} file(s), {auto_docs_lines_changed} lines" | "skipped ({auto_docs_skipped_reason})"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
