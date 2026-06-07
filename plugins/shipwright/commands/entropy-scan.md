---
name: entropy-scan
description: Scan codebase for golden principle violations. Report only — no code changes. Flags: --init (create starter config), --summary (print summary only, skip report file), --trend (print trend from quality log, skip scan).
---

# /entropy-scan

Scan the codebase against your golden principles and generate `entropy-report.md`. Report only — no code changes.

**Flags:**
- `--init` — copy the default `golden-principles.yaml` to `.claude/entropy-patrol/` so you can customize rules for this project, then stop
- `--summary` — print a category summary to stdout without writing the full report file (useful for quick checks or CI)
- `--trend` — print a trend summary from `.entropy-patrol/quality-log.jsonl`; skip scan. Combine with `--window N` to limit history (default: 30)

Invoke the entropy-scan skill.
