# Programmatic Agent Provisioning API — Plan

**Session**: agent-provisioning-api
**Repo**: app-vitals/shipwright
**Spec**: `planning/agent-provisioning-api/PRODUCT-SPEC.md`

## Technical Design

Two tasks. **APA-1.1** extracts the creation sequence currently inlined in `admin/src/admin-ui.ts`'s `POST /admin/agents` handler (~lines 1399-1769) into a single `createAgent()` service function in `admin/src/agents.ts`, wrapping the DB-writing steps in a Prisma transaction and replacing today's ad-hoc delete-on-failure rollback with real atomicity — except for the Kubernetes provisioning call, which stays a compensating delete-on-failure since it's an external side effect that can't join a DB transaction. The admin UI form handler is refactored to call this function instead of inlining the logic. **APA-2.1** exposes it as `POST /agents` in `admin/src/agents-api.ts`, admin-API-key-authenticated like every other route in that file, and depends on APA-1.1.

This is a refactor of live, working code — both tasks' acceptance criteria are behavior-preservation-focused (existing admin-UI creation flow must produce identical results) rather than behavior-change.

No renames or removals of any public API — `POST /agents` is new and additive; the admin UI form's route/behavior is unchanged from a user's perspective (same form, same result), only its internal implementation moves.

## Task Table

| ID | Title | Layer | Branch | Depends on | Hours | Complexity | Model | HITL |
|----|-------|-------|--------|------------|-------|------------|-------|------|
| APA-1.1 | Extract atomic createAgent() service function from admin UI form handler | API | feat/apa-1-1-atomic-create-agent | — | 4 | 4 | sonnet | |
| APA-2.1 | Add POST /agents admin-API route | API | feat/apa-2-1-post-agents-route | APA-1.1 | 2 | 2 | sonnet | |

## Dependency Map

```
[START]
  └─ APA-1.1: atomic createAgent() service function (no deps)
        └─ APA-2.1: POST /agents route (needs 1.1)
```

```
Task     | Depends on | Blocks | HITL
APA-1.1  | —          | 2.1    |
APA-2.1  | 1.1        | —      |
```

## Breaking Change Safety

APA-1.1 refactors internal implementation only — the admin UI form's external behavior (same route, same inputs, same outputs) is unchanged; acceptance criteria require test parity against existing form-handler fixtures. APA-2.1 adds a new route (additive). Safe to deploy standalone: yes, for both tasks.

## HITL Scan

No tasks matched the Type A keyword heuristic or judgment step. `HITL scan: no tasks require human steps`.

## Decision Log

None — this session ran with a human (Dan, via this planning thread) providing the spec's Resolved Decisions directly; no autonomous-mode defaults were applied. The shared-tier GitHub App/Slack/repo-access question is recorded in the spec's Scope section as a named external blocker (owner: Dan/Dave), not resolved by this plan.
