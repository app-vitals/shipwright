---
description: Phase 1 — inventory the codebase and prescribe the test layer (unit/integration/smoke/E2E) for every meaningful unit of code, ranked by criticality.
argument-hint: [path]
allowed-tools: [Read, Glob, Grep, Bash, Write, Skill]
---

# /test-inventory

Run **Phase 1** of the test-readiness pipeline against the repo at `$ARGUMENTS` (defaults to `.`).

## What this does

Classify every meaningful unit of code in the target repo and prescribe the appropriate test layer:

- **Pure business logic** → unit
- **Service-boundary code** (DB, internal HTTP, file I/O) → integration
- **HTTP routes / public API surface** → smoke (also canary-eligible)
- **User journeys** (multi-step flows) → E2E (subset canary-eligible)
- **Error / failure paths** → unit + integration (never canary; destructive)
- **External integrations** (third-party APIs) → integration with recorded fixtures

Rank every item by criticality (`critical` / `high` / `medium`) and tag canary eligibility per the rules in `skills/canary-execution/SKILL.md`.

## Process

1. Invoke the `test-inventory` skill — it owns the classification logic and rubric application.
2. The skill reads:
   - `${CLAUDE_PLUGIN_ROOT}/assets/rubrics/code-classifier.md` for category assignment
   - `${CLAUDE_PLUGIN_ROOT}/assets/rubrics/layer-criteria.md` for layer prescription
3. Output is written to `docs/test-readiness/test-inventory.md` using the template in `${CLAUDE_PLUGIN_ROOT}/assets/templates/test-inventory.md.tmpl`.

## Output

A markdown file at `docs/test-readiness/test-inventory.md` containing:

- Summary table: code area → category → prescribed layer → criticality → canary-eligible (y/n)
- Per-category sections with rationale
- The **critical-path roster** (this defines the canary suite)

## Next step

Once the inventory is reviewed, run `/test-design` to produce the greenfield blueprint that will satisfy this inventory.

## Notes

- Read-only. This command never modifies source code or existing tests.
- If `docs/test-readiness/test-inventory.md` already exists, the command will refresh it. Existing artifact is overwritten — review and commit before re-running if you want to preserve.
