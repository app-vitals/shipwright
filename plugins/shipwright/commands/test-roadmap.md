---
description: Phase 4 — synthesize the three prior artifacts into a single executable roadmap (`test-readiness-plan.md`) with sequenced milestones and an agent-executable task list.
argument-hint: [path]
allowed-tools: [Read, Glob, Grep, Write, Skill]
---

# /test-roadmap

Run **Phase 4** of the test-readiness pipeline. Requires all three prior artifacts.

## What this does

Synthesize `test-inventory.md` + `test-system.md` + `test-migration.md` into a single roadmap doc the engineer (or an autonomous agent) can execute task-by-task.

## Output structure

`docs/test-readiness/test-readiness-plan.md`:

1. **Where we are now** — distilled current state from Phase 3.
2. **Where we want to be** — distilled target from Phase 2.
3. **The gap** — missing layers, wrong-layer tests, external-only deps, canary suite size vs. target, speed delta.
4. **Roadmap** — five sequenced milestones:
   - Infrastructure baseline (runners, local substitutes, CI shape)
   - Critical-path coverage (write/rebuild all `critical` tier tests)
   - Canary suite live (smoke + E2E canary-eligible run green against deployed env)
   - High-tier coverage (fill `high` tier gaps)
   - Cleanup (delete or refactor "rebuild" tests; remove false-confidence coverage)
5. **Task list** — flat, ordered, agent-executable. Each task: file(s) to touch, layer, expected outcome, verification command.
6. **Open risks** — anything the audit can't determine without a human call.

## Process

1. Read all three prior artifacts. Abort if any are missing.
2. Invoke the `test-roadmap` skill.
3. Write `docs/test-readiness/test-readiness-plan.md`.

## Handoff

The output is intended to be handed to:
- An engineer for manual execution, OR
- `shipwright`'s `/dev-task` for autonomous execution (consume task list as queue).

## Notes

- Read-only. The synthesis step never modifies source or test files.
- Includes a mandatory **speed delta** section — current per-layer p95 vs. target.
