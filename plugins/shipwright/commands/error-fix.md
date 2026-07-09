---
name: error-fix
description: "Read error-report.md, fetch each New/Regressed issue's Sentry detail and stack trace, classify hitl per issue, and queue task-store tasks (plus companion observability-fix tasks where instrumentation gaps hinder root-causing). Requires /error-scan to have been run first. Flags: --dry-run (preview classification and queueing without touching the task store or ledger)."
---

# /error-fix

Read `error-report.md`, fetch each New/Regressed issue's Sentry detail and latest-event
stack trace, classify each issue `hitl: true|false` by judgment (no numeric backstop), and
queue task-store tasks via `/tasks/bulk` — plus a companion observability-fix task at any
call site where an instrumentation gap hindered root-causing. Issues with an `UNMAPPED`
service tag are never queued; they're surfaced for human triage instead.

**Flags:**
- `--dry-run` — print what would be queued (including hitl classification and companion
  tasks) without querying the task store for dedup or writing anything (no task-store
  writes, no ledger writes)

Invoke the error-fix skill.
