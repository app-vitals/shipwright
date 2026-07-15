---
description: "Phase 5 — read docs/test-readiness/test-readiness-plan.md and queue its flat T-NNN task list as task-store tasks (dependency edges included), one per row. Requires /test-roadmap to have been run first. Flags: --dry-run (preview without querying/writing)."
argument-hint: "[--dry-run]"
allowed-tools: [Read, Glob, Grep, Bash, Write, Skill]
---

# /test-fix

Read `docs/test-readiness/test-readiness-plan.md`, parse its flat `T-NNN` task list
(milestones, layers, buckets, criticality, audit-decision rows, and predecessor/fan-out
dependency links), and queue each row as a task-store task via `/tasks/bulk` — with
`dependencies` set from the plan's own dependency edges so task-store's `ready:true` query
computes readiness directly. This is the Phase 5 task-store based replacement for the former
GitHub-issue publish skill's dashboard.

**Flags:**
- `--dry-run` — print what would be queued (including hitl classification) without querying
  the task store for dedup or writing anything

Invoke the test-fix skill.
