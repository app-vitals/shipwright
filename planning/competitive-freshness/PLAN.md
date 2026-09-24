# Competitive Page Freshness — Plan

**Session**: competitive-freshness
**Repo**: app-vitals/shipwright
**Spec**: `planning/competitive-freshness/PRODUCT-SPEC.md`

## Technical Design

Two tasks, sequential. **CF-1.1** adds `verifiedDate` to `compare.astro`'s rows and builds the age-based precheck (`check-competitive-freshness.ts`), mirroring `check-site-docs-freshness.ts`'s structure and exit-code contract exactly, but comparing dates instead of git SHAs. **CF-2.1** builds the `/shipwright:competitive-refresh` command depending on CF-1.1's data shape, doing live external verification (WebFetch cited sources + a general recent-news search) and applying the risk-tiered commit-vs-PR split from the spec's Resolved Decisions.

Creating the actual cron (`POST /agents/:id/crons`, prompt `/shipwright:competitive-refresh --auto`, preCheck `shipwright:check-competitive-freshness.ts`) is a follow-up config action once CF-2.1 merges and deploys — not a task-store task, since it's a one-line API call, not build work.

No renames or removals — `verifiedDate` is a new field, the precheck and command are new files. Safe to deploy standalone: yes, for both tasks.

## Task Table

| ID | Title | Layer | Branch | Depends on | Hours | Complexity | Model | HITL |
|----|-------|-------|--------|------------|-------|------------|-------|------|
| CF-1.1 | Add verifiedDate to compare.astro + check-competitive-freshness.ts precheck | CLI | feat/cf-1-1-competitive-freshness-precheck | — | 3 | 3 | sonnet | |
| CF-2.1 | Add /shipwright:competitive-refresh command (auto + interactive) | CLI | feat/cf-2-1-competitive-refresh-command | CF-1.1 | 4 | 4 | sonnet | |

## Dependency Map

```
[START]
  └─ CF-1.1: verifiedDate + precheck (no deps)
        └─ CF-2.1: competitive-refresh command (needs 1.1)
```

```
Task    | Depends on | Blocks | HITL
CF-1.1  | —          | 2.1    |
CF-2.1  | 1.1        | —      |
```

## Breaking Change Safety

Both tasks are additive (new field, new script, new command file). Safe to deploy standalone: yes, for both.

## HITL Scan

No tasks matched the Type A keyword heuristic or judgment step. `HITL scan: no tasks require human steps`. Note: CF-2.1's *output* (a PR proposing a competitor-claim change) goes through normal review by design — that's a content-risk mitigation built into the feature itself, not a HITL classification on the build task.

## Decision Log

None — this session ran with a human (Dan, via this planning thread) providing the go-ahead directly; no autonomous-mode defaults were applied.

## Follow-up (not a task-store task)

Once CF-2.1 merges and deploys, create the cron on this agent:

```bash
curl -sf -X POST -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" \
  -d '{"name": "shipwright-competitive-freshness", "schedule": "0 8 * * *", "prompt": "/shipwright:competitive-refresh --auto", "preCheck": "shipwright:check-competitive-freshness.ts", "enabled": true, "silent": true}'
```
