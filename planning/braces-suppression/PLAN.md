# Plan: braces-suppression

Repo: app-vitals/shipwright

## Context
GHSA-vfj7-8cjw-p6xm (braces <= 3.0.3) has no upstream fix (OSV `last_affected: 3.0.3`, no `fixed`).
braces is build/dev-only: root `bun.lock` via semantic-release -> micromatch; `site/bun.lock` via
tailwindcss -> fast-glob/chokidar (static Astro site). Cancelled task
security-grype-cve-shipwright-2026-W41; http-cache-semantics already fixed by PR #3891.
grype is a non-independent subset of osv-scanner on bun.lock (see security-scan SKILL.md 3.2).

## Design
No suppression config exists in the repo; scans (security-scan SKILL.md 3.2/3.3) pass no `--config`.
1. `osv-scanner.toml` at repo root and `site/` (per-lockfile-directory discovery):
   `[[IgnoredVulns]] id = "GHSA-vfj7-8cjw-p6xm"`, `ignoreUntil` ~90 days from merge, `reason`.
   osv-scanner enforces expiry natively; the finding resurfaces afterward.
2. `.grype.yaml` at repo root: ignore rule `vulnerability: GHSA-vfj7-8cjw-p6xm`,
   `package: {name: braces, version: 3.0.3}`, with a comment carrying the same re-check date.
   grype has no native expiry; a different braces version no longer matches the rule.
3. Unit content test asserting the `.grype.yaml` re-check date equals the osv `ignoreUntil`
   (drift guard). Deliberately NOT a fail-after-date test: it would break unrelated PRs; the osv
   expiry resurfaces the finding and the weekly scan files a task.

Open points: confirm osv-scanner per-directory config discovery for `site/` during implementation
(fallback: pass `--config` in the skill). Tools are not installed in the agent sandbox; download pinned
osv-scanner v2.0.2 / grype v0.116.0 to verify.

## Tasks
| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| BRS-1.1 Add time-boxed braces advisory suppression (osv-scanner + grype) | — | — | |

Safe to deploy standalone: yes (additive config only).

## Decision Log
(interactive session — design approved by Dan)
