---
name: error-scan
description: "Scan Sentry (required --repo) for new/regressed unresolved issues whose project maps to that repo. Records PatrolFindings in the task store; no repo files, no code changes. Flags: --repo org/repo (required), --cron ID, --summary (print counts only), --dry-run (full scan, record nothing)."
---

# /error-scan

Query the Sentry Issues API for unresolved issues, keep only those whose Sentry project maps to
the repo named by the required `--repo`, diff against that repo's PatrolFindings in the task
store, and record the findings and one run. Unmapped issues are counted in metrics and get no
task. Report only — no code changes, no repo files.

**Flags:**
- `--repo org/repo` — required; prints a usage error without it
- `--cron ID` — system-cron id (default `error-patrol`)
- `--summary` — print a counts summary only
- `--dry-run` — run the full scan but record nothing

Invoke the error-scan skill.
