---
description: Phase 2 — design the ideal test system greenfield (frameworks, local substitutes, canary contract, speed budgets, CI shape) given the Phase 1 inventory.
argument-hint: [path]
allowed-tools: [Read, Glob, Grep, Bash, Write, Skill]
---

# /test-design

Run **Phase 2** of the test-readiness pipeline. Requires `docs/test-readiness/test-inventory.md` (output of `/test-inventory`).

## What this does

Design the ideal testing architecture for this repo, **without** anchoring on what tests currently exist. Greenfield by design — anchoring on the status quo is the failure mode this ordering prevents.

Produces:

1. **Framework matrix per layer** (unit / integration / smoke / E2E) based on detected stack.
2. **Local execution architecture**: for every external dependency named in the inventory, the local substitute (docker, testcontainers, in-memory, recorded fixture).
3. **Canary execution contract** per `skills/canary-execution/SKILL.md`: `TEST_TARGET_URL` env var, cleanup rules, time budget.
4. **Test-data strategy**: fixtures vs. factories vs. real-DB-per-run.
5. **CI pipeline shape**: layer ordering, parallelism, fail-fast, budget.
6. **Coverage targets per layer**: critical-tier ~95%, high ~80%, medium smoke-only.
7. **Speed budgets per layer** per `skills/speed-budgets/SKILL.md` — per-test 95p, per-test hard cap, per-layer suite target.
8. **Shared helpers / utilities** inventory.

## Process

1. Read `docs/test-readiness/test-inventory.md`. If missing, abort with "run /test-inventory first."
2. Invoke the `test-design` skill.
3. Pull defaults from `skills/canary-execution/SKILL.md` and `skills/speed-budgets/SKILL.md`. May tighten budgets per repo, never loosen below defaults.
4. Write `docs/test-readiness/test-system.md` from the template.

## Output

`docs/test-readiness/test-system.md` — the greenfield blueprint.

## Next step

Run `/test-migration` to reconcile this blueprint with the tests that exist today.

## Notes

- Read-only. This command never writes test code or modifies test configs.
- "Greenfield" means: do not list current frameworks as "the framework" unless the rubric independently selects them. The next phase handles "keep what works."
