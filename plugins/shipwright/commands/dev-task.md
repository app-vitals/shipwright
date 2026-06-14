---
description: Execute the next ready task from the queue — build feature, simplify, verify, ship PR
---

# Dev Task

Pick the next ready task from `state/todos.json`, build the feature, simplify, verify requirements, and ship a PR. Follow all steps in order.

**This command runs autonomously. Do not pause for user input unless a build or test failure cannot be auto-resolved.**

---

## Step 0: Detect Project Toolchain

Auto-detect the project toolchain (run once, reuse throughout). Skip this step until the repo is known (Step 1 sets the repo).

## Step 1: Pick Task

**First, check for an interrupted task** — if a prior session left a task `in_progress`, resume it:

```bash
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
CURRENT_USER=$(gh api graphql -f "query=query{viewer{login}}" --jq '.data.viewer.login' 2>/dev/null)
bun "$PLUGIN_SCRIPTS/task_store.ts" query --status in_progress ${CURRENT_USER:+--assignee "$CURRENT_USER"}
```

If the result is a non-empty array, use the first task returned. The Step 2 orphan check will clean up any stale branch/PR from the prior session before restarting. Print:

```
↩ Resuming interrupted task: {id} — {title}
```

Record `task_started_at` (current ISO timestamp) for metrics.

**If no in_progress task**, pick the next ready pending task:

```bash
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
CURRENT_USER=$(gh api graphql -f "query=query{viewer{login}}" --jq '.data.viewer.login' 2>/dev/null)
bun "$PLUGIN_SCRIPTS/task_store.ts" query --ready ${CURRENT_USER:+--assignee "$CURRENT_USER"}
```

The command returns `pending` shipwright tasks whose dependencies are all satisfied, sorted by `addedAt`. Pick the first result.

If the output is an empty JSON array (`[]`), respond `[silent]` and stop.

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

**Snapshot the Claude Code session JSONL for token tracking:**

```bash
# Find the most recently modified JSONL in ~/.claude/projects/
JSONL_SNAPSHOT_PATH=$(ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -1)
JSONL_SNAPSHOT_LINES=$(wc -l < "$JSONL_SNAPSHOT_PATH" 2>/dev/null || echo 0)
EFFORT_LEVEL=$(echo $ANTHROPIC_EFFORT_LEVEL)
CLAUDE_MODEL=$(echo $CLAUDE_MODEL)
```

Store `JSONL_SNAPSHOT_PATH`, `JSONL_SNAPSHOT_LINES`, `EFFORT_LEVEL`, and `CLAUDE_MODEL` as variables for use in Step 10b. These are best-effort — if the JSONL path is empty or unreadable, all token fields will emit as `null`. Claude Code sets `$CLAUDE_MODEL` to the active model ID (e.g. `claude-sonnet-4-6`). If not set or not in the pricing table, `cost_usd` emits as `null`.

Each PostHog call in this task is self-contained: it resolves the script path inline and silently skips if the script is not found. No shell variable is shared between steps.

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
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
bun "$PLUGIN_SCRIPTS/task_store.ts" update --id {id} --set startedAt={ISO timestamp} --set status=in_progress
```

Fire `shipwright_task_started` — re-resolve the script path inline:

```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && python3 "$POSTHOG_SCRIPT" shipwright_task_started \
  --project {repo} --task {id} --ts "{task_started_at}" \
  title="{title}" layer="{layer}" estimated_h={hours} session="{session}"
```

## Step 3: Build Feature-Dev Prompt

Construct the implementation prompt from the task fields in `state/todos.json`:

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

Dispatch a `general-purpose` subagent with this prompt (fill in all `{placeholders}` from context already collected):

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
  - Extract the ### Metrics block from research output — include it verbatim in your STATUS report at the end

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

RESEARCH_METRICS:
{paste the ### Metrics block verbatim from the research agent output}

CONCERNS: {if DONE_WITH_CONCERNS: describe them here}
BLOCKER:  {if BLOCKED: describe what is blocking you}
━━━━━━━━━━━━━━━━━━━━
```

### 5c. Handle Subagent Status

Parse the subagent's STATUS report:

- **DONE**: Store the RESEARCH_METRICS block for Step 10b. Proceed to Step 6.
- **DONE_WITH_CONCERNS**: Read the concerns. If they indicate correctness or scope gaps, address them before Step 6. If they are observations only (e.g., "this file is growing large"), note them and proceed.
- **NEEDS_CONTEXT**: Provide the missing context and re-dispatch with the same prompt augmented with the answer.
- **BLOCKED**: Assess the blocker. If it is a context problem, re-dispatch with more context. If the task is too large, break it into smaller sub-tasks. If the plan is wrong, escalate to the user.

Extract from RESEARCH_METRICS for Step 10b: `docs_scanned`, `docs_selected`, `docs_loaded` (as JSON array), `web_search` (boolean), `web_queries` (integer).

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
   Store these counts for use in Step 10b metrics. If no fixes were needed, all counts are 0.
5. Run the detected typecheck command (if applicable) to verify types still pass after cleanup

Fire `shipwright_simplify_complete` — always fire, even if all counts are 0 (signals phase completion regardless of fix count). Re-resolve the script path inline so this step does not depend on shell state from Step 6b:

```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && python3 "$POSTHOG_SCRIPT" shipwright_simplify_complete \
  --project {project} --task {task_id} \
  total={simplify_total} dry={simplify_dry} dead_code={simplify_dead_code} \
  naming={simplify_naming} complexity_fixes={simplify_complexity} consistency={simplify_consistency}
```

---

## Step 6.5: Spec Compliance Check

Before creating a PR, launch an independent spec compliance subagent to verify the implementation actually satisfies the acceptance criteria. This is an independent review — the subagent has no knowledge of implementation decisions made in Step 7, only the spec and the diff.

**Dispatch a `general-purpose` subagent** with this prompt:

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
Store these counts for use in Step 10b metrics.

If any criterion is PARTIAL or NOT MET after the fix loop, mark the task blocked via task_store.ts, then fire `shipwright_task_blocked`:

```bash
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
bun "$PLUGIN_SCRIPTS/task_store.ts" update --id {id} --set blockedReason=requirements_not_met --set status=blocked
```

```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && python3 "$POSTHOG_SCRIPT" shipwright_task_blocked \
  --project {project} --task {task_id} reason="requirements_not_met"
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
Store these values for use in Step 10b metrics. Coverage measurement is best-effort — if the toolchain doesn't support baseline comparison, only `coverage_after` is populated.

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
then proceed normally (the PostHog event in 8.5d and the metrics line in Step
10b still fire with these values, so a broken refresher is visible in `/metrics`
rather than silently bucketed as a legacy record).

Store these values for use in Step 10b metrics.

### 8.5c. Print Outcome

If `auto_docs_updated == true`:
```
✓ Docs refreshed: {auto_docs_files_changed} file(s), {auto_docs_lines_changed} lines ({auto_docs_commit_sha})
```

If `auto_docs_updated == false`:
```
⏭ Docs refresh skipped ({auto_docs_skipped_reason})
```

### 8.5d. Fire PostHog Event

Fire `shipwright_auto_docs` — re-resolve the script path inline:

```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && python3 "$POSTHOG_SCRIPT" shipwright_auto_docs \
  --project {project} --task {task_id} \
  updated={auto_docs_updated} files_changed={auto_docs_files_changed} \
  lines_changed={auto_docs_lines_changed} skipped_reason="{auto_docs_skipped_reason}"
```

If the skipped_reason is `null`, pass the literal string `null` rather than an empty string.

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
- Set `pr: {existing-pr-number}` and `prCreatedAt: "{ISO timestamp}"` in todos.json for this task
- Print the existing PR URL
- Skip to the `shipwright_pr_created` PostHog event below (still fire it so metrics are captured)

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

5. Fire `shipwright_pr_created` — re-resolve the script path inline:

```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && python3 "$POSTHOG_SCRIPT" shipwright_pr_created \
  --project {project} --task {task_id} \
  pr={pr_number} files_changed={files_changed}
```

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

This cleanup ensures no orphaned PRs or branches are left behind. Mark the task blocked via task_store.ts, then fire `shipwright_task_blocked`:

```bash
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
bun "$PLUGIN_SCRIPTS/task_store.ts" update --id {id} --set blockedReason=pr_creation_failed --set status=blocked
```

```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && python3 "$POSTHOG_SCRIPT" shipwright_task_blocked \
  --project {project} --task {task_id} reason="pr_creation_failed"
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
Then fire `shipwright_ci_result` with `no_ci=true` to record that CI was not present for this task:
```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && python3 "$POSTHOG_SCRIPT" shipwright_ci_result \
  --project {project} --task {task_id} \
  passed_first_try=true fix_attempts=0 'failures=[]' no_ci=true
```

**All checks pass:** If all matching runs have `conclusion == "success"`, print and proceed to Step 10:
```
✓ CI checks passed
```

Fire `shipwright_ci_result` (pass case) — re-resolve the script path inline:
```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && python3 "$POSTHOG_SCRIPT" shipwright_ci_result \
  --project {project} --task {task_id} \
  passed_first_try=true fix_attempts=0 'failures=[]'
```

**Any check fails:** If any run has `conclusion != "success"` (e.g., `failure`, `cancelled`, `timed_out`), continue to 9b.3.

### 9b.3. Collect Failure Logs

Initialize: `ci_checks = []` (accumulates structured check data from each failed run; written to metrics in Step 10b as `ci.checks`).

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

4. **Record structured check data**: For each failed run, extract job names and conclusions into the `ci_checks` array: append each `{name: job.name, conclusion: job.conclusion}` to `ci_checks`. This array is written to metrics in Step 10b as `ci.checks`.

5. **Record failure summary**: Append a one-line description of the CI failure to the `ci_failures[]` array (e.g., `"jest: 2 test suites failed"`, `"eslint: 4 lint errors in src/api/routes.ts"`, `"merge conflict with origin/main"`). Keep each entry under 100 characters. This array is written to metrics in Step 10b.

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
   Fire `shipwright_ci_result` (pass after fixes) — re-resolve the script path inline:
   ```bash
   POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
   [ -n "$POSTHOG_SCRIPT" ] && python3 "$POSTHOG_SCRIPT" shipwright_ci_result \
     --project {project} --task {task_id} \
     passed_first_try=false fix_attempts={ci_attempt} "failures={ci_failures_json_array}"
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
Run PR Failure Cleanup (Step 9) and stop. Mark the task blocked via task_store.ts, then fire `shipwright_task_blocked`:

```bash
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
bun "$PLUGIN_SCRIPTS/task_store.ts" update --id {id} --set blockedReason=ci_max_retries_exhausted --set status=blocked
```

```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && python3 "$POSTHOG_SCRIPT" shipwright_task_blocked \
  --project {project} --task {task_id} reason="ci_max_retries_exhausted"
```

## Step 10: Update Queue & Metrics

### 10a. Update Queue

```bash
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
bun "$PLUGIN_SCRIPTS/task_store.ts" update --id {id} --set pr={pr_number} --set prCreatedAt={ISO timestamp} --set status=pr_open
```

### 10b. Append Metrics

Append one JSONL line to `planning/{session}/metrics.jsonl` (create the file if it doesn't exist). The `/review` command will enrich this line with review data later (see review.md Step 10b).

#### 10b.1. Compute test_layers block

Before emitting the metrics line, compute the `test_layers` block.

**First, load defs and check if test layer metrics is configured:**

```typescript
const defsResult = await loadDefs((path) => readFile(path, "utf-8"));
```

If `defsResult.source === "defaults"` (no `test-system.md` found in the repo), test layer metrics is not configured for this repo. Set:
- `test_layers` = `{"configured":false}`
- `conformance` = `{"checked":false,"deviations":[]}`

Skip the rest of Step 10b.1 and proceed directly to emitting the metrics line.

When `defsResult.source === "test-system.md"`, proceed with the following:

**measured** — run `parseDiff` from `shipwright/classify_test_layer.ts` on `git diff main...HEAD`:

```bash
# Get the diff and pass to parseDiff from shipwright/classify_test_layer.ts
# The result is a Record<string, number> with per-layer counts (positive=added, negative=removed)
# Include deletions — a unit test removed counts as -1 in the unit layer
```

Import and call `parseDiff(diffText, defsResult.defs)` — this returns an object like `{"unit":0,"integration":1,"smoke":0,"e2e":0}`. A diff adding an integration test and deleting a unit test yields `{"unit":-1,"integration":1,"smoke":0,"e2e":0}`.

**planned** — run `parsePlanned` from `shipwright/classify_test_layer.ts` on the task's acceptance criteria bullets that contain "Test decision":

```bash
# Extract AC bullets matching "Test decision" from the task description
# Call parsePlanned(acBullets) to get ParsedDecision[] objects
# Each object has: { layers: LayerName[], added: string[], retired: string[] }
```

**drift** — compare planned vs measured:
- For each `retired` file in each `ParsedDecision` from `planned`, check if the corresponding layer decreased in `measured` (i.e., its count is negative)
- If a planned retirement did not result in a negative count for that layer, add a drift entry: `{"planned":"retire <file>","observed":"no removal detected in layer <X>"}`
- If `planned` is empty or `drift` finds no discrepancies, emit an empty array `[]`

**conformance** — run `checkConformance` from `shipwright/classify_test_layer.ts` on the additions from `parseDiffAdditions` and the `LoadDefsResult` from `loadDefs`:

```typescript
// 1. Get additions from diff
const additions = parseDiffAdditions(diffText, defsResult.defs);
// 2. Check conformance — advisory only, never blocks
const conformanceReport = checkConformance(additions, defsResult);
```

This is advisory — a deviation NEVER causes /dev-task or /review to fail or block. It is recorded as metadata only.

When `conformanceReport.checked` is `false` (test-system.md absent), emit `"conformance": {"checked": false, "deviations": []}` in the metrics record, indicating conformance was not checked.
When `conformanceReport.checked` is `true`, emit `"conformance": {"checked": true, "deviations": [...]}`.

**coverage_per_layer** — per-layer coverage percentages when the toolchain supports it; `null` otherwise (most toolchains). **coverage_per_layer_reason** — when `coverage_per_layer` is `null`, record why: use `"toolchain does not support per-layer coverage"` for standard bun/jest setups. When `coverage_per_layer` is populated, set `coverage_per_layer_reason` to `null`. The aggregate `coverage_delta` field is unaffected by this block.

**Every field must be present on every emitted record**: when test layer metrics is configured (`test-system.md` present), emit `test_layers` with `"measured"` as an object with all-zero counts, `"planned"` as `[]`, `"drift"` as `[]`, `"coverage_per_layer"` as `null`, and `"coverage_per_layer_reason"` as the reason string — even when a task has no test changes. When test layer metrics is not configured (`test-system.md` absent), emit `"test_layers":{"configured":false}`. Never omit the block. The `conformance` field follows the same rule: when `test-system.md` is absent, emit `"conformance":{"checked":false,"deviations":[]}` (conformance was not checked); when `test-system.md` is present but the diff contains no test additions, emit `"conformance":{"checked":true,"deviations":[]}` (checked and no deviations found). Never omit `conformance`.

#### 10b.2. Compute tokens block

Using the `JSONL_SNAPSHOT_PATH` and `JSONL_SNAPSHOT_LINES` captured in Step 1, run the following Python snippet to sum token usage from all new JSONL lines written during this task:

```bash
python3 /tmp/shipwright-token-calc.py "$JSONL_SNAPSHOT_PATH" "$JSONL_SNAPSHOT_LINES" "$CLAUDE_MODEL"
```

Write the snippet to `/tmp/shipwright-token-calc.py` once (before running it):

```python
#!/usr/bin/env python3
"""
Sum token usage from new Claude Code JSONL lines since a snapshot position.
Outputs shell variable assignments: INPUT_TOKENS=N OUTPUT_TOKENS=N COST_USD=N.NNNN
Never exits non-zero — any parse error yields zeros.
"""
import json, sys, os

RATES = {
    "claude-fable-5":    {"input": 10.0, "output": 50.0},
    "claude-opus-4-8":   {"input": 5.0,  "output": 25.0},
    "claude-opus-4-7":   {"input": 5.0,  "output": 25.0},
    "claude-opus-4-6":   {"input": 5.0,  "output": 25.0},
    "claude-sonnet-4-6": {"input": 3.0,  "output": 15.0},
    "claude-haiku-4-5":  {"input": 1.0,  "output":  5.0},
    "claude-haiku-4-6":  {"input": 1.0,  "output":  5.0},
}

def main():
    try:
        jsonl_path = sys.argv[1] if len(sys.argv) > 1 else ""
        snapshot_lines = int(sys.argv[2]) if len(sys.argv) > 2 else 0
        model = sys.argv[3] if len(sys.argv) > 3 else ""

        if not jsonl_path or not os.path.isfile(jsonl_path):
            print("INPUT_TOKENS=null OUTPUT_TOKENS=null COST_USD=null")
            return

        input_tokens = 0
        output_tokens = 0
        cache_creation = 0
        cache_read = 0

        with open(jsonl_path, "r", errors="replace") as f:
            for i, line in enumerate(f):
                if i < snapshot_lines:
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                # Claude Code JSONL: top-level usage field
                usage = None
                if isinstance(obj.get("usage"), dict):
                    usage = obj["usage"]
                # Nested: message.usage
                elif isinstance(obj.get("message"), dict) and isinstance(obj["message"].get("usage"), dict):
                    usage = obj["message"]["usage"]
                if usage:
                    input_tokens  += int(usage.get("input_tokens", 0) or 0)
                    output_tokens += int(usage.get("output_tokens", 0) or 0)
                    cache_creation += int(usage.get("cache_creation_input_tokens", 0) or 0)
                    cache_read    += int(usage.get("cache_read_input_tokens", 0) or 0)

        rates = RATES.get(model)
        if rates and (input_tokens or output_tokens):
            cost = (
                input_tokens   * rates["input"] +
                output_tokens  * rates["output"] +
                cache_creation * rates["input"] * 1.25 +
                cache_read     * rates["input"] * 0.1
            ) / 1_000_000
            print(f"INPUT_TOKENS={input_tokens} OUTPUT_TOKENS={output_tokens} COST_USD={cost:.6f}")
        else:
            print(f"INPUT_TOKENS={input_tokens} OUTPUT_TOKENS={output_tokens} COST_USD=null")
    except Exception:
        print("INPUT_TOKENS=null OUTPUT_TOKENS=null COST_USD=null")

main()
```

Evaluate the output:

```bash
eval $(python3 /tmp/shipwright-token-calc.py "$JSONL_SNAPSHOT_PATH" "$JSONL_SNAPSHOT_LINES" "$CLAUDE_MODEL")
# INPUT_TOKENS, OUTPUT_TOKENS, COST_USD are now set (numbers or "null")
```

If the script fails or the JSONL path is unreadable, all three variables emit as `null`. Store `INPUT_TOKENS`, `OUTPUT_TOKENS`, `COST_USD`, and `EFFORT_LEVEL` (from Step 1) for the JSONL line and Step 10c.

```json
{"task":"{id}","title":"{title}","session":"{session}","repo":"{repo}","layer":"{layer}","estimated_h":{hours},"ci_fix_attempts":{ci_attempt},"pr":{pr_number},"files_changed":{files_changed_count},"started_at":"{task_started_at}","ts":"{ISO timestamp}","simplify":{"total":{simplify_total},"dry":{simplify_dry},"dead_code":{simplify_dead_code},"naming":{simplify_naming},"complexity":{simplify_complexity},"consistency":{simplify_consistency}},"requirements":{"met":{req_met},"partial":{req_partial},"not_met":{req_not_met},"total":{req_total}},"ci":{"fix_attempts":{ci_attempt},"failures":{ci_failures_json_array},"checks":{ci_checks_json_array}},"auto_docs":{"updated":{auto_docs_updated},"files_changed":{auto_docs_files_changed},"lines_changed":{auto_docs_lines_changed},"skipped_reason":{auto_docs_skipped_reason_json}},"test_layers":{"measured":{test_layers_measured},"planned":{test_layers_planned},"drift":{test_layers_drift},"coverage_per_layer":{test_layers_coverage_per_layer},"coverage_per_layer_reason":{test_layers_coverage_per_layer_reason}},"conformance":{conformance_checked_json},"tokens":{"input":{INPUT_TOKENS},"output":{OUTPUT_TOKENS},"cost_usd":{COST_USD}},"effort_level":{effort_level_json}}
```

Notes:
- `{layer}` is the task's layer string — emit `""` (empty string) when the task has no `layer` field.
- `ci_checks_json_array` is the JSON encoding of the `ci_checks` array — `[]` when no CI is configured or no checks were collected. Format: `[{"name":"test/unit","conclusion":"failure"},...]`.
- `auto_docs_skipped_reason_json` is the JSON encoding of the skip reason — either `null` (literal, unquoted) or a quoted string like `"no_docs_dir"`. When `auto_docs_updated` is `true`, this field is `null`.
- `test_layers_measured` is a JSON object with per-layer counts, e.g. `{"unit":0,"integration":1,"smoke":0,"e2e":0}`.
- `test_layers_planned` is a JSON array of `ParsedDecision` objects, e.g. `[{"layers":["integration"],"added":["foo.integration.test.ts"],"retired":[]}]`. Emit `[]` when the task has no "Test decision" AC bullets.
- `test_layers_drift` is a JSON array of discrepancy objects, e.g. `[{"planned":"retire foo.unit.test.ts","observed":"no removal detected in layer unit"}]`. Emit `[]` when no drift is found.
- `test_layers_coverage_per_layer` is `null` when the toolchain does not support per-layer coverage (most toolchains); do not fabricate values. When null, the aggregate `coverage_delta` field is unaffected.
- `test_layers_coverage_per_layer_reason` is a quoted string explaining why `coverage_per_layer` is null (e.g. `"toolchain does not support per-layer coverage"`), or `null` when coverage data is populated.
- `conformance_checked_json` is the JSON encoding of the `ConformanceReport` from `checkConformance`. When `test-system.md` is absent (source: "defaults"), this is `{"checked":false,"deviations":[]}`, indicating conformance was not checked. When present, `checked` is `true` and `deviations` lists any advisory layer deviations. A non-empty deviations array is advisory only — it never causes /dev-task or /review to fail or block.
- `{INPUT_TOKENS}`, `{OUTPUT_TOKENS}`, `{COST_USD}` are the values from Step 10b.2. `cost_usd` is `null` when the model rate is unknown; `input` and `output` counts are still emitted. All three are `null` only when the JSONL path is missing or unreadable.
- `effort_level_json` is either a JSON string (e.g. `"high"`) or `null` (unquoted) when `EFFORT_LEVEL` is empty or unset.
- The `/review` Step 13 enrichment appends `review.*` fields to this same JSONL line by adding a new top-level key to the existing JSON object. This is unaffected by the new `test_layers` block — the enrichment reads the entire line, parses it, adds the `review` key, and writes it back.

This step is silent. JSONL format — one JSON object per line; append-only.

### 10c. Fire Completion Event

Fire the canonical task-completion event. This is the event the metrics dashboard and PostHog aggregates read for `tasks_completed`, cycle time, and actual-vs-estimated hours — it MUST fire at the end of every successful task.

Derive `actual_h` from the timestamps already in hand (no extra state): the elapsed wall-clock hours between `task_started_at` (recorded in Step 1) and the metrics `{ISO timestamp}` from Step 10b, rounded to one decimal. `retries` is the CI fix-attempt count (`ci_attempt`). `complexity` is the task's `complexity` field from `state/todos.json` if present; the queue schema does not require it, so omit the `complexity=` argument entirely when the task has none (downstream renders absent → em-dash; never emit a fabricated value).

Re-resolve the script path inline:

```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
[ -n "$POSTHOG_SCRIPT" ] && python3 "$POSTHOG_SCRIPT" shipwright_task_complete \
  --project {repo} --task {id} --ts "{ISO timestamp}" \
  title="{title}" session="{session}" layer="{layer}" \
  estimated_h={hours} actual_h={actual_h} retries={ci_attempt} \
  pr={pr_number} files_changed={files_changed_count} \
  started_at="{task_started_at}" {if task has complexity: complexity={complexity}} \
  tokens_in={INPUT_TOKENS} tokens_out={OUTPUT_TOKENS} cost_usd={COST_USD} \
  effort_level="{EFFORT_LEVEL}"
```

`--task {id}` makes `posthog_send.py` set `properties.task_id` automatically, and the explicit `started_at`/`--ts` pair lets downstream consumers compute cycle time from a single event. This event is additive — it does not replace the JSONL batch line or any incremental checkpoint event.

Notes on token args:
- `{INPUT_TOKENS}`, `{OUTPUT_TOKENS}`, `{COST_USD}` are the values from Step 10b.2. When any is `null`, pass the literal string `null` — `posthog_send.py` will parse it as JSON `null`.
- `{EFFORT_LEVEL}` is the value from Step 1. When empty or unset, pass an empty string `""` — `posthog_send.py` will store it as an empty string, and downstream consumers can treat `""` as absent.

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
