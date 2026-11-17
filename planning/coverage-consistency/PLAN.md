# Plan: coverage-consistency

Repo: app-vitals/shipwright (tasks also touch the two repos that already publish coverage)

Goal: one coverage number everywhere. What shipwright metrics records and what test-readiness
gates on must equal what each repo's CI gate enforces, and anyone reading it must be able to see
what was left out.

## Findings

- Two numbers exist. Each repo's `scripts/check-coverage.ts` filters excluded paths before
  computing its percentage (shipwright: 91.01%). The `shipwright-coverage` CI artifact is the
  raw `coverage/lcov.info`, and `coverage-summary.ts` (the reader behind metrics and
  test-roadmap) reads it unfiltered (shipwright: 87.9%, ~2,170 more lines).
- The exclusion lists are hard-coded and duplicated per repo (shipwright, vitals-os, specialists)
  with nothing keeping them honest.
- Once the plugin version that reads the artifact rolls out, shipwright's phase 4 would read
  87.9% and flip to BLOCKED, queueing tests for deliberately excluded entrypoints.

## Design

Canonical number = post-exclusion, i.e. what the CI gate enforces.

Each repo declares exclusions in one file, `.shipwright/coverage.json`, read by both the repo's CI
gate and the reader. The reader fetches the file at the artifact's commit SHA, so historical
numbers use the exclusions in effect at that commit (no history rewrite). No file means no
exclusions, so repos that have not adopted it behave as today.

```json
{
  "maxExcludedPct": 6,
  "excludePrefixes": [{ "path": "admin/src/main.ts", "reason": "process entrypoint" }],
  "excludeSubstrings": [{ "path": "prisma/client/", "reason": "generated code" }]
}
```

Honesty guardrails (all enforced in code, not by convention):

1. Every entry carries a non-empty `reason`; the gate and the reader reject an entry without one.
2. The excluded share is reported next to the number everywhere: the gate prints it, the reader
   result carries `excluded` (lines excluded and percent of total) so metrics and test-readiness
   can show it.
3. `maxExcludedPct` is a ceiling the gate enforces. Growing the excluded share requires an
   explicit, reviewable edit to that file.
4. The gate fails on a dead entry (an exclusion that matches no file in the lcov).

An invalid `.shipwright/coverage.json` fails loudly in the gate and the reader; it is never
silently ignored.

## Tasks

| Task | Repo | Depends on | Model | Hours |
|---|---|---|---|---|
| CCN-1.1 feat: define the coverage exclusion contract and apply it in the reader | shipwright | — | sonnet | 4 |
| CCN-1.2 refactor: move shipwright's coverage exclusions into the declared file | shipwright | CCN-1.1 | sonnet | 3 |
| CCN-1.3 refactor: move vitals-os coverage exclusions into the declared file | vitals-os | CCN-1.1 | sonnet | 3 |
| CCN-1.4 refactor: move specialists coverage exclusions into the declared file | specialists | CCN-1.1 | sonnet | 3 |
| CCN-1.5 docs: give new repos the exclusion file in the publish-artifact task | shipwright | CCN-1.1 | haiku | 2 |

CGF-1.3 (from session coverage-gate-fix) additionally depends on CCN-1.1 to CCN-1.5, so the
agent and factorymode test-readiness re-runs wait until the numbers are consistent.
Safe to deploy standalone: yes (all additive; the gates keep their thresholds). No HITL tasks.

## Decision Log

- Canonical number is post-exclusion (Dan, 2026-11-17).
- Shared declared file `.shipwright/coverage.json` rather than per-script lists (Dan).
- Guardrail "flag exclusion-file changes to reviewers" dropped (Dan); guardrails 1-4 kept.
- No HITL task to re-record metrics history; the trend will show a step when new recordings
  start applying exclusions (Dan).
- CGF-1.3 depends on the CCN tasks (Dan).

## Not carried

- Metrics dashboard display of the excluded share: follow-up if wanted; the reader result
  carries the data.
