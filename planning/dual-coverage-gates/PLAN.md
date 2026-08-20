# Dual Coverage Gates — Engineering Plan

**Date**: 2026-08-14
**Session**: dual-coverage-gates
**Repo**: shipwright
**Input**: [`PRODUCT-SPEC.md`](./PRODUCT-SPEC.md)

## Summary

Adds a dual coverage gate (feature-level + line-level, both ≥90%) to Shipwright's
own 5-phase test-readiness pipeline, replacing the current tier-agnostic flat 80%
floor with a computed READY/BLOCKED verdict.

## Key findings from codebase exploration

- The pipeline is **prompt-driven, not application code** — `test-inventory`,
  `test-migration`, `test-roadmap`, `test-fix`, `repo-config` are `SKILL.md` files
  with no backing `.ts` implementation. The only real code in this PRD's blast
  radius is `scripts/check-coverage.ts` (single-purpose today: hardcoded lcov
  parsing, `THRESHOLD_LINES`/`THRESHOLD_FUNCTIONS = 80`, no parser abstraction).
  Skill-level tests are `SKILL.content.test.ts` (prompt-content assertions) —
  `test-inventory` and `repo-config` currently have **zero** test files.
- Current real numbers (last `test-readiness-plan.md` run): Shipwright's own repo
  is at **88.84% lines / 88.00% functions** — close to the 90/90 target, not a
  large gap.
- `test-migration` Step 4a already pulls real numbers (aggregate wall-clock) from
  `gh run view --log` against the latest green CI run — the pattern Feature 2
  mirrors for sourcing `line_coverage_pct`.
- `repo-config`'s branch-protection pairing pattern is real and documented, but
  the actual GitHub API calls live outside this skill (Phase 2 design-only
  artifact); there is no injected-GitHub-client test double anywhere in the
  codebase for it.

## Design decisions (flagged and confirmed with Dave)

1. **Testing Strategy correction**: the PRD's Testing Strategy calls Feature 1/3's
   percentage and sequencing logic "unit tested pure functions" — nothing in this
   pipeline outside `check-coverage.ts` is testable application code. Prompt/
   `SKILL.md`-level logic gets `*.content.test.ts` (matching existing convention);
   real unit/integration tests are reserved for the genuinely scripted parts (the
   parser adapters and the new `check-coverage-gate.ts`).
2. **No non-Bun repo exists** anywhere in this workspace (`vitals-os`,
   `marketing-site`, `shipwright` are all Bun). The PRD's Success Criteria asks for
   live non-Bun-repo validation of JaCoCo/coverage.py/go-cover parsing — this plan
   validates against fixture files only; live-repo validation is deferred until
   such a repo exists.
3. `check-coverage-gate.ts` (script) and its `test-roadmap` wiring are bundled
   into one PR — a script with no caller is dead code.

## Technical design by feature

**Feature 1 (Feature-Coverage Matrix)** — extend `test-inventory/SKILL.md` with a
grouping step (directory/route-prefix/entry-point heuristics) + extend
`assets/templates/test-inventory.md.tmpl` with a features table, mirroring the
existing ambiguous-items pattern and Step 0 registry-check pattern already in
that skill. `feature_coverage_pct` is agent-computed arithmetic during the SKILL
run (like every other percentage in this pipeline), not a standalone scripted
function.

**Feature 2 (`coverage_gate` block)** — the percentage-pull step lives in
`test-migration` as a new Step 4c, mirroring Step 4a's CI-log-pull mechanism. The
self-consistency guard is a real script (`scripts/check-coverage-gate.ts`) with a
pure `computeVerdict()` function that `test-roadmap` invokes and renders
verbatim — making a contradictory verdict structurally impossible rather than
policy-enforced.

**Feature 3 (multi-tool + floor raise)** — refactor `check-coverage.ts` into a
`CoverageParser` interface first (pure refactor, lcov behavior unchanged), then
add JaCoCo/coverage.py/c8-nyc/go-cover adapters as separate tasks. The 80→90
threshold raise closes the ~1-2pt real gap in the same task as the constant
change, since merging the constant alone would break the required `ci` job.

**Feature 4 (CI ratchet)** — extends `repo-config`'s 2-stage pairing pattern to 3
stages (docs/pattern only) and adds emission logic to `test-roadmap`. Also adds a
concrete piece the PRD didn't fully spell out: a real "coverage must not decrease
vs. base branch" CI check, since AC #1 requires this to actually exist as an
enforceable check.

## Task Breakdown

| Task | Title | Layer | Hours | Complexity | Model | Depends on |
|---|---|---|---|---|---|---|
| FCM-1.1 | Add feature-grouping step to test-inventory | Shared | 3 | 4 | sonnet | — |
| CVG-1.1 | Pull real coverage percentages in test-migration | Shared | 2 | 3 | sonnet | FCM-1.1 |
| CVG-1.2 | `check-coverage-gate.ts` verdict + self-consistency guard | CLI | 3 | 3 | sonnet | — |
| CVG-1.3 | Render `coverage_gate` block + record coverage tool | Shared | 2 | 3 | sonnet | CVG-1.1, CVG-1.2 |
| MTC-1.1 | Extract `CoverageParser` interface from check-coverage.ts | CLI | 3 | 3 | sonnet | — |
| MTC-1.2 | JaCoCo XML parser adapter | CLI | 3 | 3 | sonnet | MTC-1.1 |
| MTC-1.3 | coverage.py parser adapter | CLI | 3 | 3 | sonnet | MTC-1.1 |
| MTC-1.4 | c8/nyc (Istanbul JSON) parser adapter | CLI | 3 | 3 | sonnet | MTC-1.1 |
| MTC-1.5 | go cover parser adapter | CLI | 3 | 3 | sonnet | MTC-1.1 |
| MTC-1.6 | Per-repo coverage-tool dispatch | CLI | 2 | 3 | sonnet | MTC-1.1–1.5, CVG-1.3 |
| MTC-1.7 | Raise Shipwright's own coverage floor to 90% | CLI | 4 | 3 | sonnet | MTC-1.1 |
| MTC-1.8 | Feature-gap sequencing + anti-gaming rule | Shared | 3 | 3 | sonnet | FCM-1.1, CVG-1.3 |
| RAT-1.1 | Extend branch-protection pairing to 3-stage lifecycle | Shared | 2 | 4 | sonnet | CVG-1.3 |
| RAT-1.2 | Auto-emit promotion task on gap closure | Shared | 2 | 3 | sonnet | RAT-1.1, CVG-1.3 |
| RAT-1.3 | "Coverage must not decrease" CI check | CLI | 4 | 4 | sonnet | MTC-1.1 |

**RAT-1.3 update**: shipped as `check-coverage-no-decrease.ts` + the
`coverage-no-decrease` CI job, then retired (script, tests, and job deleted) once
stage-3 promotion landed and branch protection no longer required it — see
CND-1.1.

**Bundle**: CVG-1.2 + CVG-1.3 share branch `feat/cvg-gate-script-and-render` (script
has no independent value without its caller).

**Breaking change safety**: only MTC-1.7 (constraint tightening on an existing
gate) needed special handling — folded gap-closure into the same task with a
merge-blocking acceptance criterion, rather than a 3-task split, since the gap is
small (~1-2 points) and already tracked in `test-migration.md`'s debt table. All
other tasks are additive.

**HITL scan**: no tasks require human steps. None of these 15 flip a live GitHub
branch-protection setting or provision a secret — that already happens downstream
via `test-fix`'s existing, unrelated HITL rule when the pipeline runs against a
live repo.

Full acceptance criteria, dependency graph, and per-task detail were reviewed and
approved with Dave in the planning session on 2026-08-14; task-store is the
source of truth for execution.
