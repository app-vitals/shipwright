---
description: Trimmed variant of dev-task — short spine of the mandatory steps with proof signals; mechanics live in references/dev-task-lean/
argument-hint: "<task-id>"
---

# Dev Task (Lean)

Given a task id, fetch it from the task store, build it, verify it, ship a PR. Same
pipeline as `/shipwright:dev-task`, with mechanics moved to
`plugins/shipwright/references/dev-task-lean/`. Each step below ends with a **Proof** line:
the observable signal that the step ran. Steps are never skipped for small or docs-only
changes — no size exemption. Run autonomously; pause only for an unresolvable build/test failure.

The mandatory-step list is `plugins/shipwright/references/required-steps/dev-task.json`.

## Arguments

`task-id` is **required**. If empty, respond `[silent]` and stop — no task-store queries.

## Step 1: Fetch & Validate Task

`GET $SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}`. 404 → print and stop. Only `pending` (check
dependencies first) or `in_progress` (already claimed) are workable; any other status → stop.
Block PRD-shaped tasks and tasks with no `branch`; defer to a fresh same-branch sibling.
Derive `{repo-slug}` (last segment of `repo`, lowercased) and detect the toolchain (cache first).
Mechanics: [task-lifecycle.md](../references/dev-task-lean/task-lifecycle.md).

## Step 2: Claim

`POST /tasks/{id}/claim` (skip if already `in_progress`). 200 → continue; 409/404 → `[silent]`, stop.

## Step 4: Worktree

Work only in `worktrees/{repo-slug}-{branch-slug}`. Before creating it, run the Branch/PR
Reality Check against live git/GitHub state, regardless of task-store status. Mechanics:
[worktree-recovery.md](../references/dev-task-lean/worktree-recovery.md).

## Step 5: Dispatch Implementation Subagent

Build the brief (title, description, acceptance criteria, layer, TDD-required, toolchain, CLAUDE.md),
heartbeat, then dispatch via the Agent tool with `run_in_background: false`, `model: task.model ?? 'sonnet'`,
`subagent_type` from the `dev-task` phase-methodology config (default `general-purpose`). The
subagent follows red-green-refactor, runs validation, records verification outcomes, commits, and
reports `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`. Handle status, retry and
model escalation per [implementation-dispatch.md](../references/dev-task-lean/implementation-dispatch.md).
Heartbeat again afterwards.

**Proof:** an Agent dispatch.

## Step 6: Simplify

Load principles (`.claude/shipwright/principles.md`, else `plugins/shipwright/references/principles.md`),
review `git diff main...HEAD`, fix DRY/dead code/naming/complexity/consistency, tally the counts
(`simplify_*`), re-run typecheck.

**Proof:** print `STEP 6 SIMPLIFY: {simplify_total} fixes`.

## Step 6.5: Spec Compliance Check

Dispatch a `general-purpose` subagent (`model: 'haiku'`, `run_in_background: false`) given only the
acceptance criteria and `git diff main...HEAD`; it returns MET/PARTIAL/NOT MET per criterion. Fix any
non-MET and re-dispatch until all MET.

**Proof:** an Agent dispatch.

## Step 7: Requirements Verification

Evaluate each acceptance criterion against the diff (MET/PARTIAL/NOT MET/UNVERIFIABLE), print the table,
tally `req_*`. Any PARTIAL/NOT MET after the fix loop → PATCH `status: blocked`,
`blockedReason: requirements_not_met`, stop.

**Proof:** print the `REQUIREMENTS VERIFICATION` table.

## Step 8: Pre-Ship Checks

Run install, lint (scoped when `lintScoped` is cached), typecheck, every test layer, and coverage, each
synchronously with a 600000 ms Bash timeout — never via a scheduled wakeup. Record every outcome to
`/verification-checks`. Failures, timeouts, and skips never block Step 9; CI is the arbiter.
Mechanics: [pre-ship-checks.md](../references/dev-task-lean/pre-ship-checks.md).

**Proof:** lint/test commands run; print the `PRE-SHIP CHECKS` block.

## Step 8.5: Auto-Refresh Docs

Dispatch `shipwright:docs-refresher` (`run_in_background: false`) for the branch against `main`; it
commits `docs: refresh` if anything is stale and emits `AUTO_DOCS_METRICS`. No parseable block →
record `agent_error` and continue. Do not push from here.

**Proof:** an Agent dispatch (a skip reason is fine).

## Step 9: Push & PR

Confirm verification outcomes were recorded (record them if not; never block the push), push, then reuse
the branch's open PR or create one via `gh pr create --body-file` (task id in the temp path). Failure
cleanup: [push-and-ci.md](../references/dev-task-lean/push-and-ci.md).

**Proof:** PR number and URL printed.

## Step 9b: CI Gate (conditional — runs on every PR; fix loop only on failure)

Poll the GitHub Actions API for the head SHA with an in-Bash loop (30 s interval, 10 min cap), judging
only the latest run per workflow. DIRTY merge state or a failing check enters the fix loop (max 6
attempts, each a fresh subagent given prior attempts). Exhausted → PATCH `status: blocked`,
`blockedReason: ci_max_retries_exhausted`, clean up, stop. Mechanics:
[push-and-ci.md](../references/dev-task-lean/push-and-ci.md).

**Proof:** `✓ CI checks passed`, the no-CI notice, or `CI GATE FAILED`.

## Step 10: Update Queue & Handoff

PATCH the task to `status: pr_open` with `pr`, `prCreatedAt`, `ciFixAttempts`, the `simplify*` counts,
`coverageDelta`, and `model` (capture the HTTP code; non-2xx → abort, do not report success). Then print
the `DONE: {id}` handoff block. Fields and format:
[handoff.md](../references/dev-task-lean/handoff.md).

**Proof:** `DONE: {id}` block printed after a 2xx PATCH.

## Intentionally Dropped

See [dropped-details.md](../references/dev-task-lean/dropped-details.md) for what was cut and why.
