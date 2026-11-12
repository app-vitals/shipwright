# Plan: no-measured-values-in-docs

Repo: app-vitals/shipwright (plugin only: plugins/shipwright/). No target-repo docs change.

## Problem
Living docs (TESTING.md, README, architecture pages) end up carrying measured values
("CI baseline 51.82% (CI run 41680992338 on PR #52)"). The doc-refresh machinery treats such a
sentence as a doc claim and rewrites it whenever a PR moves the number, so it churns every PR and
is stale by the next merge. Snapshot/plan artifacts (docs/test-readiness/*.md, planning/*/PLAN.md,
the Coverage Gate block) are dated and sourced to a CI run — numbers there are intended and unchanged.

## Design
Single rule, one canonical home: `references/doc-refresh-recipe.md` (already shared by
`agents/docs-refresher.md` and `commands/research-docs.md`).

- Living docs state policy + where the number lives (config file, "latest CI run"), never the
  measured value. Targets/thresholds that are *configured policy* (e.g. `fail_under = 51`) may be
  named; observed values (current %, test counts, timings, baselines, run ids) may not.
- Exempt: docs/test-readiness/** (already excluded from refresh), planning/**, and any file that is
  explicitly a dated snapshot.
- Refresher: when it meets an existing measured value in a living doc, replace it with a pointer
  rather than refreshing the number.
- research-docs: add the same check to the interactive Quality Pass (6.5) and auto-mode A5.5, and
  guard the testing.md Path A digest from copying observed figures out of the test-readiness plan.
- Test-readiness skills: reviewed — they write measured values only into their own snapshot
  artifacts (exempt). No change.

## Tasks
| Task | Depends on | Layer |
|------|-----------|-------|
| NMV-1.1 recipe + docs-refresher rule | — | CLI |
| NMV-1.2 research-docs quality-pass check + Path A guard | NMV-1.1 | CLI |

Dependency graph: [START] -> NMV-1.1 -> NMV-1.2
Safe to deploy standalone: yes for both (prompt text + content tests; additive).

## Decision Log
- Stacked "supersedes" blocks in test-readiness-plan.md: out of scope (snapshot readability, not stale-number problem).
- scripts/check-coverage-gate.ts: unchanged.
- Rule placed in the recipe, not duplicated into each caller, to avoid two copies drifting.
