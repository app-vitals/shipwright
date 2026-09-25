# Programmatic Agent Provisioning API — Product Specification

**Date**: 2026-09-24
**Session**: agent-provisioning-api
**Status**: Draft
**Repo**: `app-vitals/shipwright`

## Overview

A callable, atomic API for creating a fully-configured Shipwright agent (DB row + type-manifest seeding + repo/allowlist/member attachment + Claude credentials + Kubernetes provisioning), so agent creation can be triggered by something other than a human filling out the `/admin/agents/new` form. This is a narrower slice of a larger goal (supporting many students getting their own hosted agent during a course, not itself in scope here) — but it closes a real gap on its own: today there is no way to create an agent except through an admin-authenticated browser form.

## Status Note (added 2026-09-25, post-review)

**Both features described below have already shipped to `main`, independently of this planning PR's own review/merge status:**

- **Feature 1 (APA-1.1, `createAgent()`)** — merged via PR #3653 (2026-09-24), now living in `admin/src/agents.ts:574-779`.
- **Feature 2 (APA-2.1, `POST /agents`)** — merged via PR #3661 (2026-09-24), now living in `admin/src/agents-api.ts` (`createAgentRoute` defined at line 358, wired via `app.openapi(createAgentRoute, ...)` at line 1209).

This is the task-store/planning-PR async-execution pattern that exists elsewhere in this repo: `dev-task` pulls ready tasks from the task store independent of whether the planning session's own docs PR has merged. Two consequences for this document:

1. **Every line citation below is a stale, point-in-time snapshot.** The numbers below were accurate against `main` at this session's branch point (commit `144325988`). A review comment on this PR cited different numbers (handler starting at line 1546, rollback at 1765-1780) — those were verified against `main` roughly 11 hours later, after two unrelated PRs (#3634, #3642) had already shifted `admin-ui.ts`'s line numbers, and that snapshot was itself superseded within hours by PR #3653 restructuring the file again. Neither set of numbers is current as of this fix. Re-verify against `main` before relying on any line number in this document — don't treat the ranges below as ground truth for implementation.
2. **The ABF-3.2 "no in-repo caller" concern raised in review (below) was never actually resolved before `POST /agents` shipped** — see the HITL section after Scope.



## Problem Statement

Agent creation today is a multi-step, non-atomic sequence inside a single admin-UI form handler (`admin/src/admin-ui.ts`'s `POST /admin/agents`, ~line 1399): create the DB row, seed tools/plugins from the type manifest (rolling back by delete on failure), attach repos/allowlists/members (each independently rolled back on invalid input), patch in Claude credentials, optionally call the Kubernetes provisioner (rolling back the row on failure), reconcile system crons best-effort, and optionally run inline Slack/GitHub connect branches. There is no equivalent programmatic API — `admin/src/agents-api.ts` explicitly does not implement creation (its own comment states creation happens only via the web UI form). Any future system that needs to create agents without a human in a browser — a course signup flow, a provisioning script, a test harness — has nothing to call.

## Users & Context

- **An internal script or future external system** (e.g. a course signup flow, out of scope here) that needs to create an agent without a human filling out a form.
- **The existing admin UI form** itself: once this API exists, the form's handler should call it rather than duplicating the sequence — reducing two implementations of the same multi-step process to one.

---

## Features

### Feature 1: Atomic agent-creation service function

**Priority**: High
**Description**: Extract and harden the creation sequence currently inlined in `admin-ui.ts`'s form handler into a single service function that either fully succeeds or fully rolls back — no more ad-hoc delete-on-failure at each step.

**Requirements**:
- New function, e.g. `createAgent(input): Promise<Agent>` in `admin/src/agents.ts` (alongside the existing `agentService.create()` at line 166), wrapping the full sequence currently spread across `admin-ui.ts` lines ~1460-1641: validate `name`/`typeName` → create the `Agent` row → seed `AgentTool`/`AgentPlugin` from the type manifest → attach repos/allowlists/members → patch Claude credentials → call `provisioner.provision()` if `runtime=in-cluster` → best-effort `reconcileSystemCrons()`.
- Wrap the DB-writing steps (row creation, tool/plugin seeding, repo/allowlist/member attachment, credential patch) in a single Prisma transaction where the schema allows it, so a mid-sequence failure leaves no partial `Agent` row — replacing today's delete-on-failure rollback pattern.
- The Kubernetes provisioning call (`provisioner.provision()`) cannot join the DB transaction (it's an external side effect) — on its failure, delete the just-created `Agent` row (matching current behavior at `admin-ui.ts:1618-1633` as of this session's branch point — see Status Note above; this logic has since moved into `createAgent()` via PR #3653), and document this as the one step that is still compensating-rollback rather than transactional, since a cluster call can't be part of a database transaction.
- `reconcileSystemCrons()` stays best-effort/non-blocking, matching current behavior — a cron-reconciliation failure should not fail agent creation.
- Refactor `admin-ui.ts`'s `POST /admin/agents` form handler to call this new function instead of inlining the sequence, so there is exactly one implementation of "create an agent" going forward.

**Acceptance Criteria**:
- [ ] `createAgent()` with valid input produces the same end state (Agent row + tools + plugins + repos + allowlists + members + credentials + K8s resources when applicable) as today's form handler, verified by a test comparing against the existing form-handler test fixtures
- [ ] A failure injected at the tool/plugin-seeding step leaves zero `Agent` row behind (no partial state), verified by a test
- [ ] A failure injected at the Kubernetes provisioning step still deletes the `Agent` row, matching current behavior
- [ ] `admin-ui.ts`'s form handler calls the new function; no duplicate creation logic remains in `admin-ui.ts`
- [ ] Test decision: add integration tests for `createAgent()` covering the happy path and failure-at-each-step rollback; existing `admin-ui.ts` smoke tests for `POST /admin/agents` continue to pass unchanged (asserting the refactor is behavior-preserving), not retired

**Technical Considerations**: The DB-transaction boundary needs care — `admin/src/agents.ts:166`'s existing `agentService.create()` and whatever repo/allowlist/member attachment functions currently exist may not be written to run inside a caller-supplied transaction; this task may need to thread a Prisma transaction client through them. This is a refactor of live, working code (today's admin UI creation flow) — the acceptance criteria above are deliberately behavior-preservation-focused, not behavior-change.

**Source Map** (verified against this session's branch point, commit `144325988` — see Status Note above; already superseded by PR #3653's merge):
- `admin/src/admin-ui.ts:1399-1769` — inlined creation sequence at branch time. A review comment on this PR cited the handler starting at line 1546 instead; that number is also correct, but for `main` ~11 hours later (after two unrelated merges, #3634/#3642, shifted this file) — not for this branch's own fork point. Both citations are now moot: see below.
- `admin/src/agents.ts:166` — existing `agentService.create()` at branch time
- `admin/src/agent-provisioner.ts:242-407` — `KubernetesAgentProvisioner.provision()`, called as the external side-effect step
- `admin/src/agents-api.ts:5-7` — comment confirming no programmatic creation API exists today (also since superseded — see Status Note)
- **Now implemented** (post-review): `admin/src/agents.ts:574-779` — the real `createAgent()`, merged via PR #3653

**Testing Strategy**: Layer: integration — real Postgres, exercising the full transaction + rollback behavior; the Kubernetes call should use whatever double/fixture the existing `agent-provisioner` tests already use.

---

### Feature 2: `POST /agents` programmatic creation endpoint

**Priority**: High
**Description**: Expose Feature 1's `createAgent()` as an admin-API route, so an admin-API-key-authenticated caller can create an agent without a browser.

**Requirements**:
- New route in `admin/src/agents-api.ts`, `POST /agents`, admin-API-key-authenticated (same auth tier as other admin-only routes in this file — not the per-agent bearer tier), accepting the same input shape `createAgent()` takes.
- Returns the created `Agent` (same shape as `GET /agents/:id`) on success; returns a structured error (not a partial-success 200) on any failure, per Feature 1's atomicity guarantee.
- Update `agents-api.ts`'s file-header comment (currently states creation is UI-only) to reflect the new route.

**Acceptance Criteria**:
- [ ] `POST /agents` with valid input and a valid admin API key creates an agent and returns it, matching what the admin UI form would have produced for the same input
- [ ] `POST /agents` without a valid admin API key returns 401 with the standard `WWW-Authenticate` header (per this repo's existing auth-middleware convention)
- [ ] `POST /agents` with invalid input (e.g. missing `name`) returns a 4xx with no `Agent` row created
- [ ] Test decision: add a smoke test for the new route's contract (auth, happy path, validation failure), extending whatever existing smoke suite covers `agents-api.ts`

**Source Map**:
- `admin/src/agents-api.ts` — new route, alongside existing routes in this file
- `admin/src/agents-api.ts:1030-1044` — existing auth-tier pattern to match

**Testing Strategy**: Layer: smoke — HTTP route contract via in-process `app.request()`, matching this file's existing test pattern.

---

## Technical Constraints

- Must preserve exact current behavior for the existing admin-UI creation path — this is a refactor-plus-API-exposure, not a redesign of what agent creation does.
- The Kubernetes provisioning step remains a compensating-rollback (delete-on-failure), not part of the DB transaction — documented as a known limitation, not solved here.
- No new external-facing (unauthenticated) surface — `POST /agents` is admin-API-key-authenticated like every other route in `agents-api.ts`. This spec does **not** add a public signup endpoint or a GitHub/Slack installation webhook receiver.

## Scope

**In Scope**:
- Atomic (DB-transactional where possible) agent-creation service function
- `POST /agents` admin-API-authenticated route exposing it
- Refactoring the admin UI form to use the same function

**Out of Scope — named blockers, not decided here**:
- **A public-facing signup/self-serve trigger.** No webhook receiver, signup form, or unauthenticated endpoint exists anywhere in this repo today, and this spec doesn't add one. If a future course-signup flow needs to call `POST /agents`, it needs its own authentication story (e.g. a scoped token minted per signup) — not decided here.
- **Shared-tier GitHub App / Slack workspace architecture.** Today's auto-provision flow mints a brand-new GitHub App and a brand-new Slack app *per agent* (`admin/src/github-app-provisioning-client.ts:71-90`, `admin/src/slack-provisioning-client.ts:147-154`) — there is no shared/pooled-credential concept anywhere in the data model (`AgentEnv` rows are strictly `(agentId, key)`-scoped). This fits a "student installs their own GitHub App into their own org" tier reasonably well once Feature 2 makes creation callable. It does **not** fit a "shared GitHub App for students without org admin access" tier at all, and there is an unresolved question underneath that tier this spec will not guess at: if a student can't install a GitHub App into their own org, how does their repo get access — forked/mirrored into an App-Vitals-owned org the shared App is already installed into, or something else? **This blocks any shared-tier spec until Dan and Dave decide the repo-access model.** Flagging as a named external blocker, owner: Dan/Dave.
- **GitHub App installation webhook.** No `installation.created` (or similar) webhook receiver exists; today's flow captures `installation_id` via a synchronous browser redirect (`admin/src/github-provisioning-service.ts:450-495`). A future self-serve flow may need an async webhook instead, since a signup flow may not keep a browser session open through GitHub's install UI the way an admin does today — not decided here.
- **Trial expiry / auto-deprovisioning** — separate PRD.
- **Per-agent spend caps** — separate PRD (already queued, PR app-vitals/shipwright#3644).

## HITL: ABF-3.2 Re-run Risk (flagged for Dan/Dave)

`docs/migration.md` documents that `POST /agents` was retired 8 days before this PRD (ABF-3.2, commit `568a4fb15`, PR #3506) because it "had no in-repo caller ... confirmed with Dan (no external caller hits POST /agents on the deployed admin service)." That was an explicit human-in-the-loop decision, not a mechanical cleanup.

Feature 2 of this PRD re-adds the identical route. Feature 1's shared `createAgent()` does resolve ABF-3.2's *other* rationale (duplicated seeding logic between the UI form and the JSON API) — but the "no caller" concern is not resolved anywhere in this document. Feature 2's own stated caller is "an internal script or future external system (e.g., a course signup flow, out of scope here)" — i.e. hypothetical and explicitly deferred, not a real in-repo caller that exists today. Judged honestly, this reproduces the exact condition ABF-3.2 was retired for, rather than resolving it.

**This is flagged as a named HITL item for Dan/Dave, not resolved by this PRD**: either (a) confirm a real caller exists or is imminent enough to justify re-adding a callerless route now, or (b) hold Feature 2 until a real caller exists — e.g. gate it behind the same signup-flow work this PRD currently defers as out of scope.

**Post-review update (2026-09-25)**: this is no longer a hypothetical risk to weigh before building — `POST /agents` (Feature 2 / APA-2.1) already merged to `main` via PR #3661 while this planning PR was still in review (see Status Note above). The route is live today with no confirmed in-repo caller, exactly reproducing ABF-3.2's original condition. That makes Dan/Dave sign-off retroactive rather than a pre-build gate — the open question is now whether to leave it shipped, add the promised caller soon, or re-retire it a second time.

## Priorities & Sequence

Feature 1 must land before Feature 2 (the route calls the service function). No other ordering constraints.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| Atomic creation service function | integration | real Postgres, exercises transaction + rollback across multiple tables |
| POST /agents endpoint | smoke | HTTP route contract via in-process app.request() |

## Resolved Decisions

- **ABF-3.2 re-run risk**: not resolved by this PRD — flagged as a named HITL item for Dan/Dave. See the "HITL: ABF-3.2 Re-run Risk" section above.
- **Scope boundary**: this PRD covers only making creation atomic and callable — it explicitly does not attempt to solve self-serve triggering, shared-tier GitHub App/Slack architecture, or repo-access-without-org-admin-rights. — Rationale: those require product decisions (Dan/Dave) this session cannot make on its own; shipping a wrong guess on the shared-tier architecture would be worse than shipping nothing and flagging it.
- **Kubernetes step stays compensating-rollback, not transactional.** — Rationale: a cluster API call cannot participate in a Postgres transaction; matching today's delete-on-failure behavior is the correct scope for this PRD rather than inventing a saga/outbox pattern nobody asked for yet.
- **Auth tier for the new route: admin-API-key, not a new public tier.** — Rationale: keeps this PRD from accidentally creating the unauthenticated surface flagged as a named blocker above; a future self-serve flow's auth model is a separate, deliberate decision.

## Success Criteria

- `POST /agents` creates a fully-configured agent (DB row, tools, plugins, repos, allowlists, members, credentials, K8s resources when applicable) in one atomic call, matching what the admin UI form produces today.
- The admin UI form and the new API share one implementation of the creation sequence.
- A failure at any DB-writing step leaves zero partial `Agent` row.
- `task ci` passes with no regression to existing admin-UI creation-flow tests.
- The shared-tier GitHub App/Slack/repo-access question is recorded as an explicit open decision for Dan/Dave, not silently resolved by this PRD.
