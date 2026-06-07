---
description: Phase 3 — reconcile existing tests against the Phase 1 inventory and Phase 2 blueprint, bucketing each into reuse / promote / rebuild / net-new.
argument-hint: [path]
allowed-tools: [Read, Glob, Grep, Bash, Write, Skill]
---

# /test-migration

Run **Phase 3** of the test-readiness pipeline. Requires both prior artifacts.

## What this does

For every existing test file (and every inventory item), assign one of five buckets:

| Bucket | Criterion |
|---|---|
| **Reuse as-is** | Right layer, right framework, adequate depth, runs locally, canary-eligible if required, within speed budget, **and is the canonical owner of its functionality** |
| **Promote / deepen** | Right shape but shallow, missing edge cases, missing canary mode, or marginally over speed budget (fixable) |
| **Rebuild** | Wrong layer, wrong framework, external-only deps with no local substitute, or so slow it cannot meet its layer's budget |
| **Delete (redundant)** | Re-asserts functionality already covered at its canonical (lower) layer — false-confidence test or duplicate coverage. Layer hierarchy: unit > integration > smoke > E2E. Higher-layer tests are kept ONLY when they assert what lower layers cannot (wire contract, multi-step state, real boundary). |
| **Net-new** | Inventory item with zero existing coverage |

Same bucketing applies to **infrastructure** — test runners, configs, fixtures, helpers.

## Process

1. Read `docs/test-readiness/test-inventory.md` and `docs/test-readiness/test-system.md`. Abort if either is missing.
2. Discover existing tests via Glob + Grep (patterns from detected stack).
3. Optionally measure test runtime to enforce speed bucketing (a slow "unit" test is almost always doing integration work — flag for rebuild).
4. Invoke the `test-migration` skill.
5. Write `docs/test-readiness/test-migration.md`.

## Output

`docs/test-readiness/test-migration.md` — four-bucket table for tests and a four-bucket table for infrastructure, with per-bucket rationale, effort estimates, and risk callouts.

## Next step

Run `/test-roadmap` to synthesize all three artifacts into the executable roadmap.

## Notes

- Read-only on source. Never edits test files.
- **Risk callouts** are mandatory for any test marked "rebuild" that currently passes — false-confidence coverage is the highest-stakes call in this audit.
