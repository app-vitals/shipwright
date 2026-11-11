# Agent runtime / coding decoupling — Product Specification

**Date**: 2026-10-19
**Session**: agent-types-decoupling
**Status**: Draft
**Repo**: `app-vitals/shipwright`
**Context**: [`CONTEXT.md`](./CONTEXT.md) (decisions, scope), [`AUDIT.md`](./AUDIT.md) (dependency findings)

## Overview

Separate the generic agent runtime (Slack, Claude invocation, cron dispatch, chat, sessions, setup, health) from the coding-agent behavior (PR/task reconcilers, loop orchestrator, `check-*` scripts, GitHub auth) inside `agent/`, so additional agent types can run on the same runtime without carrying coding assumptions. This is a **pure refactor**: no behavior change for existing agents, no new manifest fields, no published interfaces.

## Problem Statement

`agent/src/index.ts` is a hardcoded composition root. Per the audit, 18 of the 21 runtime-to-coding import edges are `index.ts` wiring coding-specific passes directly into runtime boot (the GitHub auth edges are resolved by classifying GitHub auth and repo scope as runtime, see below); `check-helpers.ts` (1.5k lines) mixes generic `gh` helpers, policy parsers and coding-only logic; and nothing enforces a boundary, so new coupling can accrue silently. The `specialist` agent type (SAT-1.1/1.2) now lets non-coding agents exist, but they still boot a runtime that assumes coding.

## Users & Context

Maintainers adding non-coding agent types (first: marketing, later others). No end-user-visible change. Existing agents, including every vitals-os agent built `FROM shipwright-agent`, must keep working across a base-tag bump.

## Non-goals

Marketing repo move or Saul cutover; external manifest loading; loop/candidate-provider schema; work-item base or task-store changes; publishing the manifest schema; admin-side coding code (`agent-work-queue`, `agent-phase-methodology`, allowlists); separate npm packages (directories within one package first).

## Guardrails (apply to every task)

- Behavior-preserving: existing tests pass **unmoved-in-content** (tests may be relocated, not edited beyond import paths).
- The base-image contract does not change: image name/tag scheme, `/opt/shipwright/marketplaces/` convention root, `installPlugins()` boot behavior, and the entrypoint path `/app/agent/src/entrypoint-main.ts`.
- `index.ts` boot order is preserved (health server, mise, plugins, runtime client, reconcileSystemCrons, reconcilers, cron sync loop).
- No new manifest schema fields; manifest stays `v1alpha1`, unpublished.

---

## Classification decisions (settled in planning, 2026-10-19)

Refines `AUDIT.md`'s name-pattern classification:

- **Runtime, for every agent type:** `agent-repos-ref`, `sync-config-clone`, the whole GitHub auth family (`github-app-auth`, `github-installations`, `github-installations-reporter`, `github-auth-deps`, `github-auth-startup`, `setup-github-auth`, `gh-token-files`, `gh-owner-resolver`), `worktree-reaper`, `cleanup-after-days-ref`. Rationale: GitHub auth and repo scope are wanted by all types (the marketing agent uses them), and repo scope is already in the generic config contract. Putting them in coding would force the GitHub code to depend on coding.
- **Coding:** `check-*`, `loop-*`, `work-selector`, `work-queue-reporter`, `pr-state-reconciler`, `pr-census`, `pr-origin-backfill`, `patch-outcome-check`, `claim-invariant-reconciler`, and the PR-policy refs (`allow-self-review-ref`, `review-author-allowlist-ref`, `patch-author-allowlist-ref`, `cleanup-merged-worktrees-ref`).
- **Principle:** the dependency arrow decides. Anything both coding and a runtime-level capability need lives in runtime.

## Extension seam design (settled)

`runtime/extension.ts` defines an `AgentExtension` interface; the runtime calls it at fixed points. Built from a context object (config, `runner`, `sessions`, `cronRunReporter`, `contextStamp`, Sentry client).

| Hook | Coding implementation | Today |
|---|---|---|
| `onConfigSync(bundle)` | sets the four PR-policy refs | `index.ts` `syncConfig()` |
| `periodicPasses` (named, async) | PR-state reconciler, review-state pass, claim-invariant reconciler, PR census | combined reconciler tick |
| `onCronJobs(jobs)` | sets the loop's live jobs ref | `loopJobsRef.set(jobs)` |
| `classifyCronJobs(jobs)` | marks `shipwright-loop` as dispatch kind "loop"; default is all-generic | `classifyCronJobsForScheduling` |
| `dispatchLoop(id)` | lazily builds the orchestrator, runs a tick; constructs its own `WorkQueueReporter` | `getLoopOrchestrator` |

Decisions:
1. **`index.ts` stays at its path and is the composition root**, the one file allowed to import both runtime and coding, via a single `coding/extension.ts`. No shim, and the spawn path and `entrypoint-main.ts` are unchanged.
2. **The coding extension loads unconditionally for now.** Every agent today (including `specialist`) already runs these passes; unconditional loading preserves behavior. Gating by agent type once the runtime knows its type (Feature 5) is a deliberate follow-up behavior change, not part of this refactor.
3. **Pass order changes in one way:** the worktree reaper becomes a runtime pass and runs before the coding passes. The passes are independent with per-pass try/catch; note it in acceptance criteria.
4. **Per-pass behavior is preserved:** lazy deps, own try/catch, non-fatal logging with the same prefixes, same interval env vars, `onCronJobs` called before classification each tick.

---

## Features

### Feature 0: Policy cleanup (remove the legacy `agent-policy.md` tier)

**Priority**: High (lands first; shrinks `check-helpers.ts` before Feature 2)
**Description**: The six agent-policy fields (`autoPostReviews`, `allowSelfReview`, `minConfidence`, `maxFindings`, `cleanupMergedWorktrees`, `cleanupAfterDays`) are DB settings, synced via `GET /agents/:id/config` and editable in the admin UI. The read order is still DB, then `state/agent-policy.md`, then hardcoded defaults, plus a one-off backfill. For an agent that reaches the admin API the file tier is dead code. All live agents have been confirmed to hold the intended DB values (Dan, 2026-10-19), so the legacy tier can go.

**Requirements**:
- Agent runtime: remove the six `parse*` functions and the file tier from `readAllowSelfReview`, `readCleanupMergedWorktrees`, `readCleanupAfterDays` (and the review-policy readers); reads become synced-ref-or-hardcoded-default. `worktree-reaper` reads the refs instead of the file.
- Plugin: delete the file-only, caller-less `readAllowSelfReview`/`parseAllowSelfReview` in `plugins/shipwright/scripts/check-helpers.ts`; remove the "tier 2: file" step and prose from `commands/review.md`, `merge.md`, `deploy.md` and `references/user-guide.md`, updating their content tests. Hardcoded defaults stay as tier 2.
- Delete `agent/src/agent-policy-backfill.ts`, `agent/scripts/backfill-agent-policy.ts` and their tests.
- Stop seeding `state/agent-policy.md` (`setup.ts` and its template) and drop the references in `scripts/hitl.ts` and `scripts/agent-workspace-pull.ts`. Existing files on agent volumes are left untouched.
- Update repo docs (`configuration*.md`, `agent.md`, `agent-key-files.md`, `test-readiness/*` mentions) and, as a separate human-reviewed docs task, the public site pages (`configuring-autonomy.mdx`, `security.mdx`, `reference.mdx`, `the-shipwright-loop.mdx`, `autonomy.astro`) and `site/tests/autonomy.spec.ts`.

**Acceptance Criteria**:
- [ ] No code path reads `state/agent-policy.md`; `grep -rn "agent-policy.md"` over `agent/`, `plugins/`, `scripts/` returns only historical changelog or migration notes
- [ ] With the config fetch failing, each reader returns its documented hardcoded default (unit-tested per field)
- [ ] Existing readers' DB-tier tests pass unchanged; file-tier tests are deleted with the tier
- [ ] The plugin content tests pass with the updated prompt text
- [ ] The agent image builds and boots without the template

**Technical Considerations**: Behavior change only when the admin config fetch fails (falls to conservative hardcoded defaults instead of the file). Existing volume files are inert after this. Operators lose the backfill tool; mitigated by the confirmed state of all agents.

**Source Map**: `agent/src/check-helpers.ts`, `agent/src/agent-policy-backfill.ts`, `agent/scripts/backfill-agent-policy.ts`, `agent/src/worktree-reaper.ts`, `agent/src/setup.ts`, `agent/workspace/state/agent-policy.md.template`, `scripts/hitl.ts`, `scripts/agent-workspace-pull.ts`, `plugins/shipwright/scripts/check-helpers.ts`, `plugins/shipwright/commands/{review,merge,deploy}.md`, `plugins/shipwright/references/user-guide.md`, docs and site pages listed above.

**Testing Strategy**: Layer: unit (default-on-failure per field); existing content tests for prompts.

### Feature 1: Coding extension seam in `index.ts`

**Priority**: High
**Description**: Replace the hardcoded coding wiring in `index.ts` with the `AgentExtension` interface (see "Extension seam design"), implemented by a `coding` extension. No files move in this feature. GitHub auth is **not** part of the seam: it stays in runtime boot (`entrypoint-main.ts` and `index.ts`), per the classification decisions.

**Requirements**:
- Implement the five hooks in the seam table; `index.ts` calls them at the documented points and no longer imports coding modules directly, except the single `coding/extension.ts` registration.
- The coding extension owns: the four PR-policy refs and their `onConfigSync` setting, the PR-state/review-state/claim-invariant/census passes, the loop jobs ref, cron classification, the lazy loop orchestrator getter, and its own `WorkQueueReporter`.
- `worktree-reaper` is wired as a runtime periodic pass (it moves in Feature 3; here it may stay in place but is called from runtime code, not through the extension).
- Preserve per-pass semantics and log prefixes; document and test the boot order.

**Acceptance Criteria**:
- [ ] `index.ts` has no direct imports of `check-*`, `loop-*`, `pr-*`, `claim-invariant-*`, `work-*` or the PR-policy refs other than via the single coding registration
- [ ] A test fails if the boot sequence order changes
- [ ] `onCronJobs` runs before `classifyCronJobs` every tick (tested)
- [ ] A coding agent boots with the same log lines for reconciler start and loop wiring, verified by existing entrypoint/cron-handler smoke and integration tests, which pass without assertion changes
- [ ] The worktree-reaper pass-order change is noted in the PR description

**Technical Considerations**: Highest behavior risk in the program. `loopJobsRef` is set before the first cron sync; the loop orchestrator is a single stateful closure (cross-tick busy flag) and must stay constructed once, lazily.

**Source Map**: `agent/src/index.ts`, `agent/src/loop-jobs-ref.ts`, `agent/src/loop-cron-classifier.ts`, `agent/src/loop-orchestrator.ts`, `agent/src/work-queue-reporter.ts`, `agent/src/pr-state-reconciler.ts`, `agent/src/claim-invariant-reconciler.ts`, `agent/src/pr-census.ts`, the PR-policy refs.

**Testing Strategy**: Layer: unit for the seam and boot-order assertion; existing integration/smoke tests are the behavior-preservation guard.

### Feature 2: Split `check-helpers.ts`

**Priority**: High (after Feature 0, which removes the six policy parsers and file tiers from this file)
**Description**: Separate the generic and coding-only parts of the remaining `check-helpers.ts` so runtime modules stop importing a coding file.

**Requirements**:
- Generic `gh` helpers (`ghJson`, `ghRun`, `ghGraphql`, `getCurrentUser`) and the cleanup-policy readers (`readCleanupMergedWorktrees` stays with the PR-policy refs in coding; `readCleanupAfterDays` goes to runtime with the reaper) move to runtime-side modules.
- Review-state classification, task-store/PR query clients, candidate-id helpers, skip/bundle queries, repo resolution and the review-policy readers stay with coding.
- No behavior changes; `check-helpers.ts` may remain a re-export shim during the transition if that keeps the diff reviewable.

**Acceptance Criteria**:
- [ ] `index.ts` and `worktree-reaper.ts` no longer import from `check-helpers.ts`
- [ ] Moved functions keep identical logic; existing `check-helpers.unit.test.ts` cases pass unchanged (relocated with their functions)
- [ ] External importers (`scripts/hitl.ts`, `plugins/shipwright/scripts/diagnose-review-candidacy.ts`) still typecheck

**Source Map**: `agent/src/check-helpers.ts`, `agent/src/index.ts`, `agent/src/worktree-reaper.ts`, `scripts/hitl.ts`, `plugins/shipwright/scripts/diagnose-review-candidacy.ts`.

**Testing Strategy**: Layer: unit (relocate existing tests with the functions).

### Feature 3: Directory move and boundary check

**Priority**: High (depends on Features 1 and 2)
**Description**: Move files into `agent/src/runtime/` and `agent/src/coding/` within the existing package, and enforce one-way dependency (coding → runtime).

**Requirements**:
- Runtime files and tests move to `agent/src/runtime/`; coding files and tests to `agent/src/coding/`, using `AUDIT.md`'s classification as refined by "Classification decisions" above (GitHub auth, repo scope, `sync-config-clone` and `worktree-reaper` are runtime).
- Keep `agent/src/entrypoint-main.ts` and `agent/src/index.ts` at their current paths (base-image contract and spawn path); `index.ts` is the composition root and the single file exempt from the boundary check.
- Add an automated import-boundary check (lint rule or test) that fails when a runtime file imports a coding file, wired into CI.
- Update `agent/Dockerfile` bundle check, `plugins/shipwright/tsconfig.json`, and importers outside `agent/` for the new paths.

**Acceptance Criteria**:
- [ ] `git mv` history preserved; test file contents unchanged except import paths
- [ ] Boundary check fails on a deliberately introduced runtime→coding import (verified once, then removed)
- [ ] `bun test` and `tsc` pass; the agent Docker build and the `ci.yml` entrypoint assertion pass
- [ ] `/app/agent/src/entrypoint-main.ts` still starts the agent

**Source Map**: all of `agent/src`, `agent/Dockerfile`, `.github/workflows/ci.yml`, `plugins/shipwright/tsconfig.json`, `scripts/hitl.ts`, `scripts/agent-workspace-pull.ts`.

**Testing Strategy**: Layer: unit for the boundary check; build + existing suites as the proof of no behavior change.

### Feature 4: Base-image contract guard

**Priority**: High (land before Feature 3)
**Description**: A test that builds a derived image the way vitals-os does and asserts the contract holds, so a refactor cannot silently break downstream agents on a base-tag bump.

**Requirements**:
- Model on `vitals-os/infra/vitals-agent/baked-marketplace.smoke.test.ts`: derive from the agent image, copy a marketplace to `/opt/shipwright/marketplaces/<name>/`, and assert it registers at boot via `installPlugins()`.
- Also assert the entrypoint path exists and is executable by `bun run`.
- Runs in CI alongside the existing image build.

**Acceptance Criteria**:
- [ ] Test passes on current `main` before any refactor lands (establishes the baseline)
- [ ] Test fails if the convention root, `installPlugins()` registration, or entrypoint path is broken (verified by one deliberate break)
- [ ] CI runs it without new secrets

**Technical Considerations**: May need CI image-build time budget review; reuse the existing image-build job where possible.

**Source Map**: `agent/Dockerfile`, `.github/workflows/ci.yml`, `agent/src/setup.ts` (`installPlugins`), `agent/src/entrypoint-main.ts`.

**Testing Strategy**: Layer: smoke (image-level).

### Feature 5: Type-aware workspace templates

**Priority**: Medium (independent of Features 1-4; touches `setup.ts`)
**Description**: Let the runtime resolve workspace templates by agent type instead of always reading `agent/workspace/`, so a non-coding type can supply its own persona/CLAUDE.md. **This is the one task that is not a pure move**: the runtime does not currently know its type.

**Findings**: `AgentConfigResponse` (`GET /agents/:id/config`) has no `typeName`. `ensureAgentHome()` in `index.ts` runs before any config sync, and `setup.ts` reads `join(import.meta.dir, "..", "workspace")` unconditionally. Templates are seeded once (`seedFile` uses exclusive write), so this only affects new workspaces. `identity.templatesDir` exists in the manifest schema but nothing reads it.

**Requirements**:
- Surface the agent's `typeName` to the runtime (additive field on the config response and/or env passed by the entrypoint — design decision for planning).
- `ensureAgentHome`/`readTemplate` resolve the template directory from the type's manifest `identity.templatesDir`, defaulting to the current `agent/workspace/` for `coding` and for any type that does not resolve (never fail boot on this).
- No change to `coding` agents' seeded files.
- Moves coding's template directory only if needed; the `agent/workspace/` path must keep working for existing workspaces and for derived images.

**Acceptance Criteria**:
- [ ] A `coding` agent seeds byte-identical workspace files before and after (golden test)
- [ ] A `specialist` agent with a different `templatesDir` seeds that directory's files; an unresolvable type falls back to coding templates with a logged warning
- [ ] The config response change is additive and the generated OpenAPI/types are regenerated
- [ ] Existing workspaces are not rewritten

**Technical Considerations**: Ordering: `ensureAgentHome` runs before config is available in `index.ts`; the type may need to arrive via the entrypoint (which fetches config first). Confirm during the design step.

**Source Map**: `agent/src/setup.ts`, `agent/src/index.ts`, `agent/src/entrypoint.ts`, `agent/src/shipwright-config-client.ts`, `admin/src/api.ts` (`AgentConfigResponse`), `admin/src/openapi-schemas.ts`, `agent-types/*/manifest.yaml`.

**Testing Strategy**: Layer: unit (template resolution + fallback), integration (golden seeding for coding).

---

## Suggested ordering

Feature 0 first (and Feature 4's guard in parallel, since it only reads). Feature 1 in parallel with Feature 0. Feature 2 after Feature 0 (same file). Feature 3 after 1, 2 and 4. Feature 5 after Feature 3 (both touch `setup.ts` paths, so serialize to avoid merge conflicts). Planning decided design here, so no HITL checkpoint is needed for the seam.

## Open Questions

- Feature 5: deliver `typeName` via the config response (additive, regenerates OpenAPI types) or entrypoint env. Recommendation: config response (documented contract, simplest expected outcome).
- Whether to gate the coding extension by agent type once the runtime knows its type (follow-up, deliberate behavior change).
- Follow-up: the public-site copy for the policy cleanup needs a human read.
