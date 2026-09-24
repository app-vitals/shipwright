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

Once CF-2.1 merges and deploys, create the cron on this agent — a plain-language prompt referencing the repo-local runbook, not a `/shipwright:*` command invocation:

```bash
curl -sf -X POST -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" \
  -d '{"name": "shipwright-competitive-freshness", "schedule": "0 8 * * *", "prompt": "Run scripts/check-competitive-freshness.ts. For any page it flags, follow scripts/competitive-refresh-runbook.md.", "enabled": true, "silent": true}'
```

Note: every existing `preCheck` example in this repo's docs (`docs/agent-types.md`, `docs/site-docs-freshness.md`) uses a `{pluginName}:{scriptPath}` reference resolved against an *installed plugin's* `scripts/` directory (e.g. `shipwright:check-site-docs-freshness.ts`) — whether it can resolve a bare repo-root path like `scripts/check-competitive-freshness.ts` (outside any plugin) is **unconfirmed**, not verified false, just not checked. Whoever wires up this cron should check the actual preCheck-resolution code first: if a repo-root path works, prefer `preCheck` (cheaper — skips the Claude turn entirely when nothing is stale, matching `shipwright-site-docs-freshness`'s pattern); if it only resolves plugin-bundled scripts, fall back to the plain-language prompt above, which runs the check inline as the cron's own first step (correct either way, just a turn spent even on a no-op tick).
