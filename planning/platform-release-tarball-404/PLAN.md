# Plan: platform-release-tarball-404

Repo: app-vitals/shipwright

## Problem
`platform-release.yml` (run 41677597857, platform 1.2.0, 2026-11-03) passed its
"Wait for @app-vitals/agent-* on npm" step (`npm view pkg@ver version` matched
for all three packages) and then `bun install` failed with
`GET .../agent-lib-1.2.0.tgz - 404`. The registry packument was visible before
the tarball was served. No `chore/platform-release` PR opened; the bump was
recovered by a manual PR (#4799).

Other recent failed dispatches (0.16.2, 1.0.0, 1.1.0) had different causes
(conflict/check exhaustion, branch-guard refusal) handled by existing guards and
are out of scope.

## Design
In `.github/workflows/platform-release.yml`:
1. Wait step: after the `npm view ... version` match, also resolve
   `npm view pkg@ver dist.tarball` and require `curl -fsI` on it to succeed.
   Keep the existing 40 x 15s budget.
2. "Refresh bun.lock": wrap `bun install` in a bounded retry (~5 attempts, 20s
   backoff) that retries only on registry 404 / "failed to resolve" output; any
   other error fails immediately. On exhaustion, fail naming VERSION and the
   last error.
3. Update `platform-release.content.test.ts` (wait-step assertions, lines
   ~120-131) and cover the new tarball check and retry wrapper.

The app-vitals/agent notify job is not changed: the lag is at npm, so gating the
dispatch would not fix it. `platform-release-retry.yml` (no-PR-after-failed-run
gap) is out of scope.

## Tasks
| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| TGZ-1.1 | - | - | |

TGZ-1.1: fix: gate platform bump on npm tarball availability and retry registry 404s
(CLI layer, 2h, complexity 2, haiku). Safe to deploy standalone: yes (additive
within one workflow; no interface removed; no new secrets).
