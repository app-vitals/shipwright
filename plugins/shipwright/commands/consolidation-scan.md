---
name: consolidation-scan
description: "Discover emerging duplicate/similar code patterns in one repo via judgment-driven comparison and track them across runs in the task store. Writes docs/patrols/consolidation.md (docs PR only on material change). Requires --repo org/repo. Report only — no code changes. Flags: --summary (skip the docs file), --dry-run (full scan, write nothing)."
argument-hint: "--repo org/repo [--summary] [--dry-run]"
---

# /consolidation-scan

Survey one repo for emerging, unnamed duplicate logic — the same responsibility
implemented independently in two or more places — weight candidates by churn, and
track them in the task store's `PatrolFinding` ledger across multiple runs. Only
patterns that have recurred with a stable shape (occurrence_count >= 3,
consecutive_stable_runs >= 2) are listed in `docs/patrols/consolidation.md`. Report
only — no code changes.

`--repo org/repo` is required; without it, print the usage error and stop.

**Flags:**
- `--repo org/repo` — the repo to scan (required)
- `--summary` — print counts to stdout without writing the docs file (findings and the run record are still written)
- `--dry-run` — run the full scan but write nothing (no findings, run record, docs file, or PR)

Invoke the consolidation-scan skill.
