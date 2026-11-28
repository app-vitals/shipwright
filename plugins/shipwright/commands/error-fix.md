---
name: error-fix
description: "Read open error PatrolFindings from the task store (required --repo), fetch each issue's Sentry detail and stack trace, and route each auto / review / plan as task-store tasks (plus companion observability-fix tasks). Requires /error-scan --repo first. Flags: --repo org/repo (required), --cron ID, --dry-run (preview routing without writing anything)."
---

# /error-fix

Read the repo's open error PatrolFindings from the task store, fetch each issue's Sentry
detail and latest-event stack trace, route each issue auto / review / plan (see
`docs/task-store.md`, "Finding routing"), and queue task-store tasks via `/tasks/bulk` — plus
a companion observability-fix task where an instrumentation gap hindered root-causing. No
report file is read and no task is marked `hitl`.

**Flags:**
- `--repo org/repo` — required; prints a usage error without it
- `--cron ID` — system-cron id (default `error-patrol`)
- `--dry-run` — print the routing and queueing preview without any writes

Invoke the error-fix skill.
