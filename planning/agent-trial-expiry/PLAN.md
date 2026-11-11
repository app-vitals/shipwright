# Agent Trial Expiry — Plan

**Session**: agent-trial-expiry
**Repo**: app-vitals/shipwright
**Spec**: `planning/agent-trial-expiry/PRODUCT-SPEC.md`

## Technical Design

**ATE-1.1** adds `trialExpiresAt`/`trialExpiryWarnedAt` (both nullable `DateTime`) to `Agent` and wires them through the existing PATCH/GET route. **ATE-2.1** and **ATE-3.1** both depend on it but are independent of each other.

**2026-09-24 correction (Dan): no auto-deprovisioning.** `ATE-3.1` no longer calls `deleteAgentFully()` — a trial ending should lock the agent down, not destroy it (the customer may convert to paid, and losing the GitHub App install / K8s workload / chat history on expiry would be a bad experience to walk back from). Redesigned as a lockdown: disable every one of the agent's `AgentCronJob` rows (via the existing per-cron `PATCH /agents/:id/crons/:cronId` — no bulk endpoint exists) and reject inbound Slack messages/mentions/reactions before invoking Claude, mirroring the existing `shouldRejectSlackSender()` gate pattern in `agent/src/slack.ts` (checked identically by all three inbound handlers: `app.message`, `app_mention`, `reaction_added`). Unlike that silent-drop gate, the trial-expiry gate replies once with a clear notice rather than going quiet. No new DB field beyond `trialExpiresAt` — both checks read it directly. `ATE-1.1` already has PR #3656 open (unaffected by this change, its own scope is unchanged) — this correction only touches `ATE-3.1`, which was still `pending` with no code.

All three tasks are additive. No renames or removals.

## Task Table

| ID | Title | Layer | Branch | Depends on | Hours | Complexity | Model | HITL |
|----|-------|-------|--------|------------|-------|------------|-------|------|
| ATE-1.1 | Add trialExpiresAt + trialExpiryWarnedAt fields to Agent + admin API | Database | feat/ate-1-1-trial-expiry-fields | — | 2 | 2 | sonnet | |
| ATE-2.1 | Add pre-expiry Slack warning check | Background | feat/ate-2-1-expiry-warning | ATE-1.1 | 3 | 3 | sonnet | |
| ATE-3.1 | Add trial-expiry lockdown: disable crons + block Slack messages (no deprovisioning) | Background | feat/ate-3-1-expiry-teardown | ATE-1.1 | 3 | 4 | sonnet | |

## Dependency Map

```
[START]
  └─ ATE-1.1: trial expiry fields (no deps)
        ├─ ATE-2.1: pre-expiry warning (needs 1.1)
        └─ ATE-3.1: trial-expiry lockdown (needs 1.1)
```

```
Task     | Depends on | Blocks | HITL
ATE-1.1  | —          | 2.1, 3.1 |
ATE-2.1  | 1.1        | —        |
ATE-3.1  | 1.1        | —        |
```

## Breaking Change Safety

All three tasks are additive (new nullable columns, new scheduled checks that no-op for agents with `trialExpiresAt` unset, and — per the 2026-09-24 correction above — a lockdown check that disables the agent's crons and blocks inbound Slack messages, with no `deleteAgentFully()` call anywhere in this feature). Safe to deploy standalone: yes, for every task.

## HITL Scan

No tasks matched the Type A keyword heuristic or judgment step. `HITL scan: no tasks require human steps`. Note: ATE-3.1's real-world blast radius (accidentally disabling crons or blocking Slack messages for a non-expired agent on an off-by-one — nothing is deleted under the corrected lockdown design) is handled via its acceptance criteria's explicit not-yet-expired no-op test requirement, not via HITL routing — this is ordinary autonomously-buildable code with strong test requirements, not a human-execution task.

## Decision Log

None — this session ran with a human (Dan, via this planning thread) providing the spec's Resolved Decisions directly; no autonomous-mode defaults were applied.
