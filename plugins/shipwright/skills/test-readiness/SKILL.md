---
name: test-readiness
description: >
  Orchestrates the full test-readiness pipeline (phases 1–5) for the active
  worktree. Runs test-inventory → test-design → test-migration → test-roadmap →
  test-publish in sequence, starting from the first stale artifact. Invoked by
  the `shipwright-test-readiness` cron on a daily schedule; exits early if all
  phase artifacts are fresh.
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
| `--publish` | Run phase 5 as a **real publish** — forward `--yes` to `/shipwright:test-publish` so it creates/updates GitHub issues unattended (no interactive confirmation). Without it, phase 5 runs `--dry-run` (preview only, no GitHub writes). |
| `--dry-run` | Explicit preview: phase 5 runs `--dry-run`. This is the default when `--publish` is absent. |

## Staleness check

**Skipped entirely when `--full` is passed** (the cron's default) — all phases
1→5 run. The check below only applies when `--full` is absent.

Before running any phase, re-read the phase artifacts to determine the earliest
stale phase. The artifacts and their canonical paths (relative to the repo root):

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

1. **Locate the active worktree.** Look for a worktree directory under
   `$SHIPWRIGHT_WORKTREE_DIR` (default: `$HOME/worktrees`) that matches the
   configured repo name. If none found, stop — nothing to run.

2. **Determine the starting phase.** If `--full` is set, start at phase 1.
   Otherwise check mtime of each phase artifact in order (1 → 4); the first
   artifact that is missing or older than 24 hours marks the starting phase,
   and if all are fresh, stop.

3. **Run phases sequentially** from the starting phase through phase 5:
   - Phase 1: `/shipwright:test-inventory`
   - Phase 2: `/shipwright:test-design`
   - Phase 3: `/shipwright:test-migration`
   - Phase 4: `/shipwright:test-roadmap`
   - Phase 5: `/shipwright:test-publish` — pass `--yes` when this skill was
     invoked with `--publish` (real publish, no confirmation prompt);
     otherwise pass `--dry-run` (preview only).

   Run each skill using the Skill tool. If any phase fails, report the failure
   and stop — do not run subsequent phases, as each depends on the previous
   artifact.

4. **Report.** After all phases complete, summarize which phases ran and the
   number of GitHub issues created or updated (from phase 5 output).

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
- Phase 5 (`test-publish`) normally requires explicit user confirmation before
  creating GitHub issues. The cron passes `--publish`, which forwards `--yes`
  to `test-publish` so it publishes unattended. The publish step is idempotent
  (it dedupes on the hidden `<!-- task-id -->` marker), so a daily real publish
  files issues for new tasks — including doc-layer tasks — without creating
  duplicates.
