---
name: error-scan
description: "Scan Sentry for new/regressed unresolved issues and map them to repos dynamically. Report only — no code changes. Flags: --summary (print counts only, skip report file), --dry-run (full scan, no files written)."
---

# /error-scan

Query the Sentry Issues API for unresolved issues, diff against
`state/error-patrol-ledger.json` to find what's new or regressed, dynamically derive a
service → repo mapping, and generate `error-report.md`. Report only — no code changes.

**Flags:**
- `--summary` — print a counts summary to stdout without writing `error-report.md` (the
  ledger is still updated)
- `--dry-run` — run the full scan but write nothing (no report, no ledger update); prints
  what would have been written to stdout instead

Invoke the error-scan skill.
