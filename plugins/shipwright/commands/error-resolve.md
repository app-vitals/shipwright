---
name: error-resolve
description: "Read error PatrolFindings and each linked task's current status from the task store (required --repo), and resolve the corresponding Sentry issue once its gating task has reached deployed/done. Never resolves on merged, released or pr_open. Flags: --repo org/repo (required), --cron ID, --dry-run (print what would resolve without calling Sentry or writing the store)."
---

# /error-resolve

Read the repo's error PatrolFindings that `/error-fix` linked to a task, query the task store
for each linked task's current status, and call Sentry's issue-resolve endpoint for any issue
whose gating task has reached `deployed` or `done`. `merged`, `released` and `pr_open` never
resolve (a published library does not change a running service until a consumer deploys). The
finding is marked resolved in the store only after the Sentry call succeeds.

**Flags:**
- `--repo org/repo` — required; prints a usage error without it
- `--cron ID` — system-cron id (default `error-patrol`)
- `--dry-run` — run the readiness check without calling Sentry or writing the store

Invoke the error-resolve skill.
