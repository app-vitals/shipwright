# Competitive Page Freshness — Plan

**Session**: competitive-freshness
**Repo**: app-vitals/shipwright
**Spec**: `planning/competitive-freshness/PRODUCT-SPEC.md`

## Technical Design

Two tasks, sequential. **CF-1.1** adds `verifiedDate` to `compare.astro`'s rows and builds the age-based precheck at `scripts/check-competitive-freshness.ts` (repo-root, not the distributed plugin), mirroring `check-site-docs-freshness.ts`'s date-comparison mechanism but comparing dates instead of git SHAs. **CF-2.1** builds `scripts/competitive-refresh-runbook.md` — a repo-local markdown runbook, not a distributed `/shipwright:*` command — depending on CF-1.1's data shape, describing live external verification (WebFetch cited sources + a general recent-news search) and the risk-tiered commit-vs-PR split from the spec's Resolved Decisions.

**2026-09-24 correction:** originally speced as `plugins/shipwright/scripts/...` and a distributed `plugins/shipwright/commands/competitive-refresh.md` — Dan caught that this is App-Vitals-specific business content (hardcoded competitor names, `brand/MESSAGING.md` dependency), not a generic plugin capability, and shouldn't ship to every shipwright-plugin installer. Both tasks were still pending with no code, so amended in place. See the spec's own correction note for the full reasoning.

Creating the actual cron (`POST /agents/:id/crons`, a plain-language prompt referencing the runbook, preCheck pointing at the repo-local precheck script) is a follow-up config action once CF-2.1 merges and deploys — not a task-store task, since it's a one-line API call, not build work.

No renames or removals — `verifiedDate` is a new field, the precheck and runbook are new files. Safe to deploy standalone: yes, for both tasks.

## Task Table

| ID | Title | Layer | Branch | Depends on | Hours | Complexity | Model | HITL |
|----|-------|-------|--------|------------|-------|------------|-------|------|
| CF-1.1 | Add verifiedDate to compare.astro + scripts/check-competitive-freshness.ts precheck | CLI | feat/cf-1-1-competitive-freshness-precheck | — | 3 | 3 | sonnet | |
| CF-2.1 | Add scripts/competitive-refresh-runbook.md (repo-local, not a plugin command) | CLI | feat/cf-2-1-competitive-refresh-command | CF-1.1 | 4 | 4 | sonnet | |

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

**Confirmed 2026-09-24** by reading `agent/src/cron-handler.ts`'s `preCheck` resolution directly: it supports two modes, a `plugin:script` namespaced form *and* a plain file-path form (any string starting with `./`, `../`, or `/`), where a relative path resolves against the agent's own workspace root (`resolve(workspace, req.preCheck)`). A repo-root, non-plugin script works via the file-path form — no plugin required, and it gets the same cost benefit as `shipwright-site-docs-freshness` (stdout becomes the prompt; the Claude turn is skipped entirely on a no-op tick, per the same contract documented in `docs/agent-ops.md`).

Once CF-2.1 merges and deploys, create the cron on this agent:

```bash
curl -sf -X POST -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" \
  -d '{"name": "shipwright-competitive-freshness", "schedule": "0 8 * * *", "prompt": "Follow scripts/competitive-refresh-runbook.md for every page the preCheck flagged.", "preCheck": "./scripts/check-competitive-freshness.ts", "enabled": true, "silent": true}'
```

The `prompt` here is a fallback/backstop only — per the `preCheck` contract, when the script exits 0 its **stdout replaces the prompt** (the flagged-pages summary becomes what Claude actually sees), and the cron is skipped without spending a Claude turn at all when it exits 1. `scripts/check-competitive-freshness.ts`'s exit-0 output should therefore itself reference the runbook by name (mirroring how `check-site-docs-freshness.ts`'s summary output drives `research-docs --auto`) so the real prompt Claude receives is self-contained.
