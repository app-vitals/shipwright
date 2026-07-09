---
name: error-resolve
description: "Read the error-patrol ledger, check each linked task's current status via the task store, and resolve the corresponding Sentry issue once its gating task has reached deployed/done. Never resolves on merged or pr_open. Flags: --dry-run (check readiness and print what would resolve without calling Sentry or touching the ledger)."
---

# /error-resolve

Read `state/error-patrol-ledger.json`'s `taskLinks` entries (written by `/error-fix`), query
the task store for each linked task's current status, and call Sentry's issue-resolve
endpoint for any issue whose gating task (the `primary` task, or the `companion` task when
`primary` is null) has reached `deployed` or `done`. `merged` and `pr_open` are never
sufficient. The ledger entry for a resolved issue is cleared only after the Sentry resolve
call succeeds.

**Flags:**
- `--dry-run` — run the full readiness check (task-store status lookups, gating decision per
  issue) without calling Sentry or touching the ledger; prints what would have been resolved

Invoke the error-resolve skill.
