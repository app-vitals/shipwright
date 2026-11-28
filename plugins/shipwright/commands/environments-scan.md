---
name: environments-scan
description: "Scan one repo for environment readiness gaps (lockfile, pinned tools, preview environment, logging, error tracking, tracing/metrics, canary deploy) and write docs/patrols/environments.md (docs PR on material change). Requires --repo org/repo. Report only. Flags: --summary, --dry-run."
argument-hint: "--repo org/repo [--summary] [--dry-run]"
---

# /environments-scan

Scan one repo and write the open items to `docs/patrols/environments.md`, opening a docs PR only on material change. Report only — no code changes.

**Flags:**
- `--repo org/repo` — **required**; without it the command prints a usage error
- `--summary` — print the summary only, write nothing
- `--dry-run` — full scan, but no commit, no PR and no run record

Invoke the environments-scan skill.
