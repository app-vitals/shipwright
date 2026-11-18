# Plugin install integrity

## Problem
`plugins/shipwright/scripts/coverage/` (source, added by #5309/#5330/#5410) is missing from the
built agent image and the plugin installed from it. `scripts/coverage-summary.ts` imports
`./coverage/{normalize,types,exclusions}.ts`, so phase 4 of test-readiness fails and its
tasks block (e.g. SC-test-readiness-20261118T060000Z-app-vitals-agent).

## Root cause
`.dockerignore` carries `coverage` / `**/coverage` (to exclude coverage output) with no
negation, so `COPY plugins/ ./plugins/` in `agent/Dockerfile` silently drops the source dir.
`.gitignore` already has `!plugins/shipwright/scripts/coverage/`; `.dockerignore` never did.
The marketplace sync installs from the same image, so one fix covers both install paths.

## Goals
1. Plugin source under `plugins/` is never excluded from the Docker build context.
2. A broken relative import in the shipped plugin fails the image build, not a cron run.
3. `app-vitals/agent` (which also bakes `plugins/`) cannot regress the same way.
4. The blocked test-readiness tasks are retried on the fixed image.

## Non-goals
Changing how the marketplace syncs; renaming the `coverage` directory.

## Success Criteria
- Built image contains `plugins/shipwright/scripts/coverage/*`.
- CI fails if a tracked file under `plugins/` is excluded by the build context, or if a
  relative import under plugin `scripts/` is unresolved in the image.
- `SC-test-readiness-20261118T060000Z-app-vitals-agent` completes phase 4.

## Priorities & Sequence
Fix and checks (shipwright) first; agent-repo guard independent; rollout and retry last,
only after the fixed image is released.
