---
name: test-readiness
description: >
  Orchestrates the full test-readiness pipeline (phases 1–5) for one repo,
  in its own worktree + branch. Runs test-inventory → test-design →
  test-migration → test-roadmap → test-fix in sequence, starting from the
  first stale artifact. Queued per repo by the admin system-cron scheduler;
  exits early when all of the repo's phase artifacts are fresh. Requires
  `--repo org/repo`.
argument-hint: "--repo org/repo [--full] [--publish] [--dry-run]"
---

# test-readiness skill

## Purpose

Drive the complete test-readiness pipeline from the first stale phase to
publication. This skill is the scheduler-facing entry point — it picks up where the
staleness guard left off and runs all necessary phases to bring the docs current.

## When invoked

By a task the admin system-cron scheduler queues for each repo, whose prompt is
`/shipwright:test-readiness --repo {repo} --full --publish`. The flags below
decide what actually happens.

## Arguments

Apart from the required `--repo`, flags are additive — with no other flags the
run is staleness-gated with phase 5 in dry-run.

| Flag | Effect |
|------|--------|
| `--full` | Skip the staleness check entirely and run all phases 1→5 regardless of artifact freshness. Without it, the staleness gate decides the starting phase and exits early when everything is fresh. |
| `--publish` | Run phase 5 as a **real publish** — forward real-queue mode to `/shipwright:test-fix` so it writes task-store tasks unattended (no confirmation gate — test-fix never has one, matching entropy-fix/error-fix). Without it, phase 5 runs `--dry-run` (preview only, no task-store writes). |
| `--repo org/repo` | **Required.** The one repo to process. Naming a repo explicitly is the opt-in, so the `docs/test-readiness/` opt-in check does not apply. Finds the clone under `repos/` or clones it. The staleness gate still applies (unless `--full`), so a fresh repo is a no-op. A missing `--repo` is a usage error (see Step 1). |
| `--dry-run` | Explicit preview: phase 5 runs `--dry-run`. This is the default when `--publish` is absent. |

## Staleness check

**Skipped entirely when `--full` is passed** (the scheduled default) — all phases
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

The skill runs for exactly one repo, given by `--repo org/repo`. Steps 2-3 run
in that repo's own worktree + branch, and Step 4 (Report) prints the summary.

### Step 1: Resolve the repo

`--repo org/repo` is required. If the invocation does not include it, print
the following and stop without scanning `repos/` or doing any work:

```
Usage: /shipwright:test-readiness --repo org/repo [--full] [--publish] [--dry-run]
```

Find the repo's clone by matching each `repos/*/`'s `git remote get-url origin`
against `org/repo`; if none matches, clone it
(`git clone https://github.com/{org}/{repo}.git repos/{repo}`). The local
directory is `repos/{dirname}`, which need not equal the `org/repo` string.
Naming the repo explicitly is the opt-in, so a repo without a
`docs/test-readiness/` directory is still processed. Step 2's staleness gate
still decides whether anything runs, so a fresh repo is a no-op.

**For the repo, set up (or reuse) a worktree + branch and run Steps 2-4 there** — never edit `repos/{dirname}` directly (see this
repo's own root `CLAUDE.md` for the worktree convention).

**Open-PR supersession check (run first, before any branch is created).**
A prior day's docs-refresh PR touching the same `docs/test-readiness/*.md`
files may still be open — e.g. stuck on review, CI, or awaiting a human.
Branching fresh from `origin/main` every day regardless creates a second PR
competing for the same files; if the new one merges first, the stuck PR
becomes permanently unmergeable (confirmed: a same-pattern collision turned
an older open docs-refresh PR CONFLICTING once a newer one merged). Before
creating a new branch, query for an existing **open** PR on any
`docs/test-readiness-refresh-*` branch (any date, not just today) for this
repo:

```bash
gh pr list --repo {org}/{repo} --state open \
  --json number,headRefName,createdAt
```

`gh` has no glob support for head-branch matching, so filter the JSON result
client-side, keeping only entries whose `headRefName` starts with
`docs/test-readiness-refresh-`. This check is distinct from, and runs
**ahead of**, the same-day-reuse check below — it looks for *any* earlier-day
open PR, not just today's.

- **No matching open PR found:** fall through to the fresh-branch flow below,
  unchanged.
- **Exactly one earlier-day open PR found:** reuse that PR's branch instead
  of branching fresh. Check out the existing branch into a worktree (or reuse
  an existing worktree for it if one is already present) and merge current
  `origin/main` into it:
  ```bash
  git -C repos/{dirname} pull
  git -C repos/{dirname} worktree add \
    $SHIPWRIGHT_WORKTREE_DIR/{dirname}-docs-test-readiness-refresh-{existing-date} \
    {existing-branch-name}
  cd $SHIPWRIGHT_WORKTREE_DIR/{dirname}-docs-test-readiness-refresh-{existing-date}
  git merge origin/main
  ```
  - **Merge succeeds cleanly:** proceed to Steps 2-4 in this worktree as
    normal — the branch and its open PR are now caught up with `main` and
    will absorb this run's updates instead of being superseded by a
    competing PR.
  - **Merge conflict:** do not attempt to resolve it automatically. Abort the
    merge (`git merge --abort`), **skip Steps 2-4 for that repo only**, and
    report the conflict explicitly and distinctly in Step 4's aggregated
    summary (see Step 4 below) — do not fold this into the "skipped — all
    artifacts fresh" case, since the repo was not fresh, it was blocked.

**Fresh-branch flow (no earlier-day open PR found, or same-day rerun):**

```bash
git -C repos/{dirname} pull
git -C repos/{dirname} worktree add \
  $SHIPWRIGHT_WORKTREE_DIR/{dirname}-docs-test-readiness-refresh-{YYYYMMDD} \
  origin/main -b docs/test-readiness-refresh-{YYYYMMDD}
```

Branch naming: `docs/test-readiness-refresh-<YYYYMMDD>` (today's date). If a
worktree/branch with that name already exists (e.g. a same-day rerun), reuse
it rather than recreating — check `$SHIPWRIGHT_WORKTREE_DIR` for an existing
`{dirname}-docs-test-readiness-refresh-{YYYYMMDD}` directory first. This
same-day-reuse check is separate from the open-PR supersession check above:
this one matches on today's exact branch name only, regardless of PR state;
the supersession check above matches on any earlier-day PR still open on
GitHub.

All relative paths in Steps 2-4 (`docs/test-readiness/*.md`, phase artifact
mtimes, git history, etc.) resolve against that repo's worktree, not the bare
clone under `repos/`. Commit each repo's phase results (in its own worktree,
on its own branch) before moving to the next repo — one repo's work must not
block or be blocked by another's.

### Step 1.5: Record coverage

Before the phase loop, in the repo's worktree, run:

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/coverage-summary.ts" --repo {org}/{repo} --record
```

This runs on every invocation, regardless of phase staleness, including when
every phase artifact is fresh and Step 2 would otherwise run nothing. It never
blocks the phases: a non-zero exit, a `not_reporting` result or any other
failure is logged and the run continues to Step 2. The artifact contract is in
`plugins/shipwright/references/coverage-output.md`.

### Step 2: Determine the starting phase

If `--full` is set, start at phase 1. Otherwise check mtime of each phase
artifact in order (1 → 4), scoped to the current repo's worktree; the first
artifact that is missing or older than 24 hours marks the starting phase, and
if all are fresh for this repo, skip straight to Step 4 (no phases run).

### Step 3: Run phases sequentially

From the starting phase through phase 5, in the current repo's worktree:
- Phase 1: `/shipwright:test-inventory`
- Phase 2: `/shipwright:test-design`
- Phase 3: `/shipwright:test-migration`
- Phase 4: `/shipwright:test-roadmap`
- Phase 5: `/shipwright:test-fix --origin-cron test-readiness` — add no further
  flag (real queue) when this skill was invoked with `--publish`; otherwise add
  `--dry-run` (preview only, no task-store writes). `test-readiness` is the
  system-cron definition id, hard-coded here (the scheduler passes nothing), so
  follow-on tasks are stamped `originKind: "cron"` / `originRef: "test-readiness"`
  and can be counted per cron. Manual runs of this skill are stamped the same way.

Run each skill using the Skill tool. If any phase fails for this repo, report
the failure for that repo and stop running further phases **for that repo
only** — do not run subsequent phases for it, as each depends on the previous
artifact. Log the failure and proceed to Step 4.

After phase 5 (or an early stop due to failure) completes for the current
repo, proceed to Step 3.5 to commit and open a PR with the refresh results.

### Step 3.5: Commit and Open PR

After all phases have completed successfully for this repo, push the branch to
origin and open (or update) a PR for the phase-artifact refresh.

**Push the branch:**

```bash
git push --set-upstream origin {branch-name}
```

Where `{branch-name}` is either:
- The fresh-branch case (from Step 1's fresh-branch flow): `docs/test-readiness-refresh-{YYYYMMDD}` (today's date)
- The reused-branch case (from Step 1's open-PR supersession flow): the existing earlier-day branch name checked out in this worktree

**Check for an existing open PR on this branch:**

```bash
gh pr list --repo {org}/{repo} --head {branch-name} --state open --json number
```

If this command returns a result (PR already exists for this branch), stop here — the push
already updated the open PR, and no further action is needed. This handles the reused-branch
case from Step 1, where an earlier-day PR is still open and absorbs today's updates via the
merged `origin/main` and the newly-pushed phase artifacts.

**If no PR exists (fresh-branch case only), create the label and open the PR:**

Create the idempotent `shipwright` label with `--force`, which upserts rather than
erroring if the label already exists (matching the pattern applied across Shipwright
skills — see `plugins/shipwright/commands/research-docs.md` Step A7.5 for the
consistency rationale):

```bash
gh label create shipwright \
  --description "Opened autonomously by Shipwright" \
  --color 1D76DB \
  --force
```

Then open the PR with the shipwright label:

```bash
gh pr create \
  --title "docs: test-readiness refresh ({YYYYMMDD})" \
  --body "Automated test-readiness phase-artifact refresh" \
  --label shipwright
```

After the PR is open (or updated in the reused-branch case), proceed to Step 4.

### Step 4: Report

After the repo has been processed, print one summary: which phases
ran (or "skipped — all artifacts fresh" / "skipped — reuse-merge conflict, needs manual resolution" for
the open-PR supersession case above), and the number of task-store tasks
created or updated (from phase 5 output) for that repo. The reuse-merge
conflict status is reported distinctly from "skipped — all artifacts
fresh" — the two mean different things (blocked vs. nothing to do) and must
not be folded together, so a human scanning the summary can immediately spot
the repo that needs manual conflict resolution on its open PR.

## Failure handling

If a phase fails:
- Log which phase failed and include any error output.
- Do not run subsequent phases.
- Exit with a clear summary so the run log shows the failure.
- A failure in the skill itself is always logged.

## Notes

- This skill handles its own staleness check (step 2) **unless `--full` is
  passed**. With `--full` (the scheduled default) every phase runs; without it, a
  fresh set of artifacts makes the skill exit early.
- Phase 5 (`test-fix`) has no confirmation gate — the scheduled prompt passes `--publish`,
  which forwards real-queue mode so it writes task-store tasks unattended.
  The publish step is idempotent (it dedupes on already-active T-NNN
  task-store IDs per repo), so a daily real run queues tasks for new work —
  including doc-layer tasks — without creating duplicates.
