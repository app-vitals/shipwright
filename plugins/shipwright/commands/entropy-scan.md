---
name: entropy-scan
description: "Scan one repo for golden principle violations and write docs/patrols/entropy.md (docs PR on material change). Requires --repo org/repo. Report only — no code changes. Flags: --init (create starter config), --summary (print summary only, write nothing), --trend (print trend from quality log, skip scan), --dry-run (no PR, no run record)."
argument-hint: "--repo org/repo [--init] [--summary] [--trend] [--dry-run]"
---

# /entropy-scan

Scan one repo against your golden principles and write the open items to `docs/patrols/entropy.md`, opening a docs PR only when the content materially changed. Report only — no code changes.

**Flags:**
- `--repo org/repo` — **required**; without it the command prints a usage error. Scans exactly that repo, never `repos/` as a list
- `--init` — copy the default `principles.md` to `.claude/shipwright/` so you can customize rules for this project, then stop
- `--summary` — print a category summary to stdout without writing the docs file (useful for quick checks)
- `--trend` — print a trend summary from `.entropy-patrol/quality-log.jsonl`; skip scan. Combine with `--window N` to limit history (default: 30)
- `--dry-run` — full scan and summary, but no commit, no PR and no run record

Invoke the entropy-scan skill.
