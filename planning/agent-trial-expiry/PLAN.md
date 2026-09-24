# Agent Trial Expiry — Plan

**Session**: agent-trial-expiry
**Repo**: app-vitals/shipwright
**Spec**: `planning/agent-trial-expiry/PRODUCT-SPEC.md`

## Technical Design

**ATE-1.1** adds `trialExpiresAt`/`trialExpiryWarnedAt` (both nullable `DateTime`) to `Agent` and wires them through the existing PATCH/GET route. **ATE-2.1** and **ATE-3.1** both depend on it but are independent of each other — a warning check and a teardown check, either sharing one scheduled job or running as two, per dev-task's Step 2 judgment. ATE-3.1 calls the existing `deleteAgentFully()` (`admin/src/agent-deletion.ts`) as-is; it does not reimplement teardown.

All three tasks are additive. No renames or removals.

## Task Table

| ID | Title | Layer | Branch | Depends on | Hours | Complexity | Model | HITL |
|----|-------|-------|--------|------------|-------|------------|-------|------|
| ATE-1.1 | Add trialExpiresAt + trialExpiryWarnedAt fields to Agent + admin API | Database | feat/ate-1-1-trial-expiry-fields | — | 2 | 2 | sonnet | |
| ATE-2.1 | Add pre-expiry Slack warning check | Background | feat/ate-2-1-expiry-warning | ATE-1.1 | 3 | 3 | sonnet | |
| ATE-3.1 | Add automatic teardown on trial expiry via deleteAgentFully() | Background | feat/ate-3-1-expiry-teardown | ATE-1.1 | 3 | 4 | sonnet | |

## Dependency Map

```
[START]
  └─ ATE-1.1: trial expiry fields (no deps)
        ├─ ATE-2.1: pre-expiry warning (needs 1.1)
        └─ ATE-3.1: automatic teardown (needs 1.1)
```

```
Task     | Depends on | Blocks | HITL
ATE-1.1  | —          | 2.1, 3.1 |
ATE-2.1  | 1.1        | —        |
ATE-3.1  | 1.1        | —        |
```

## Breaking Change Safety

All three tasks are additive (new nullable columns, new scheduled checks that no-op for agents with `trialExpiresAt` unset, a call to an existing, unmodified `deleteAgentFully()`). Safe to deploy standalone: yes, for every task.

## HITL Scan

No tasks matched the Type A keyword heuristic or judgment step. `HITL scan: no tasks require human steps`. Note: ATE-3.1's real-world blast radius (accidentally tearing down a live agent on an off-by-one) is handled via its acceptance criteria's explicit not-yet-expired no-op test requirement, not via HITL routing — this is ordinary autonomously-buildable code with strong test requirements, not a human-execution task.

## Decision Log

None — this session ran with a human (Dan, via this planning thread) providing the spec's Resolved Decisions directly; no autonomous-mode defaults were applied.
