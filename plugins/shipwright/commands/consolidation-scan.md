---
name: consolidation-scan
description: "Discover emerging duplicate/similar code patterns via judgment-driven comparison and track them across runs. Report only — no code changes. Flags: --summary (print summary only, skip report file), --dry-run (full scan, skip writing report and ledger)."
---

# /consolidation-scan

Survey the codebase for emerging, unnamed duplicate logic — the same responsibility
implemented independently in two or more places — weight candidates by churn, and
track them in `state/consolidation-ledger.json` across multiple runs. Only patterns
that have recurred with a stable shape (occurrence_count >= 3, consecutive_stable_runs
>= 2) are written to `consolidation-report.md`. Report only — no code changes.

**Flags:**
- `--summary` — print counts to stdout without writing `consolidation-report.md` (ledger still updates)
- `--dry-run` — run the full scan but skip writing both `consolidation-report.md` and `state/consolidation-ledger.json`; print what would have been written instead

Invoke the consolidation-scan skill.
