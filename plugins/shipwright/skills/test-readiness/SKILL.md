---
name: test-readiness
description: >
  Orchestrates the full test-readiness pipeline (phases 1–5), once per
  qualifying repo under repos/, each in its own worktree + branch. Runs
  test-inventory → test-design → test-migration → test-roadmap →
  test-publish in sequence per repo, starting from the first stale artifact.
  Invoked by the `shipwright-test-readiness` cron on a daily schedule; exits
  early for a repo when all of its phase artifacts are fresh.
---

# test-readiness skill

## Purpose

Drive the complete test-readiness pipeline from the first stale phase to
publication. This skill is the cron-facing entry point — it picks up where the
staleness guard left off and runs all necessary phases to bring the docs current.

## When invoked

By the `shipwright-test-readiness` cron, which runs
`/shipwright:test-readiness --full --publish` daily. The cron fires
unconditionally on schedule; the flags below decide what actually happens.

## Arguments

Flags are additive — invoking with no flags preserves the original behavior
(staleness-gated, phase 5 in dry-run), so agents still on the old cron prompt
keep working unchanged.

| Flag | Effect |
|------|--------|
| `--full` | Skip the staleness check entirely and run all phases 1→5 regardless of artifact freshness. Without it, the staleness gate decides the starting phase and exits early when everything is fresh. |
| `--publish` | Run phase 5 as a **real publish** — forward real-queue mode to `/shipwright:test-fix` so it writes task-store tasks unattended (no confirmation gate — test-fix never has one, matching entropy-fix/error-fix). Without it, phase 5 runs `--dry-run` (preview only, no task-store writes). |
| `--dry-run` | Explicit preview: phase 5 runs `--dry-run`. This is the default when `--publish` is absent. |

## Staleness check

**Skipped entirely when `--full` is passed** (the cron's default) — all phases
1→5 run. The check below only applies when `--full` is absent.

Before running any phase, re-read the phase artifacts (scoped to the current
repo/worktree — see Step 1) to determine the earliest stale phase. The
artifacts and their canonical paths (relative to the repo root):

| Phase | Artifact path |
|-------|--------------|
| 1 — test-inventory | `docs/test-readiness/test-inventory.md` |
| 2 — test-design | `docs/test-readiness/test-system.md` |
| 3 — test-migration | `docs/test-readiness/test-migration.md` |
| 4 — test-roadmap | `docs/test-readiness/test-readiness-plan.md` |

Threshold: 24 hours (default). If the file is missing or older than 24 hours,
it is stale. All phases from the first stale one through phase 4 run; phase 5
(publish) always runs when phase 4 ran, because the roadmap needs to be
re-published after any update.

## Process

This agent's workspace can have multiple repos checked out under `repos/`
(see `plugins/shipwright/scripts/check-helpers.ts`'s `resolveRepoDirs`).
Step 1 below is repo-aware: it resolves a list of qualifying repos and Steps
2-3 run once **per repo**, each in its own worktree + branch, independent of
every other repo. Step 4 (Report) prints one aggregated summary across every
repo processed.

### Step 1: Resolve the repo list

Determine which repos to process, in this priority order:

1. **Precheck-driven (preferred).** This cron's `preCheck`
   (`shipwright:check-test-readiness.ts`) already iterated every repo under
   `repos/`, applied the opt-in qualification (a repo qualifies only if it has
   a `docs/test-readiness/` directory — a repo without one is not the implicit
   target and is skipped), and its stdout — which became this prompt (see
   `admin/src/system-crons.ts`'s header comment: "When a preCheck script is
   set, its stdout becomes the actual prompt sent to Claude") — lists exactly
   which repo(s) have a stale or missing phase artifact, one repo name
   (`org/repo`) per section. Parse the repo names out of the invoking prompt
   and use that as the repo list. Skip any repo not named in the precheck
   output — it had nothing to run.
2. **Fallback (manual invocation, or no repo list available in the prompt).**
   Iterate `repos/*` directly and keep only repos with a `docs/test-readiness/`
   directory (the same opt-in signal the precheck uses):
   ```bash
   for dir in repos/*/; do
     [ -d "$dir/.git" ] && [ -d "$dir/docs/test-readiness" ] && basename "$dir"
   done
   ```
   A repo under `repos/` with no `docs/test-readiness/` directory is skipped
   cleanly — it is never silently treated as the implicit single target.

For each resolved repo, match the precheck's `org/repo` name back to its local
clone directory `repos/{dirname}` by checking each `repos/*/`'s
`git remote get-url origin` (or `.git/config`) for that owner/repo — same
matching approach as `research-docs.md` Step A0.

**For each repo in the resolved list, set up (or reuse) a worktree + branch
and run Steps 2-4 there** — never edit `repos/{dirname}` directly (see this
repo's own root `CLAUDE.md` for the worktree convention):

```bash
git -C repos/{dirname} pull
git -C repos/{dirname} worktree add \
  $SHIPWRIGHT_WORKTREE_DIR/{dirname}-docs-test-readiness-refresh-{YYYYMMDD} \
  origin/main -b docs/test-readiness-refresh-{YYYYMMDD}
```

Branch naming: `docs/test-readiness-refresh-<YYYYMMDD>` (today's date). If a
worktree/branch with that name already exists (e.g. a same-day rerun), reuse
it rather than recreating — check `$SHIPWRIGHT_WORKTREE_DIR` for an existing
`{dirname}-docs-test-readiness-refresh-{YYYYMMDD}` directory first.

All relative paths in Steps 2-4 (`docs/test-readiness/*.md`, phase artifact
mtimes, git history, etc.) resolve against that repo's worktree, not the bare
clone under `repos/`. Commit each repo's phase results (in its own worktree,
on its own branch) before moving to the next repo — one repo's work must not
block or be blocked by another's.

### Step 2: Determine the starting phase

If `--full` is set, start at phase 1. Otherwise check mtime of each phase
artifact in order (1 → 4), scoped to the current repo's worktree; the first
artifact that is missing or older than 24 hours marks the starting phase, and
if all are fresh for this repo, skip straight to the next repo in the
resolved list (no phases run for this repo).

### Step 3: Run phases sequentially

From the starting phase through phase 5, in the current repo's worktree:
- Phase 1: `/shipwright:test-inventory`
- Phase 2: `/shipwright:test-design`
- Phase 3: `/shipwright:test-migration`
- Phase 4: `/shipwright:test-roadmap`
- Phase 5: `/shipwright:test-fix` — pass no extra flag (real queue) when
  this skill was invoked with `--publish`; otherwise pass `--dry-run`
  (preview only, no task-store writes).

Run each skill using the Skill tool. If any phase fails for this repo, report
the failure for that repo and stop running further phases **for that repo
only** — do not run subsequent phases for it, as each depends on the previous
artifact. A failure in one repo does not stop the remaining repos in the
resolved list; move on to the next repo after logging the failure.

After phase 5 (or an early stop due to failure) completes for the current
repo, return to Step 1's per-repo loop for the next repo in the resolved
list. Once every repo has been processed (run or skipped for being fresh),
proceed to Step 4.

### Step 4: Report

After every repo in the resolved list has been processed, print one
aggregated summary across all repos, with a per-repo section: which phases
ran (or "skipped — all artifacts fresh" / "skipped — precheck did not flag
this repo"), and the number of task-store tasks created or updated (from
phase 5 output) for that repo.

## Failure handling

If a phase fails:
- Log which phase failed and include any error output.
- Do not run subsequent phases.
- Exit with a clear summary so the cron log shows the failure.
- A failure in the skill itself is always logged.

## Notes

- This skill handles its own staleness check (step 2) **unless `--full` is
  passed**. With `--full` (the cron default) every phase runs; without it, a
  fresh set of artifacts makes the skill exit early.
- Phase 5 (`test-fix`) has no confirmation gate — the cron passes `--publish`,
  which forwards real-queue mode so it writes task-store tasks unattended.
  The publish step is idempotent (it dedupes on already-active T-NNN
  task-store IDs per repo), so a daily real run queues tasks for new work —
  including doc-layer tasks — without creating duplicates.
