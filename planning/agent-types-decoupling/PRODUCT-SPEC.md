# Agent runtime / coding decoupling — Product Specification

**Date**: 2026-10-19
**Session**: agent-types-decoupling
**Status**: Draft
**Repo**: `app-vitals/shipwright`
**Context**: [`CONTEXT.md`](./CONTEXT.md) (decisions, scope), [`AUDIT.md`](./AUDIT.md) (dependency findings)

## Overview

Separate the generic agent runtime (Slack, Claude invocation, cron dispatch, chat, sessions, setup, health) from the coding-agent behavior (PR/task reconcilers, loop orchestrator, `check-*` scripts, GitHub auth) inside `agent/`, so additional agent types can run on the same runtime without carrying coding assumptions. This is a **pure refactor**: no behavior change for existing agents, no new manifest fields, no published interfaces.

## Problem Statement

`agent/src/index.ts` is a hardcoded composition root. Per the audit, 18 of the 21 runtime-to-coding import edges are `index.ts` wiring coding periodic work and GitHub auth directly into runtime boot; `check-helpers.ts` (1.5k lines) mixes generic `gh` helpers, policy parsers and coding-only logic; and nothing enforces a boundary, so new coupling can accrue silently. The `specialist` agent type (SAT-1.1/1.2) now lets non-coding agents exist, but they still boot a runtime that assumes coding.

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

## Features

### Feature 1: Coding extension seam in `index.ts`

**Priority**: High
**Description**: Replace the hardcoded coding wiring in `index.ts` and `entrypoint-main.ts` with a registration interface the coding code plugs into. No files move in this feature.

**Requirements**:
- Define a small extension interface covering what coding contributes at boot today: periodic passes (PR-state reconciler incl. review-state pass, worktree reaper, claim-invariant reconciler, PR census), the loop orchestrator getter and loop job classification/refs, the work-queue reporter, the allowlist/policy refs, and GitHub auth setup/installations reporting.
- Runtime boot code calls registered extensions; it no longer imports coding modules directly (except through the one place that registers the `coding` extension).
- Preserve each pass's current semantics: lazy deps built on first tick, own try/catch, non-fatal logging with the same log prefixes, same interval env vars.
- Document the boot order (it is currently implicit in comments) and assert it in a test.

**Acceptance Criteria**:
- [ ] `index.ts` and `entrypoint-main.ts` contain no direct imports of `check-*`, `loop-*`, `pr-*`, `worktree-reaper`, `claim-invariant-*`, `work-*`, `github-*`, `setup-github-auth` or the allowlist refs, other than the single coding registration point
- [ ] A test fails if the boot sequence order changes
- [ ] All existing agent tests pass without modification to assertions
- [ ] A coding agent boots identically (same log lines for each reconciler start and for loop wiring) — verified by the existing entrypoint/cron-handler smoke and integration tests

**Technical Considerations**: Highest behavior risk in the program. Several passes share state or timing with the cron sync loop (`loopJobsRef` is set before the first cron sync); the design step must identify which ordering constraints exist before choosing the interface shape.

**Source Map**: `agent/src/index.ts`, `agent/src/entrypoint-main.ts`, `agent/src/loop-jobs-ref.ts`, `agent/src/loop-cron-classifier.ts`, `agent/src/github-auth-startup.ts`, `agent/src/github-auth-deps.ts`, `agent/src/setup-github-auth.ts`.

**Testing Strategy**: Layer: unit for the registration seam and boot-order assertion; existing integration/smoke tests act as the behavior-preservation guard.

### Feature 2: Split `check-helpers.ts`

**Priority**: High
**Description**: Separate the generic and coding-only parts of `check-helpers.ts` so runtime modules stop importing a coding file.

**Requirements**:
- Generic `gh` helpers (`ghJson`, `ghRun`, `ghGraphql`, `getCurrentUser`) and the six policy parsers plus their `read*` wrappers (used by `agent-policy-backfill`) move to runtime-side modules.
- Review-state classification, task-store/PR query clients, candidate-id helpers, skip/bundle queries and repo resolution stay with coding.
- No behavior changes; `check-helpers.ts` may remain as a re-export shim during the transition if it keeps the diff reviewable.

**Acceptance Criteria**:
- [ ] `agent-policy-backfill.ts` and `index.ts` no longer import from `check-helpers.ts`
- [ ] Moved functions are byte-for-byte the same logic; existing `check-helpers.unit.test.ts` cases pass unchanged (relocated alongside their functions)
- [ ] External importers (`scripts/hitl.ts`, `plugins/shipwright/scripts/diagnose-review-candidacy.ts`) still typecheck

**Source Map**: `agent/src/check-helpers.ts`, `agent/src/agent-policy-backfill.ts`, `agent/src/index.ts`, `scripts/hitl.ts`, `plugins/shipwright/scripts/diagnose-review-candidacy.ts`.

**Testing Strategy**: Layer: unit (relocate existing tests with the functions).

### Feature 3: Directory move and boundary check

**Priority**: High (depends on Features 1 and 2)
**Description**: Move files into `agent/src/runtime/` and `agent/src/coding/` within the existing package, and enforce one-way dependency (coding → runtime).

**Requirements**:
- Runtime files and tests move to `agent/src/runtime/`; coding files and tests to `agent/src/coding/`, using the classification in `AUDIT.md` (judgment calls confirmed during planning).
- Keep `agent/src/entrypoint-main.ts` at its current path (base-image contract); it may be a thin shim into the runtime directory.
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

## Suggested ordering (to be settled in planning)

Feature 4 first (guard), then 1 and 2 (independent), then 3 (needs 1 and 2). Feature 5 in parallel with any of them, serialized against Feature 3 only if both touch `setup.ts` paths. Consider a HITL review checkpoint after Feature 1, since its design sets the interface the rest of the program builds on.

## Open Questions

- Extension interface shape (design step of planning).
- Classification judgment calls: `agent-repos-ref`, `gh-*`, `github-*`, `sync-config-clone`, `work-queue-reporter`.
- Is GitHub auth best owned by the coding extension or exposed as an optional integration any type can opt into? (Direction from CONTEXT.md: GitHub should be an option for agents generally; this refactor should not make that harder.)
