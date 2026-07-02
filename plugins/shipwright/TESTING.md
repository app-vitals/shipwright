# Shipwright Testing

Manual test scenarios for each command across different project types.

## Prerequisites

- Claude Code installed
- Shipwright plugin installed (`/plugin install shipwright@app-vitals/shipwright`)
- GitHub CLI (`gh`) authenticated
- A test repository (or use the scenarios below)

---

## Test Matrix

| # | Command | Project Type | Scenario | Key Verification |
|---|---------|-------------|----------|-----------------|
| 30 | `/prd` | Any | Full interactive session | Questions asked one at a time, PRODUCT-SPEC.md written with all sections, valid input for /plan-session |
| 31 | `/prd` | Any | Vague/minimal input | Probes trigger, open questions captured, no requirements invented |
| 1 | `/plan-session` | Node.js (pnpm) | New feature planning | Toolchain detected, layers auto-detected, template correct |
| 17 | `/plan-session` | Any | Complexity scoring | Complexity column (1-5) in task table, scores correlate with task characteristics |
| 18 | `/dev-loop` | Any | Cross-session handoff | Handoff section written after each batch, restored on restart |
| 19 | `/dev-task --merge` | Any | Persistent metrics | metrics.jsonl appended after each merge, plan-session reads historical data |
| 20 | `/dev-task` + `/dev-task --merge` | Any (with CI) | CI gate | Checks monitored, failures auto-fixed, merge conflicts resolved, max retries enforced |
| 2 | `/plan-session` | Python (poetry) | API feature planning | Python toolchain, pytest commands, coverage threshold |
| 3 | `/plan-session` | Rust (cargo) | CLI feature planning | Cargo commands, clippy in permissions |
| 4 | `/plan-session` | Go | Service planning | Go commands, golangci-lint detection |
| 5 | `/plan-session` | Multi (Node+Rust) | Full-stack planning | Both ecosystems detected, dual validation |
| 6 | `/dev-task` | Node.js | Single task execution | Branch created, tests run, PR created |
| 7 | `/dev-task --merge` | Node.js | Merge-mode task | Full pipeline including review and merge |
| 8 | `/dev-loop` | Node.js | Multi-task loop | All tasks processed, planning doc updated |
| 9 | `/review` | Node.js | Standalone review | Agents launched, findings reported, AC verified |
| 10 | `/refresh-plan` | Any | Stale doc refresh | File paths updated, context regenerated |
| 11 | `/plan-session` | Any | Planning retrospective | Phase 9 metrics and quality ratings |
| 12 | `/dev-loop` | Any | Loop retrospective | Actual vs estimated, accuracy ratio |
| 13 | `/dev-loop` | Any | Bug-fix task insertion | HF-N generated, picked up in next iteration |
| 14 | `/dev-task` + `/dev-loop` | Any | PR/branch cleanup on failure | Orphan PRs closed, branches deleted, retry logic |
| 15 | `/dev-loop` | Any | Parallel task execution | Batch selection, worktree isolation, post-sync |
| 16 | `/plan-session` | Any | Task consolidation | Merge criteria applied, consolidation report |
| 21 | `/research` | Any (with docs/) | Project with docs | Agent discovers docs, selects relevant, returns structured output |
| 22 | `/research` | Any (no docs/) | Project without docs | Detects no docs, proceeds with web-only research |
| 23 | `/research` | Any | Web search triggered | Agent reads local docs, identifies gap, triggers web search |
| 24 | `/research` | Any | Simple solution bias | Output leads with simplest approach, complex alternatives only if warranted |
| 25 | `/research` | Any | Read-only enforcement | Agent does not create or modify files, no user prompts |
| 26 | `/research-docs` | Any (with docs/) | Full audit with existing docs | Detects structure, identifies current/stale/missing, waits for confirmation |
| 27 | `/research-docs` | Any | Single module focus | Focuses on specified module only, generates doc following conventions |
| 28 | `/research-docs` | Any (no docs/) | No docs directory | Creates docs/, identifies all modules as missing, generates docs |
| 29 | `/research-docs` | Any (with docs/) | Style detection | Generated docs match existing naming/heading/content patterns |
| 32 | `/research-docs` | Any (with docs/test-readiness/) | testing.md digest path | docs/testing.md generated as concise digest of test-system.md, References section links back to docs/test-readiness/ files |
| 33 | `/research-docs` | Any (tests present, no test-readiness) | testing.md inferred path | docs/testing.md generated from observed runner configs + test dirs, marked inferred, footer points to /test-system-design |
| 34 | `/research-docs` | Greenfield (no tests) | testing.md placeholder path | docs/testing.md stub generated with TODO markers per layer + Next-steps footer pointing to test-readiness plugin |
| 35 | `/dev-task` Step 8.5 | Any (with docs/) | Auto-docs refresh on doc-affecting change | `docs: refresh` commit appears on branch before push; PR contains impl + doc edits; metrics record has `auto_docs.updated:true` with non-zero `lines_changed` |
| 36 | `/dev-task` Step 8.5 | Any (with docs/) | Negative — task changes nothing documented | No `docs: refresh` commit; metrics record has `auto_docs.updated:false`, `skipped_reason:"no_stale_refs"` |
| 37 | `/dev-task` Step 8.5 | Any (no docs/) | Skip when no docs directory exists | No commit, no agent rework; metrics record has `skipped_reason:"no_docs_dir"`; pipeline continues to push & PR without error |
| 38 | `/metrics` | Any (multi-task session) | Auto-docs aggregation across session | New "Auto-docs maintenance" section appears with update rate, mean lines/task, and skip breakdown; recommendation #12 fires when rate is low |
| 39 | `/dev-task` Step 8.5 | Any (with docs/, failing pre-commit hook) | Commit failure does not produce false success | No `✓ Docs refreshed`; `skipped_reason:"commit_failed"`, `commit_sha:null`, `updated:false`; no fabricated metrics; pipeline still continues to Step 9 |
| 40 | `/dev-task` Step 8.5 | Any | Unparseable agent result is recorded, not silent | Agent returns no/garbled `AUTO_DOCS_METRICS` block; `⚠ ... agent_error` printed; metrics record has `skipped_reason:"agent_error"`, `updated:false`; pipeline continues |
| 41 | `/plan-session` Step 6a / `/prd` Phase 4 | Any (hosted store configured) | Plan viz render after markdown write | `PLAN.md`/`PRODUCT-SPEC.md` written unchanged, then `render-plan.ts` runs and a `Plan viz: {url}` line is surfaced in the confirmation block |
| 42 | `/plan-session` Step 6a / `/prd` Phase 4 | Any (hosted store unset) | Plan viz graceful skip | `⏭ Plan viz skipped — SHIPWRIGHT_TASK_STORE_URL/TOKEN unset.` printed; markdown still written; no `Plan viz:` line; command never blocks |

---

## Scenario 1: Plan Session — Node.js (pnpm)

### Setup
1. Create a test repo with `package.json`, `pnpm-lock.yaml`, and basic `src/` structure
2. Add `src/components/`, `src/api/`, `src/lib/` directories
3. Create `planning/test-feature/` with a requirements doc

### Run
```
/plan-session test-repo test-feature
```

### Verify
- [ ] Phase 0 detects pnpm as package manager
- [ ] Phase 0 reads package.json scripts correctly
- [ ] Phase 3 auto-detects layers: Frontend, API, Shared
- [ ] Phase 4 generates planning doc with correct template
- [ ] Phase 4 uses detected layers (not Chrome extension layers)
- [ ] Phase 5 quality checks all pass
- [ ] Phase 7 generates correct pnpm permission patterns
- [ ] No Chrome extension references anywhere in output
- [ ] No hardcoded `pnpm validate` — uses detected commands

---

## Scenario 2: Plan Session — Python (poetry)

### Setup
1. Create a test repo with `pyproject.toml` (poetry build system), `poetry.lock`
2. Add `src/api/`, `src/db/`, `src/lib/` directories
3. Create `planning/test-feature/` with a requirements doc

### Run
```
/plan-session test-repo test-feature
```

### Verify
- [ ] Phase 0 detects Poetry as package manager
- [ ] Phase 0 identifies pytest, ruff check commands
- [ ] Phase 3 auto-detects layers: API, Database, Shared
- [ ] Phase 7 generates poetry/pytest permission patterns
- [ ] Planning doc template uses correct Python toolchain

---

## Scenario 3: Plan Session — Rust (cargo)

### Setup
1. Create a test repo with `Cargo.toml`, `src/main.rs`
2. Add `src/cli/`, `src/lib/` directories
3. Create `planning/test-feature/` with a requirements doc

### Run
```
/plan-session test-repo test-feature
```

### Verify
- [ ] Phase 0 detects Cargo
- [ ] Phase 0 identifies `cargo build`, `cargo test`, `cargo clippy`
- [ ] Phase 3 auto-detects layers: CLI, Shared
- [ ] Phase 7 includes `Bash(cargo:*)` permission
- [ ] Planning doc references cargo commands (not pnpm)

---

## Scenario 4: Dev Task — Single Execution

### Setup
1. Complete Scenario 1 (have a planning doc with tasks)
2. Identify the first available task ID

### Run
```
/dev-task {TASK-ID}
```

### Verify
- [ ] Step 0 detects toolchain
- [ ] Step 1 finds the planning doc
- [ ] Step 2 extracts all task fields correctly
- [ ] Step 3 checks dependencies
- [ ] Step 4 marks task [🔨] and commits
- [ ] Step 6 creates feature branch from main
- [ ] Step 7 implements using inline workflow (not /feature-dev)
- [ ] Step 8 runs simplification pass (not /simplify)
- [ ] Step 9 verifies acceptance criteria
- [ ] Step 10 runs detected validation commands (not hardcoded)
- [ ] Step 11 creates PR with correct body format
- [ ] Step 12 shows handoff block (standalone mode)

---

## Scenario 5: Dev Task — Merge Mode

### Setup
Same as Scenario 4

### Run
```
/dev-task {TASK-ID} --merge
```

### Verify
- [ ] All pause points are skipped
- [ ] Step 12 runs inline review (not /review command)
- [ ] Review uses generic Agent types (not pr-review-toolkit)
- [ ] PR is squash-merged automatically
- [ ] Planning doc status updated to [x] PR #{N}

---

## Scenario 6: Dev Loop

### Setup
1. Have a planning doc with 3+ tasks, first 2 with no dependencies
2. Third task depends on first two

### Run
```
/dev-loop test-feature
```

### Verify
- [ ] Phase 0 locates planning doc
- [ ] Phase 1 picks first available task
- [ ] Phase 2 launches subagent with /dev-task --merge
- [ ] Phase 3 confirms completion, loops to next task
- [ ] Dependency chain respected (task 3 runs after 1 and 2)
- [ ] Loop ends with COMPLETE or BLOCKED summary
- [ ] Permission cleanup offered if pipeline-permissions-added.json exists

---

## Scenario 7: Review — Standalone

### Setup
1. Complete a /dev-task (without --merge) to have a branch with PR
2. Switch to a new session on the feature branch

### Run
```
/review
```

### Verify
- [ ] Step 0 detects toolchain
- [ ] Step 1 auto-detects branch and PR
- [ ] Step 2 recovers task ID from branch name
- [ ] Step 3 gathers context in parallel
- [ ] Step 4 launches appropriate agents based on diff analysis
- [ ] Step 7 dispatches the `shipwright:code-reviewer` subagent (not pr-review-toolkit)
- [ ] Step 5 validates findings against source files
- [ ] Step 5b runs coverage with detected commands
- [ ] Step 6 evaluates acceptance criteria
- [ ] Step 7 presents structured report
- [ ] Step 8 fixes use detected validation commands

---

## Scenario 8: Refresh Plan

### Setup
1. Have a planning doc with some [x] and some [ ] tasks
2. Modify some source files referenced by [ ] tasks (move or rename)

### Run
```
/refresh-plan test-feature
```

### Verify
- [ ] Step 1 loads and parses the planning doc
- [ ] Step 2 identifies [ ] tasks correctly
- [ ] Step 3 detects stale file paths
- [ ] Step 3 checks dependency status updates
- [ ] Step 4 proposes correct changes
- [ ] Step 5 shows before/after diff
- [ ] Step 6 commits after user approval

---

## Anti-Pattern Checks

Run these across ALL scenarios to verify genericization:

- [ ] No references to "Chrome extension", "WXT", "MV3", "content script", "service worker lifecycle"
- [ ] No hardcoded `pnpm validate`, `pnpm -r check` — uses detected commands
- [ ] No hardcoded `cargo clippy`, `cargo test` — uses detected commands
- [ ] No references to hardcoded packages like "extension", "desktop", "packages/shared"
- [ ] No `/feature-dev` skill invocation — replaced with inline implementation
- [ ] No `/simplify` skill invocation — replaced with inline simplification
- [ ] No `pr-review-toolkit:*` agent types — replaced with bundled `shipwright:code-reviewer`
- [ ] No references to `learning-loop` — review findings live in `state/reviews/*.md` only
- [ ] Coverage threshold defaults to 90% (configurable)
- [ ] No `frontend-design` as required — optional Design Skill tag
- [ ] No hardcoded layer names "Background/UI/Content Script/Shared" — uses auto-detected layers
- [ ] `/research` and `/research-docs` work as built-in shipwright commands (not standalone plugin)

---

## Scenario 11: Planning Retrospective (plan-session Phase 9)

### Setup
1. Complete a full plan-session (any of Scenarios 1-5)

### Verify
- [ ] Phase 9a evaluates all 6 dimensions with ratings (1-5)
- [ ] Phase 9b prints metrics block with correct task counts, hours, and quality scores
- [ ] Findings are appended as `## Planning Retrospective` section in the planning doc
- [ ] Only dimensions rated 3 or below generate findings
- [ ] No references to learning-loop or `/learn` in output

---

## Scenario 12: Dev Loop Retrospective

### Setup
1. Complete a full dev-loop (Scenario 8) with 3+ tasks

### Verify
- [ ] Retrospective section appears after loop summary, before permission cleanup
- [ ] Metrics table shows actual vs estimated hours for each completed task
- [ ] Delta percentages are calculated correctly
- [ ] Accuracy ratio (actual/estimated) is computed
- [ ] Retry count and orphan PR count are tracked
- [ ] Bug-fix task count (HF-*) is included
- [ ] Learnings staged with `Shipwright/dev-loop:` prefix if plugin available
- [ ] Retrospective summary block prints with all metric fields populated

### Metrics accuracy
- [ ] Actual hours derived from git commit timestamps (first commit on branch → merge)
- [ ] Accuracy ratio = actual / estimated
- [ ] Orphan PR count matches actual cleanup actions taken
- [ ] Permission settings diff correctly counts runtime additions

---

## Scenario 13: Dynamic Bug-Fix Task Insertion

### Setup
1. Create a planning doc with 3+ tasks
2. In the second task's source files, introduce a deliberate bug that a later task's tests will catch (e.g., wrong property name in a response object)
3. Run `/dev-loop`

### Verify
- [ ] Phase 3b scans subagent output for bug-indicating phrases
- [ ] `HF-1` task is generated with correct fields (ID, Hours, Layer, Dependencies, Branch)
- [ ] HF task appended to planning doc (feature section + Appendix)
- [ ] Warning printed: "⚠ BUG DETECTED after {task-id} — created HF-1: {description}"
- [ ] HF task picked up in next loop iteration (its dependency is already `[x]`)
- [ ] HF task fixes the bug and merges
- [ ] Final summary includes HF tasks in the shipped list
- [ ] HF task has `minimal` architecture approach
- [ ] HF task branch follows `fix/hf-{n}-{description}` convention

### Edge case checks
- [ ] False positive: subagent mentions "bug" in a comment but no actual bug → no HF task created
- [ ] Multiple bugs in one task → creates HF-1, HF-2, etc.
- [ ] HF task numbering continues across the entire loop run (not per-task)

---

## Scenario 14: Failed PR/Branch Cleanup

### Setup (dev-task)
1. Create a planning doc with a task that will fail during PR creation
2. Run `/dev-task {task-id} --merge`

### Verify (dev-task)
- [ ] PR creation or merge fails
- [ ] Orphaned PR detected via `gh pr list --head {branch}`
- [ ] Open PRs closed with cleanup comment
- [ ] Remote branch deleted
- [ ] Local branch deleted, returned to main
- [ ] Task status reset from `[🔨]` to `[ ]` in planning doc
- [ ] Cleanup summary printed with PR list and branch name
- [ ] Commit created: `chore: reset {task-id} after PR failure`

### Setup (dev-loop)
1. Create a planning doc where one task is designed to fail (e.g., references nonexistent file)
2. Run `/dev-loop`

### Verify (dev-loop)
- [ ] Failed subagent triggers Phase 3a-retry
- [ ] Cleanup runs (close orphan PRs, delete branch)
- [ ] First failure: task re-queued (status reset to `[ ]`)
- [ ] Second failure: task marked `[⏸]` (blocked)
- [ ] retryMap tracks per-task retry count correctly
- [ ] Warning printed with failure/retry status
- [ ] Other tasks continue processing after the failed task

---

## Scenario 15: Parallel Task Execution

### Setup
1. Create a planning doc with 6 tasks:
   - T-1 (no deps), T-2 (no deps), T-3 (depends on T-1), T-4 (depends on T-2), T-5 (depends on T-3 + T-4), T-6 (no deps, same Layer/file as T-1)
2. Run `/dev-loop`

### Verify
- [ ] Phase 1 identifies ALL ready tasks, not just the first
- [ ] T-1 and T-2 launch as parallel subagents (different worktrees)
- [ ] T-6 does NOT parallelize with T-1 (same primary file — file overlap check works)
- [ ] Each parallel subagent uses `isolation: "worktree"`
- [ ] Post-batch sync pulls main between parallel batches
- [ ] T-3 starts only after T-1 completes
- [ ] T-4 starts only after T-2 completes
- [ ] T-3 and T-4 parallelize (independent, different files)
- [ ] T-5 waits for both T-3 and T-4
- [ ] All PRs merge cleanly (no conflicts from parallel work)
- [ ] Batch plan printed with task IDs, branches, layers
- [ ] Wall-clock time is measurably less than sequential (compare git timestamps)

### Anti-pattern checks
- [ ] Never launches > 3 parallel subagents (resource guard)
- [ ] Falls back to sequential if worktree creation fails
- [ ] Single-task fallback works correctly when only 1 task is ready

---

## Scenario 16: Task Consolidation (plan-session Phase 4b)

### Setup
1. Create a planning folder with requirements that will naturally produce:
   - Two schema additions to the same file (e.g., two Prisma models)
   - Two CLI commands in the same file
   - Two independent API endpoints in different files (should NOT merge)
2. Run `/plan-session`

### Verify
- [ ] Phase 4b runs after task generation, before Phase 5 quality checks
- [ ] Schema tasks meeting ALL merge criteria are consolidated into 1 task
- [ ] CLI tasks meeting ALL merge criteria are consolidated into 1 task
- [ ] API tasks remain separate (different primary files)
- [ ] Merged task uses the earlier task's ID and branch
- [ ] Merged task hours = sum minus ~15% context-switch reduction
- [ ] Merged task notes "Consolidated from {original-ids}"
- [ ] Acceptance criteria are unioned and deduplicated
- [ ] Implementation Decisions are merged (more detailed answer for each field)
- [ ] Retired task ID removed from Appendix and Feature Summary
- [ ] No task references a retired ID as a dependency
- [ ] Consolidation report printed (pairs merged, before/after counts, hours saved)

### Guard rails
- [ ] Tasks > 4h combined are NOT merged
- [ ] Tasks with conflicting dependencies are NOT merged
- [ ] Tasks in different features are NOT merged
- [ ] Non-additive changes (create vs refactor) are NOT merged

---

## Scenario 17: Complexity Scoring (plan-session)

### Setup
1. Create a test repo with a Node.js project
2. Create `planning/test-feature/` with a requirements doc covering:
   - A simple config field addition (expect Complexity 1-2)
   - A 5+ file cross-layer feature (expect Complexity 4-5)

### Run
```
/plan-session test-repo test-feature
```

### Verify
- [ ] Every task in output has a `Complexity` column with a value 1-5
- [ ] Config-only task scores 1-2
- [ ] Cross-layer task scores 4-5
- [ ] Phase 5 quality check reports Complexity as a required field
- [ ] Phase 5 fails if any task is missing a Complexity score

### With historical metrics
- [ ] Place a `planning/test-feature/metrics.jsonl` file with 5 sample entries
- [ ] Re-run `/plan-session test-repo test-feature` — verify historical estimation accuracy is printed before hour assignment
- [ ] Delete `metrics.jsonl` — verify no errors on next run (graceful degradation)

---

## Scenario 18: Cross-Session Handoff (dev-loop)

### Setup
1. Have a planning doc with 4+ tasks, first 2 with no dependencies

### Interrupt test
1. Start `/dev-loop`
2. After the first task completes (watch for `✓ {task-id}` line), manually interrupt the session (`/clear` or kill)
3. Open the planning doc — verify `## Handoff` section was written with:
   - [ ] `Last completed: {task-id}`
   - [ ] `Timestamp:` (valid ISO timestamp)
   - [ ] `Batch:` field
   - [ ] `Recent changes:` list (at least 1 entry)

### Resume test
1. Restart `/dev-loop` on the same planning doc
2. Verify:
   - [ ] Loop prints `↩ Resuming from handoff (last: {task-id}, batch N)`
   - [ ] Loop does NOT re-run already-completed tasks
   - [ ] `recentChanges[]` is populated from the Handoff section (visible in Phase 2a context briefings)

### Completion cleanup
1. Let the loop run to completion
2. Verify:
   - [ ] `## Handoff` section is removed from the planning doc
   - [ ] Final commit message: `chore: remove handoff state — loop complete`

### Orphan recovery (dev-task)
1. Create a planning doc with a task marked `[🔨]` and a matching branch on the remote
2. Run `/dev-task {task-id}`
3. Verify:
   - [ ] Orphan check runs before marking in-progress
   - [ ] If a PR exists, it is closed with cleanup comment
   - [ ] Branch is deleted before fresh start

---

## Scenario 19: Persistent Metrics (dev-task + dev-loop + plan-session)

### Artifact check — metrics.jsonl written
1. Complete any `/dev-task {task-id} --merge` on a task that has a Complexity score
2. Verify:
   - [ ] `planning/{folder}/metrics.jsonl` exists after merge
   - [ ] Contains exactly one new JSON line with fields: `task`, `title`, `estimated_h`, `actual_h`, `complexity`, `retries`, `ci_fix_attempts`, `pr`, `hotfixes`, `files_changed`, `ts`
   - [ ] `complexity` matches the task's Complexity field in the planning doc
   - [ ] `pr` matches the merged PR number

### Artifact check — dev-loop reads metrics
1. Complete a `/dev-loop` run with 3+ tasks (metrics.jsonl will be populated)
2. In the Loop Retrospective, verify:
   - [ ] "Historical data" block appears with mean estimation error
   - [ ] Model distribution shows counts per complexity tier
   - [ ] Per-task table uses actuals from metrics.jsonl (not just git timestamps)

### Artifact check — plan-session reads historical data
1. After a dev-loop run that produced `metrics.jsonl`, run `/plan-session` on the same folder
2. Verify:
   - [ ] Historical estimation accuracy is reported before hour assignment
   - [ ] Message format: "Historical data ({N} tasks): avg estimation error {+/-N}%..."

### Graceful degradation
1. Run `/plan-session` on a folder with NO `metrics.jsonl` — no errors, no warnings
2. Run `/dev-loop` on a folder with NO `metrics.jsonl` — retrospective still runs using git timestamps

---

## Scenario 20: CI Gate (dev-task Step 11b)

### Prerequisites
1. A test repository with GitHub Actions CI configured (at least one workflow that runs on push/PR)
2. A planning doc with an available task

### Happy path — CI passes

#### Setup
1. Run `/dev-task {task-id}` on a task that will produce passing code

#### Verify
- [ ] Step 11b.1 runs `git fetch origin main && git merge origin/main` after PR creation
- [ ] Step 11b.1 pushes updated branch with `git push`
- [ ] Step 11b.2 polls `gh api repos/{owner}/{repo}/actions/runs?branch={branch}` every 30s until all runs complete
- [ ] On all checks passing, prints `✓ CI checks passed`
- [ ] Proceeds to Step 12 (handoff in standalone, review+merge in merge-mode)

### Happy path — no CI configured

#### Setup
1. Use a repo with no GitHub Actions workflows

#### Verify
- [ ] Step 11b.2 detects no checks (empty output)
- [ ] Prints `⏭ No CI checks configured — skipping CI gate`
- [ ] Proceeds to Step 12 without waiting

### CI failure — auto-fix loop

#### Setup
1. Introduce a deliberate test failure that CI will catch (e.g., a failing assertion)
2. Run `/dev-task {task-id} --merge`

#### Verify
- [ ] Step 11b.2 detects check failure after `--watch` completes
- [ ] Step 11b.3 collects failure logs via `gh run list` and `gh run view --log`
- [ ] Step 11b.4 prints `CI FIX: attempt 1/3` banner
- [ ] Fix subagent is launched as `general-purpose` Agent type
- [ ] Subagent receives: task context, failure logs, PR diff
- [ ] Subagent fixes the issue, commits with `fix:` prefix, pushes
- [ ] Loop returns to 11b.1 (updates from main again)
- [ ] Step 11b.2 re-waits for CI
- [ ] On success, prints `✓ CI checks passed (after 1 fix attempt(s))`
- [ ] `ci_fix_attempts` recorded correctly in metrics.jsonl

### Merge conflict handling

#### Setup
1. Start a dev-task on a branch
2. While the task is in progress, merge a conflicting change to main from another branch
3. Let dev-task reach Step 11b

#### Verify
- [ ] Step 11b.1 `git merge origin/main` detects conflicts
- [ ] Merge is aborted (`git merge --abort`)
- [ ] Jumps directly to 11b.4 fix loop with conflict context
- [ ] Fix subagent prompt includes "Merging origin/main produced conflicts"
- [ ] Subagent runs `git merge origin/main`, resolves conflicts, commits, pushes
- [ ] Loop returns to 11b.1 for a clean merge (should succeed now)
- [ ] CI gate proceeds normally after conflict resolution

### Max retries exhausted — standalone mode

#### Setup
1. Create a scenario where CI will keep failing (e.g., environment-specific failure the agent can't fix)
2. Run `/dev-task {task-id}` (standalone mode, no --merge)

#### Verify
- [ ] Fix loop runs 3 times (prints CI FIX banners for attempts 1/3, 2/3, 3/3)
- [ ] After 3rd failure, prints `CI GATE FAILED` banner with failing check names
- [ ] Pause point presents two options: (1) fix manually, (2) close PR and clean up
- [ ] Choosing (2) triggers PR Failure Cleanup (orphan close, branch delete, status reset)
- [ ] Does NOT proceed to Step 12

### Max retries exhausted — merge-mode

#### Setup
1. Same failing scenario as above
2. Run `/dev-task {task-id} --merge`

#### Verify
- [ ] Fix loop runs 3 times (no user pauses)
- [ ] After 3rd failure, triggers PR Failure Cleanup automatically
- [ ] Orphaned PR closed, branch deleted, task status reset to `[ ]`
- [ ] Does NOT proceed to Step 12
- [ ] When called from dev-loop, Phase 3a-retry picks up the reset task

### Timeout handling

#### Verify
- [ ] Actions API polling uses 10-minute total timeout (20 polls × 30s)
- [ ] If timeout fires (stuck check), treated as a failure — enters fix loop

---

## Enriched Metrics (v1.4.0+)

### dev-task measurement points

#### Verify
- [ ] Step 8 (Simplify): tallies fix counts by category (dry, dead_code, naming, complexity, consistency)
- [ ] Step 9 (Requirements): counts MET/PARTIAL/NOT_MET/UNVERIFIABLE verdicts
- [ ] Step 10 (Coverage): captures coverage_before, coverage_after, coverage_delta (best-effort)
- [ ] Step 11b.3: records one-line CI failure descriptions in ci_failures array
- [ ] Step 12c: captures review_verdict, review_findings, review_fixes_applied, review_agents
- [ ] Step 12e.2: JSONL line includes all new fields (simplify, requirements, review, ci, model, coverage)

### Backward compatibility

#### Verify
- [ ] Old metrics.jsonl files (without fix cascade fields) are still valid JSONL
- [ ] dev-loop retrospective handles mixed old + enriched records (excludes old from fix cascade aggregates)
- [ ] plan-session Phase 4 shows only estimation accuracy line if no enriched fields exist
- [ ] `/metrics` command loads and analyzes old-format records alongside enriched ones

### /metrics command

#### Verify: No data
- [ ] With no metrics.jsonl files: prints "No metrics data found" message and stops

#### Verify: Basic analysis
- [ ] Loads records from all planning/*/metrics.jsonl files
- [ ] Reports record count, project count, enriched vs legacy count
- [ ] Computes fix cascade aggregates (first-time quality rate, simplify breakdown, review distribution, CI pass rate)
- [ ] Computes estimation accuracy by complexity tier

#### Verify: Filtering
- [ ] Project name filter: only reads planning/{name}/metrics.jsonl
- [ ] Date range: --from and --to filter records by ts field
- [ ] Compare mode: side-by-side table for two projects

#### Verify: Trends
- [ ] With 10+ enriched records: splits into halves and computes improving/declining/stable
- [ ] With <10 enriched records: prints "Not enough data" message

#### Verify: Recommendations
- [ ] Generates 1-3 actionable recommendations based on threshold rules
- [ ] When all metrics are healthy: prints "All metrics are within healthy ranges"

#### Verify: PostHog export
- [ ] With POSTHOG_PROJECT_API_KEY set: sends batch events via curl
- [ ] Without API key: prints setup instructions and skips export gracefully
- [ ] Reports event counts per event type after export

---

## Scenario 21: /research — Project With Docs

### Setup
1. Open a project that has a `docs/` directory with multiple markdown files

### Run
```
/research add retry logic to the payment service API calls
```

### Verify
- [ ] Agent discovers docs directory
- [ ] Agent selects relevant files (not all files)
- [ ] Output is structured with "Research Results" format
- [ ] Output includes "Relevant Project Docs", "Recommended Approach", "Key Constraints"
- [ ] No raw file contents in output — only distilled summaries
- [ ] Intermediate reasoning does not appear in main session

---

## Scenario 22: /research — Project Without Docs

### Setup
1. Open a project that has no `docs/`, `documentation/`, or `doc/` directory

### Run
```
/research implement a caching layer
```

### Verify
- [ ] Detects no docs directory
- [ ] Informs user and proceeds with web-only research
- [ ] Web search results are summarized, not raw
- [ ] Output still follows structured format

---

## Scenario 23: /research — Web Search Triggered

### Setup
1. Open a project with docs that don't cover the topic

### Run
```
/research integrate with Stripe webhooks
```

### Verify
- [ ] Agent reads local docs first
- [ ] Agent identifies gap (Stripe not covered locally)
- [ ] Web search is triggered and results are summarized
- [ ] Output clearly indicates web research was performed

---

## Scenario 24: /research — Simple Solution Bias

### Run
```
/research implement authentication for the API
```

### Verify
- [ ] Output leads with simplest, most standard approach
- [ ] Complex alternatives mentioned only if genuinely warranted
- [ ] Language favors proven/established patterns

---

## Scenario 25: /research — Read-Only Enforcement

### Run
```
/research refactor the billing module
```

### Verify
- [ ] Agent does not create or modify any files
- [ ] Agent does not prompt the user with questions
- [ ] Only the final structured output appears in the session

---

## Scenario 26: /research-docs — Full Audit With Existing Docs

### Setup
1. Open a project with a `docs/` directory that has some but not all modules documented

### Run
```
/research-docs
```

### Verify
- [ ] Detects project structure (modules, services)
- [ ] Lists existing docs as CURRENT
- [ ] Identifies missing docs
- [ ] Identifies stale docs (if any references are outdated)
- [ ] Presents audit summary before writing anything
- [ ] Waits for user confirmation

---

## Scenario 27: /research-docs — Single Module Focus

### Setup
1. Open a project with a `docs/` directory

### Run
```
/research-docs accounts
```

### Verify
- [ ] Focuses only on the accounts module
- [ ] Reads accounts source code (routes, models, handlers)
- [ ] Generates doc following existing naming convention
- [ ] Does not touch other docs

---

## Scenario 28: /research-docs — No Docs Directory

### Setup
1. Open a project with no `docs/` directory

### Run
```
/research-docs
```

### Verify
- [ ] Creates `docs/` directory
- [ ] Identifies all modules as missing docs
- [ ] Generates docs following sensible defaults
- [ ] Updates CLAUDE.md references if applicable

---

## Scenario 29: /research-docs — Style Detection

### Setup
1. Open a project with existing docs that use a specific style (tables, ASCII diagrams, etc.)

### Run
```
/research-docs
```

### Verify
- [ ] Generated docs match the naming convention of existing docs
- [ ] Generated docs use the same heading structure and content patterns
- [ ] Does not overwrite or reformat existing current docs

---

## Scenario 30: /prd — Full Interactive Session

### Setup
1. Open any software project with a `CLAUDE.md` and at least one code directory
2. Have a clear feature idea in mind (e.g., "add user notifications")

### Run
```
/prd april-2026-notifications
```

### Verify
- [ ] Phase 0 creates `planning/april-2026-notifications/` if it doesn't exist
- [ ] Phase 0 detects project toolchain correctly
- [ ] Phase 0 reads `CLAUDE.md`, `README.md`, and relevant `docs/` markdown files
- [ ] Phase 0 skips changelogs, license files, and contributor guides in `docs/`
- [ ] Phase 1 questions reflect what was learned from docs (no asking about things already documented)
- [ ] Phase 0 spawns researcher agent and incorporates findings
- [ ] Phase 1 asks Q2 (problem statement) first — not multiple questions at once
- [ ] Each question waits for a response before asking the next
- [ ] Phase 1 probes vague answers with follow-up questions
- [ ] Phase 1 asks depth probes (Q4a) for each feature mentioned in Q4
- [ ] Phase 2 spawns researcher agent with feature list for enrichment
- [ ] Phase 3 generates complete PRODUCT-SPEC.md with all sections populated:
  - [ ] Overview, Problem Statement, Users & Context
  - [ ] Feature sections with ### headings
  - [ ] Acceptance criteria as `- [ ]` checkboxes
  - [ ] Technical Constraints, Scope (In/Out), Priorities, Success Criteria
  - [ ] Each feature has a **Source Map** field listing existing files the feature touches (populated from Phase 2 researcher pass; present even if empty with a note)
  - [ ] Each feature has a **Testing Strategy** field naming the test layer and a one-sentence rationale (populated from Phase 2 test-layer probe)
  - [ ] Top-level **Testing Strategy** section contains a table mapping every feature to its test layer and rationale
  - [ ] **Resolved Decisions** section (replacing Open Questions) records every uncertainty from Q8 as a decision or default + rationale — no "TBD" or "defer to plan-session" entries
  - [ ] No section contains a TODO placeholder or an unresolved question that would block plan-session from generating tasks
- [ ] Phase 4 presents complete spec and iterates on feedback
- [ ] Phase 5 writes `planning/april-2026-notifications/PRODUCT-SPEC.md`
- [ ] Phase 5 prints PRD COMPLETE block with feature count and next step
- [ ] Phase 0 detected repo name is printed in the summary
- [ ] Handoff line is `NEXT: /plan-session {detected-repo} april-2026-notifications` (two args, no `{repo}` placeholder literal)
- [ ] Handoff includes the "⚠ Do NOT skip /plan-session" block
- [ ] Running the printed handoff command succeeds (reads the spec)
- [ ] Resulting task store entries all have `repo` populated with the detected value

---

## Scenario 31: /prd — Vague/Minimal Input

### Setup
1. Prepare to give very short, vague answers (e.g., "something better", "it should work faster")

### Run
```
/prd test-vague-input
```

### Verify
- [ ] When Q2 answer is vague ("make it better"), command probes with a follow-up before moving on
- [ ] When Q4 features are one-word ("search", "auth"), command asks depth probes
- [ ] When acceptance criteria can't be derived from the answer, criterion goes to Open Questions instead of being invented
- [ ] PRODUCT-SPEC.md Open Questions section is populated (not empty)
- [ ] No acceptance criteria contains subjective language ("works correctly", "fast", "good")
- [ ] PRODUCT-SPEC.md is still written and is valid input for `/plan-session` even with sparse answers
- [ ] Plan-session can run on the output without errors

---

## Scenario 32: /research-docs — testing.md from test-readiness digest

### Setup
1. Open a project that has both a `docs/` directory and a `docs/test-readiness/` directory
2. Ensure `docs/test-readiness/test-system.md` exists and has the layer/framework/budget content produced by `/test-system-design`
3. Ensure `docs/testing.md` does NOT yet exist

### Run
```
/research-docs
```

### Verify
- [ ] Step 1 detects testing infrastructure and adds the testing module to the project map
- [ ] Step 2 lists `docs/test-readiness/*` files separately as **authoritative test source** (not as candidates for editing)
- [ ] Audit summary includes a `TEST-READINESS:` section enumerating those files
- [ ] Step 3 marks `docs/testing.md` as MISSING
- [ ] Step 5 generates `docs/testing.md` as a concise digest (~150 lines or less)
- [ ] Generated doc includes the Layers table populated from `test-system.md`
- [ ] Generated doc has a `## References` section linking back to `docs/test-readiness/test-system.md` and `docs/test-readiness/test-readiness-plan.md`
- [ ] `docs/test-readiness/*` files are NOT modified

---

## Scenario 33: /research-docs — testing.md inferred from test code

### Setup
1. Open a project with test runner configs (e.g., `vitest.config.ts` or `pytest.ini`) and test files in `tests/` or `__tests__/`
2. Ensure no `docs/test-readiness/` directory exists
3. Ensure `docs/testing.md` does NOT yet exist

### Run
```
/research-docs
```

### Verify
- [ ] Step 1 detects runner configs and test directories, adds testing module to project map
- [ ] No `TEST-READINESS:` section appears in the audit summary
- [ ] Step 3 marks `docs/testing.md` as MISSING
- [ ] Step 5 generates `docs/testing.md` via Path B (inferred)
- [ ] Top of file has an inferred-from-observation note and recommends running `/test-system-design`
- [ ] Layers table reflects observed framework and directories
- [ ] "Running tests" section uses commands extracted from `package.json` scripts, `Makefile`, or CI workflow

---

## Scenario 34: /research-docs — testing.md placeholder for greenfield

### Setup
1. Open a project with code but no tests and no `docs/test-readiness/` directory
2. Ensure `docs/testing.md` does NOT yet exist

### Run
```
/research-docs
```

### Verify
- [ ] Step 1 still adds the testing module to the project map (as unfilled placeholder)
- [ ] Step 3 marks `docs/testing.md` as MISSING (mandatory category — applies even with zero tests)
- [ ] Step 5 generates `docs/testing.md` via Path C (placeholder)
- [ ] Stack-appropriate default framework is suggested (e.g., Vitest for TS, pytest for Python, `go test` for Go)
- [ ] Layers table contains TODO markers for unit / integration / smoke / E2E
- [ ] `## Next steps` footer points to test-readiness plugin's `/test-inventory`, `/test-system-design`, `/test-roadmap`
- [ ] Other module docs are still generated normally — behavior matches the 4.3.0 baseline for non-test modules

---

## Scenario 35: /dev-task Step 8.5 — Auto-Docs Refresh on Doc-Affecting Change

### Setup
1. Open a project that has a `docs/` directory with at least one doc that references an endpoint or model file (e.g., `docs/api-billing.md` references `src/api/billing/routes.ts` or the `Invoice` model)
2. Create a planning task whose acceptance criteria require renaming or removing the referenced endpoint/model

### Run
```
/dev-task {TASK-ID}
```

### Verify
- [ ] Step 8 (Pre-Ship Checks) completes
- [ ] Step 8.5a dispatches the `shipwright:docs-refresher` agent
- [ ] Agent output ends with an `AUTO_DOCS_METRICS:` block (parsed by Step 8.5b)
- [ ] At least one `docs/*.md` file is modified by the agent
- [ ] A separate commit `docs: refresh {scope}` appears on the branch (verify via `git log --oneline`)
- [ ] Step 8.5c prints `✓ Docs refreshed: N file(s), M lines ({sha})`
- [ ] Step 8.5d fires `shipwright_auto_docs` PostHog event with `updated=true`
- [ ] Step 9 pushes BOTH the implementation commit AND the docs commit
- [ ] The opened PR contains the doc edits in its diff
- [ ] `planning/{session}/metrics.jsonl` record for this task contains `"auto_docs":{"updated":true,"files_changed":N,"lines_changed":M,"skipped_reason":null}`

---

## Scenario 36: /dev-task Step 8.5 — Negative (No Doc Impact)

### Setup
1. Project with a `docs/` directory
2. A task that changes only test fixtures or internal utility files NOT referenced by any doc

### Run
```
/dev-task {TASK-ID}
```

### Verify
- [ ] Agent runs but finds no candidate docs (pre-filter returns empty) OR finds candidates but all references still resolve
- [ ] No `docs: refresh` commit on the branch
- [ ] Step 8.5c prints `⏭ Docs refresh skipped (no_stale_refs)`
- [ ] PostHog event fires with `updated=false`, `skipped_reason="no_stale_refs"`
- [ ] Metrics record has `"auto_docs":{"updated":false,"files_changed":0,"lines_changed":0,"skipped_reason":"no_stale_refs"}`
- [ ] Pipeline proceeds normally to Step 9

---

## Scenario 37: /dev-task Step 8.5 — No Docs Directory

### Setup
1. A repo with NO `docs/`, `documentation/`, or `doc/` directory at root
2. Any planning task in that repo

### Run
```
/dev-task {TASK-ID}
```

### Verify
- [ ] Step 8.5a dispatches the agent
- [ ] Agent's first check fails (no docs dir) and it emits `AUTO_DOCS_METRICS` with `skipped_reason="no_docs_dir"`
- [ ] No commit, no edits anywhere
- [ ] Step 8.5c prints `⏭ Docs refresh skipped (no_docs_dir)`
- [ ] Metrics record has `"auto_docs":{"updated":false,"files_changed":0,"lines_changed":0,"skipped_reason":"no_docs_dir"}`
- [ ] Pipeline does NOT error or pause — proceeds to Step 9 normally
- [ ] No `docs/` directory is created by the auto-refresher (creation is only for `/research-docs`)

---

## Scenario 38: /metrics — Auto-Docs Aggregation

### Setup
1. Run `/dev-loop` or a sequence of 3+ `/dev-task` runs in a project with `docs/`, ensuring a mix of outcomes:
   - At least one task that updated docs
   - At least one task that skipped with `no_stale_refs`
2. Optionally, mix in one pre-v4.5.0 record (manually crafted JSONL line with no `auto_docs` field) to verify legacy handling

### Run
```
/metrics {session}
```

### Verify
- [ ] Report includes an "Auto-docs:" block under the FIX CASCADE section
- [ ] `Update rate` is computed correctly (% of tasks with `auto_docs.updated == true`)
- [ ] `Lines/task (all)` includes zeros (mean across every record, including skips)
- [ ] `Lines/task (when updated)` only averages over records with `updated == true`
- [ ] Skipped breakdown shows percentages by reason — `no_stale_refs`, `no_source_changes`, `no_docs_dir`, `legacy_record`
- [ ] `commit_failed` and `agent_error` appear on a separate "Failures:" line, not folded into the benign skip buckets
- [ ] Legacy records (missing `auto_docs` entirely) appear in the `legacy_record` bucket, not as failures
- [ ] If update rate < 20% AND avg `files_changed` > 5/task → recommendation #12 appears
- [ ] If `no_docs_dir` accounts for > 30% of recent records → recommendation #13 appears
- [ ] If `commit_failed`+`agent_error` > 10% of recent records → recommendation #14 appears
- [ ] When no records have `auto_docs` data at all (only pre-v4.5.0 records), the Auto-docs section is omitted

---

## Scenario 39: /dev-task Step 8.5 — Commit Failure Does Not Fake Success

### Setup
1. A project with a `docs/` directory containing at least one doc that references a changed endpoint/model (so the refresher will edit it)
2. Install a pre-commit hook that always fails (`exit 1`), OR configure `commit.gpgsign=true` with no available signing key

### Run
```
/dev-task {TASK-ID}
```

### Verify
- [ ] The docs-refresher edits at least one `docs/*.md` and stages it
- [ ] Step 4's post-commit verification detects HEAD did not advance to a `docs: refresh` commit
- [ ] Agent emits `AUTO_DOCS_METRICS` with `updated:false`, `skipped_reason:"commit_failed"`, `commit_sha:null`
- [ ] Step 8.5c prints `⏭ Docs refresh skipped (commit_failed)` — NOT `✓ Docs refreshed`
- [ ] No `docs: refresh` commit exists on the branch (`git log --oneline`)
- [ ] `files_changed`/`lines_changed` are `0` — no metrics fabricated from the implementation commit
- [ ] PostHog event + metrics.jsonl record `skipped_reason:"commit_failed"`
- [ ] Pipeline does NOT stall — proceeds to Step 9 (a docs-refresh failure never blocks the ship)

---

## Scenario 40: /dev-task Step 8.5 — Unparseable Agent Result

### Setup
1. Any project with `docs/`
2. Simulate the docs-refresher returning no `AUTO_DOCS_METRICS` block (e.g., agent crash, tool error, or trailing prose only) — can be forced in a dry-run harness

### Run
```
/dev-task {TASK-ID}
```

### Verify
- [ ] Step 8.5b finds no parseable `AUTO_DOCS_METRICS` block
- [ ] Prints `⚠ Docs refresh result unparseable — recording agent_error and continuing`
- [ ] `auto_docs_updated=false`, `auto_docs_skipped_reason="agent_error"`, `commit_sha=null`
- [ ] PostHog `shipwright_auto_docs` event still fires with `updated=false skipped_reason=agent_error`
- [ ] metrics.jsonl record has `"auto_docs":{"updated":false,"files_changed":0,"lines_changed":0,"skipped_reason":"agent_error"}`
- [ ] `/metrics` later buckets this as `agent_error` (a failure), NOT `legacy_record`
- [ ] Pipeline continues to Step 9 without stalling

---

## Scenario 41: Plan Viz Render — Hosted Store Configured

Covers the additive render step in `/plan-session` Step 6a and `/prd` Phase 4.
The underlying parse/render/upload logic is already unit- and integration-tested
(`render-plan*.test.ts`); this scenario verifies the command-body wiring only.

### Setup
1. Install the plugin so `render-plan.ts` resolves under `~/.claude/plugins/cache/*/shipwright/`
2. Export a reachable hosted task store: `SHIPWRIGHT_TASK_STORE_URL` and `SHIPWRIGHT_TASK_STORE_TOKEN`
3. Have a session ready to plan (any repo)

### Run
```
/plan-session {repo} {session}
```
(and/or `/prd {session}` to exercise the spec path)

### Verify
- [ ] `planning/{session}/PLAN.md` (or `PRODUCT-SPEC.md`) is written exactly as before — the markdown step is unchanged
- [ ] After the write, the render block runs `render-plan.ts` resolved via the `find … | sort -V | tail -1` idiom
- [ ] `--type plan` is used for `PLAN.md`, `--type spec` for `PRODUCT-SPEC.md`
- [ ] The shareable URL printed to stdout is surfaced as a `Plan viz: {url}` line in the `QUEUED` / `PRD COMPLETE` confirmation block
- [ ] No error from the render step changes the command's exit behavior — the plan/spec is committed regardless

---

## Scenario 42: Plan Viz Render — Hosted Store Unset (Graceful Skip)

The required negative path: the viz must degrade to a one-line notice and never
block the plan when the hosted env is absent.

### Setup
1. `unset SHIPWRIGHT_TASK_STORE_URL SHIPWRIGHT_TASK_STORE_TOKEN` (or run where they were never set)
2. Have a session ready to plan (any repo)

### Run
```
/plan-session {repo} {session}
```
(and/or `/prd {session}`)

### Verify
- [ ] `planning/{session}/PLAN.md` (or `PRODUCT-SPEC.md`) is still written normally
- [ ] The render block prints `⏭ Plan viz skipped — SHIPWRIGHT_TASK_STORE_URL/TOKEN unset.` and runs nothing else
- [ ] No `Plan viz:` line appears in the confirmation block
- [ ] The command completes successfully — the plan is never blocked on visualization
- [ ] (Optional, same skip notice) If the env is set but `render-plan.ts` is not found in the plugin cache, the block prints `⏭ Plan viz skipped — render-plan.ts not found in plugin cache.` and proceeds

---

## Scenario 43: Dev Task Step 1 — Does Not Resume Another Agent's In-Progress Task

Covers a real incident: on a repo-scoped agent token, the task store's `GET
/tasks?status=in_progress` visibility (`agentScope`) is a repo-wide pool — it
returns tasks assigned to *any* agent sharing that repo, not just the caller's
own. Step 1's "resume interrupted task" check blindly took `result.tasks[0]`
from that unfiltered list, so one agent could resume (and start committing to)
a task actively owned by a completely different agent.

### Setup
1. Two agent tokens scoped to the same repo (`agent-A`, `agent-B`)
2. A task assigned to `agent-B`, `status: in_progress`, with no branch/PR yet
3. No task assigned to `agent-A` is `in_progress`

### Run
As `agent-A`, invoke `/shipwright:dev-task`

### Verify
- [ ] Step 1's curl now filters `.tasks` by `select(.assignee == $SHIPWRIGHT_AGENT_ID)` before checking for an interrupted task
- [ ] `agent-B`'s in_progress task is NOT printed as `↩ Resuming interrupted task`
- [ ] `agent-A` instead falls through to the `ready=true` pick (or exits `[silent]` if none)
- [ ] `agent-B`'s task record is untouched — no `startedAt` re-stamp, no worktree created for it

### Related — check-dev-task precheck
- [ ] `check-dev-task.ts`'s stale-in_progress reset loop does not reset or stamp `agent-B`'s task (verify via `bun test plugins/shipwright/scripts/check-dev-task.test.ts`, cross-agent scoping tests)
- [ ] HITL-pending notifications only surface tasks where `assignee === SHIPWRIGHT_AGENT_ID`

### Related — task-store API
- [ ] `GET /tasks?status=in_progress&assignee={own-agent-id}` on a repo-scoped token now actually narrows results to that assignee (previously silently ignored the query param) — see `task-store/src/api.smoke.test.ts` and `tasks.integration.test.ts`

---

## Test Readiness Pipeline scenarios

Imported from the former `test-readiness` plugin. These exercise the six `/test-*` commands and the three cross-cutting contracts (canary-execution, speed-budgets, repo-config). Numbered `TR-N` to stay clear of the shipwright scenario numbering above. Phases 1–4 are read-only on source; Phase 5 writes to GitHub.

### TR-1 — Commands load
**Steps:** Install/refresh the plugin, run `/help`.
**Expected:** All six commands listed: `/test-inventory`, `/test-design`, `/test-migration`, `/test-roadmap`, `/test-publish`, `/test-debt`. No collision with the existing `/metrics` command.

### TR-2 — Phase 1 against a small TypeScript repo
**Steps:** `cd` into a small TS repo (e.g. a Hono service); run `/test-inventory`.
**Expected:** `docs/test-readiness/test-inventory.md` created; stack profile identifies TypeScript + package manager; summary table has ≥1 row; critical-path roster populated; no source files modified.

### TR-3 — Phase 2 requires Phase 1
**Steps:** In a fresh repo with no `docs/test-readiness/`, run `/test-design`.
**Expected:** Refuses with "run /test-inventory first." No artifact written.

### TR-4 — Phase 2 produces blueprint
**Steps:** After a successful Phase 1, run `/test-design`.
**Expected:** `docs/test-readiness/test-system.md` created; framework matrix per layer; local-execution architecture has ≥1 substitute; canary contract quotes `TEST_TARGET_URL`; speed-budgets table present.

### TR-5 — Phase 3 buckets tests
**Steps:** After Phases 1+2, run `/test-migration` in a repo with existing tests.
**Expected:** `docs/test-readiness/test-migration.md` created; ≥1 of the five buckets has entries; `delete (redundant)` entries list a canonical owner; `rebuild` entries on passing tests have a risk callout.

### TR-6 — Phase 4 synthesizes
**Steps:** After all three prior phases, run `/test-roadmap`.
**Expected:** `docs/test-readiness/test-readiness-plan.md` created with all six sections (where we are, where we want, the gap, roadmap of 5 milestones, task list, open risks); task list has ≥1 `T-NNN | M# | … | verify` entry; speed delta section present.

### TR-7 — Canonical-layer rule enforced
**Steps:** In a repo with duplicate coverage (a calc tested at both unit and E2E), run all four phases.
**Expected:** Inventory lists the calc at unit layer only; migration places the E2E test in `delete (redundant)` with the unit test as canonical owner; roadmap M5 includes the deletion task.

### TR-8 — Speed bucketing flags mis-layered tests
**Steps:** In a repo with a deliberately slow "unit" test (boots a DB, >1s), run all four phases with speed measurement enabled in Phase 3.
**Expected:** Migration places the slow test in `rebuild` with reason "speed > unit hard cap, layer mismatch"; roadmap surfaces it in the speed delta section.

### TR-9 — Read-only on source
**Steps:** Snapshot `git status`, run all four phases, snapshot again.
**Expected:** Only files under `docs/test-readiness/` added/modified. No source or existing test files touched.

### TR-10 — Phase 5 dry-run
**Steps:** After Phases 1–4 produce artifacts, run `/test-publish --dry-run`.
**Expected:** Prints planned milestones, labels, per-issue summaries; no GitHub writes; lists target repo (from `origin` or `--repo`).

### TR-11 — Phase 5 publish (sandbox repo)
**Steps:** In a sandbox GitHub repo with `gh` authenticated, run `/test-publish` after Phases 1–4; confirm at the prompt.
**Expected:** Labels created (`test-readiness`, `milestone:m1`–`m5`, `layer:*`, `bucket:*`, `criticality:*`, `ready`, `blocked`); milestones M1–M5 created/matched; one self-contained issue per task; tracking issue `Test Readiness Roadmap` with per-milestone checkboxes; `docs/test-readiness/test-readiness-issues.md` written; `gh issue list --search "label:test-readiness label:ready sort:created-asc" --limit 1` returns an M1 issue.

### TR-12 — Phase 5 idempotency
**Steps:** Run `/test-publish` again without changing the roadmap.
**Expected:** No duplicate issues (matched by `<!-- task-id: T-NNN -->`); summary reports "K issues already existed (skipped)."

### TR-13 — Phase 5 refresh
**Steps:** Close predecessor issues via `gh issue close <n>`, then run `/test-publish --refresh`.
**Expected:** Issues whose predecessors are all closed gain `ready` and lose `blocked`; tracking-issue checkboxes updated; no new issues created.

### TR-14 — Idempotency (Phases 1–4)
**Steps:** Run all four phases, capture artifact hashes, re-run without source changes, compare.
**Expected:** Outputs stable (differ only in minor metadata like timestamps). Deterministic given the same source.

### TR-15 — Sizing fan-out rule
**Steps:** In a repo where Phase 3 yields a task touching 3+ services, run `/test-roadmap`.
**Expected:** No single task touches all service files; instead one parent task (P-NNN, no verify) and one child task per service (T-NNN a/b/c…) each with its own verify. Open-risks lists no "oversized task" entries for split tasks.

### TR-16 — Audit decision rows
**Steps:** Run `/test-roadmap` where Phase 3 has a bucket with 5+ `delete (redundant)`/`rebuild` tests, then `/test-publish --dry-run`.
**Expected:** Plan template includes an "Audit task decision rows" section (item/decision/criterion table); dry-run issue body for audit tasks includes an "## Audit decisions" section with one row per item.

### TR-17 — Separate canary entry point
**Steps:** Run `/test-design` in any TypeScript repo.
**Expected:** `test-system.md` prescribes a dedicated canary entry point (`test:canary` or `playwright.canary.config.ts`); contract states it must not reuse `test:smoke`; two CI jobs documented (`smoke` pre-merge, `canary` post-deploy with `TEST_TARGET_URL`).

### TR-18 — Canary safety lint
**Steps:** In a repo where Phase 3 marks ≥1 test canary-eligible, run `/test-migration`, then `/test-publish --dry-run`.
**Expected:** Migration shows canary safety-lint result per eligible test; tests with unclassified write patterns reclassified `promote/rebuild` not `reuse`; issue body for canary-promoting tasks includes the "No prod-write paths" criterion + grep command.

### TR-19 — Runner-discovery M1 task
**Steps:** Run `/test-roadmap` against any repo.
**Expected:** M1 always includes a "naming convention + runner-exclusion config" task with three deliverables (naming-convention doc, per-runner exclusion config, verification commands), even if a partial convention already exists.

### TR-20 — Deploy→canary→promote reference
**Steps:** Run `/test-design` in any repo.
**Expected:** `test-system.md` repo-config section links to `skills/repo-config/references/deploy-canary-promote.md`; that file exists in the installed plugin; covers non-empty-tag guard, skipped-job-counts-as-success hole, and TEST_TARGET_URL staging-vs-prod.

### TR-21 — Planning-debt metric command
**Steps:** In a repo with git history referencing task IDs (`T-001`, `fix(T-042)`) across ≥2 milestones, run `/test-debt`.
**Expected:** `docs/test-readiness/test-debt.md` created with a per-milestone table (Milestone, Total commits, Corrective, Ratio, Flag); ratio > 0.25 flagged red; milestones with <5 commits reported but not flagged; planning-debt notes present for red-flag milestones.

**Known gap (carried over):** Phase 3 speed measurement is inspection-based unless the runner is installed/configured; a "speed not measured" flag in the artifact is documented behavior, not a bug.

---

## Versioning Checklist (for every PR to this repo)

- [ ] Does this PR change any file under `commands/`, `skills/`, `agents/`, or `hooks/`?
  - **Yes** → bump `plugins/shipwright/.claude-plugin/plugin.json` version (patch for fixes, minor for features)
  - **No** (docs-only, like ADOPTION-ROADMAP.md) → no version bump needed
- [ ] Bump `plugins/shipwright/README.md` version in heading (if present)
- [ ] Bump `.claude-plugin/marketplace.json` version whenever any plugin version changes
- [ ] Version bump is in the **same PR** as command changes — never separate
- [ ] After merging: verify `/plugin marketplace update` + `/plugin update shipwright` picks up the new version
