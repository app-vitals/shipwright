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

## Pass 2 — 2026-11-24 — specs none (verbal description)

### Context
GHSA-vfj7-8cjw-p6xm was withdrawn from the advisory database as "not a practically exploitable
vulnerability". A withdrawn advisory is no longer reported, so the Pass 1 suppressions
(`.grype.yaml`, `osv-scanner.toml`, `site/osv-scanner.toml`) suppress nothing. An earlier
external attempt (PR #5568) is gone; this pass redoes the cleanup from main.

### Design
Delete the three config files and `braces-suppression.content.test.ts` (its only subject is
those files; leaving it would fail CI). Remove the test's reference in
`docs/test-readiness/test-migration.md`. `test-inventory.md` only says the files are "config,
not code units" and stays. Pass 1 above is unchanged.
Consumer check: the security-scan skill and workflows pass no `--config` and never reference
these files; osv-scanner and grype auto-discover them, so removal is safe.
Test layer: content test retired because its subject is gone; no new tests.

### Tasks
| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| BRS-2.1 chore: remove withdrawn braces advisory suppressions | — | — | |

Safe to deploy standalone: yes (removes config that suppresses nothing).

### Decision Log
- interactive session — design approved by Dan 2026-11-24
- session `braces-suppression` was closed/archived; reused per Dan's choice
