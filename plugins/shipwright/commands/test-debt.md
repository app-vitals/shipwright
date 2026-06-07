---
description: Post-execution analysis — compute the corrective-commit ratio per milestone from git log and flag under-specified milestones as planning debt for the next run.
argument-hint: [path]
allowed-tools: [Read, Glob, Grep, Bash, Write, Skill]
---

# /test-debt

Run post-execution analysis on a completed test-readiness roadmap. Measures planning quality by computing how many commits in each milestone were corrections rather than forward progress.

## What this does

Reads `docs/test-readiness/test-readiness-plan.md` for task IDs and milestone structure, then scans git history to compute a corrective-commit ratio per milestone. Flags milestones above the red-flag threshold (>0.25) and emits planning debt notes for the next roadmap run.

## Output

`docs/test-readiness/test-debt.md`:

1. **Per-milestone summary table** — total commits, corrective commits, ratio, and flag status.
2. **Per-task breakdown** — for red-flag milestones, which tasks accumulated the most corrections and why.
3. **Planning debt notes** — actionable recommendations for the next `/test-roadmap` run.

Also prints a summary table to stdout.

## Process

1. Read `docs/test-readiness/test-readiness-plan.md`. Abort if missing.
2. Invoke the `test-debt` skill.
3. Write `docs/test-readiness/test-debt.md`.

## When to run

After any milestone closes — not just at the end of the full roadmap. Catching a red-flag ratio after M1 lets you course-correct task sizing before M2–M5.

## Notes

- Read-only against source and test files. Only writes to `docs/test-readiness/`.
- Requires git history in the working directory. Does not work on shallow clones.
- A milestone with fewer than 5 total commits is reported but not flagged (insufficient signal).
