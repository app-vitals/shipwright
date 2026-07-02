---
description: Phase 5 — publish the approved roadmap to GitHub as a dashboard of issues. Creates one issue per task with full context inline, plus milestones, labels, and a parent tracking issue.
argument-hint: "[--dry-run] [--yes] [--repo owner/name]"
allowed-tools: [Read, Glob, Grep, Bash, Write, Skill]
---

# /test-publish

Run **Phase 5** of the test-readiness pipeline. Publish the approved roadmap to GitHub so a developer (or `claude code`) can pick the next ready issue and start work with full context inline.

## Prerequisites

- `docs/test-readiness/test-readiness-plan.md` exists (output of `/test-roadmap`).
- The user has reviewed and approved the roadmap.
- `gh` CLI is installed and authenticated for the target repo.
- Current directory is inside a git repo whose `origin` remote points at the GitHub repo to publish into (or `--repo owner/name` is supplied).

## What this does

For each task in the roadmap's task list:

1. **Creates one GitHub issue** with a body containing everything needed to work on it standalone:
   - Task ID, milestone, layer, bucket origin, criticality
   - Files to touch
   - Expected outcome
   - Acceptance criteria (checkbox list)
   - Verification command
   - Context links back to the inventory / system-design / migration artifacts
   - "Requires #N" dependency lines if predecessors exist
2. **Assigns it to the right GitHub milestone** (creates M1–M5 if missing).
3. **Applies consistent labels** (creates them if missing):
   - `test-readiness` (umbrella)
   - `milestone:m1` … `milestone:m5`
   - `layer:unit` / `layer:integration` / `layer:smoke` / `layer:e2e` / `layer:infra`
   - `bucket:reuse` / `bucket:promote` / `bucket:rebuild` / `bucket:delete` / `bucket:net-new`
   - `criticality:critical` / `criticality:high` / `criticality:medium`
   - `ready` (no unmet deps) OR `blocked` (waiting on predecessors)

Additionally:

4. **Creates a parent tracking issue** titled `Test Readiness Roadmap` pinned with the full roadmap, milestone-by-milestone, and a checkbox referencing every child issue.

## The "pick the next issue" workflow

After publish, a developer or agent finds the next workable issue via:

```
gh issue list --search "label:test-readiness label:ready sort:created-asc" --limit 1
```

Every `ready` issue has all the context inline — no separate doc to read, no questions to ask. As predecessor issues close, blocked issues are re-labeled `ready` automatically by `/test-publish --refresh` (or manually with `gh issue edit`).

## Process

1. Read `docs/test-readiness/test-readiness-plan.md`. Abort if missing.
2. Detect target repo: `gh repo view --json nameWithOwner` (or use `--repo`).
3. Show the user a summary: N issues to create, M milestones, K new labels. Confirm before proceeding (skipped if `--dry-run` or `--yes`).
4. Invoke the `test-publish` skill, which:
   - Ensures labels and milestones exist
   - Iterates the task list and creates issues from `${CLAUDE_PLUGIN_ROOT}/assets/templates/issue.md.tmpl`
   - Creates the tracking issue from `${CLAUDE_PLUGIN_ROOT}/assets/templates/tracking-issue.md.tmpl`
   - Reports the created issue numbers back

## Flags

- `--dry-run` — print what would be created without calling the GitHub API.
- `--yes` — skip the confirmation prompt and publish for real. Sanctioned bypass for the unattended `shipwright-test-readiness` cron; idempotent dedup keeps repeated runs duplicate-free.
- `--repo owner/name` — target a specific repo instead of inferring from `origin`.
- `--refresh` — re-evaluate `ready` / `blocked` labels on existing issues based on which predecessors have closed. Does not create new issues.

## Output

Writes `docs/test-readiness/test-readiness-issues.md` mapping each task ID to its issue number for traceability. This file is also linked from the tracking issue.

## Notes

- **Idempotency:** re-running creates issues only for tasks not yet published (matched by task ID in a hidden `<!-- task-id: T-NNN -->` HTML comment in the issue body). Safe to re-run after editing the roadmap.
- This command **does** write to GitHub. It is gated on explicit user confirmation (unless `--dry-run`, or `--yes` for the unattended cron).
- Closing predecessor issues should be followed by `/test-publish --refresh` to update the `ready` / `blocked` labels.
