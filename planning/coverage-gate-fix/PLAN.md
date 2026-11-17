# Plan: coverage-gate-fix

Repo: app-vitals/shipwright

Goal: let `test-roadmap` (phase 4 of test-readiness) complete for repos that do not yet
publish coverage — first `app-vitals/agent`, then `app-vitals/factorymode`.

## Findings

1. **Wrong script path.** `plugins/shipwright/skills/test-roadmap/SKILL.md` step 8 runs
   `bun run scripts/check-coverage-gate.ts` from the *target repo root*. The script lives only at
   the shipwright repo root (`scripts/check-coverage-gate.ts`), not in the plugin, so it is
   not found in any other repo. The sibling reader `coverage-summary.ts` is in the plugin and is
   already invoked via `${CLAUDE_PLUGIN_ROOT}`.
2. **Self-contradiction on `not_reporting`.** Since CVT-4.1 (#5344) `linePct` is sourced from the
   `shipwright-coverage` CI artifact via `coverage-summary.ts`. A repo with no artifact returns
   `not_reporting`. Step 9b emits a "Publish the shipwright-coverage artifact from CI" task on
   `not_reporting`, but step 8 treats `not_reporting` as "input unavailable" and routes to the
   refusal rule (abort), so 9b is unreachable for exactly the repos it targets.

Consequence: agent and factorymode need no CI changes up front. Once step 8 handles
`not_reporting`, phase 5 emits the publish-artifact task for each repo (self-bootstrapping).

## Design

- `CGF-1.1` moves the gate script (and its unit test) into `plugins/shipwright/scripts/` and
  invokes it via `${CLAUDE_PLUGIN_ROOT}`.
- `CGF-1.2` makes `linePct` nullable: with `linePct: null` and a reason the script returns
  `line_coverage_pct: null` and verdict `BLOCKED: line coverage not reporting`. Step 8 stops
  aborting on `not_reporting` and falls through to 9b. Genuine script failures still abort.

## Tasks

| Task | Depends on | Layer | Model | Hours |
|---|---|---|---|---|
| CGF-1.1 fix: ship check-coverage-gate in the plugin | — | CLI | haiku | 2 |
| CGF-1.2 fix: treat not_reporting as a gate outcome | CGF-1.1 | CLI | sonnet | 4 |
| CGF-1.3 chore: confirm the fix is live in the deployed plugin (HITL) | CGF-1.2 | CLI | haiku | 1 |

Safe to deploy standalone: yes (all). CGF-1.3 is HITL (verification only): the agent and factorymode
test-readiness tasks depend on it, factorymode additionally on the agent task (agent first).

## Decision Log

- Unmeasured line coverage: `null` + explicit verdict, not `0%` (approved by Dan, 2026-11-17).
  `0%` would mislead for repos with real tests (agent has ~339 test files).

## Not carried

- Re-running agent then factorymode: the cancelled test-readiness tasks were returned to pending with
  dependencies on CGF-1.3 (and factorymode on the agent task), so they dispatch on their own.
- Deployed plugin lag (gated by CGF-1.3): runs use the deployed plugin (1.484.0 at planning time); the fix reaches
  agents only after release + image rollout.
