# Shipwright Adoption Roadmap

Prioritized features inspired by [oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode), adapted to shipwright's markdown-first philosophy. Each item stays within the zero-dependency, prompt-engineering approach — no TypeScript runtime, no npm, no build step.

---

## Priority 1: Cross-Session Handoff

**Effort:** Low (~20 lines added to dev-loop.md)
**Addresses:** #1 known gap — users lose all context on session interruption today.

### Current State
If `/dev-loop` is interrupted (session timeout, crash, `/clear`), the next session starts cold. The `recentChanges[]` rolling context, `retryMap`, and batch progress are lost. Tasks marked `[🔨]` (in-progress) are orphaned.

### What OMC Does
SQLite session state persists across sessions. Workers resume with full context from the database.

### Adoption Path
Add a `## Handoff` section to the planning doc, updated after each completed batch:

```markdown
## Handoff
<!-- Auto-updated by dev-loop. Do not edit manually. -->

Last completed: WS-1.2
Timestamp: 2026-03-31T14:30:00Z
Batch: 3 of 5

Recent changes:
- WS-1.1: Add workspace model — changed 4 files (schema, migration, types, seed)
- WS-1.2: Add workspace API routes — changed 3 files (routes, controller, tests)

Retry map:
- WS-2.1: 1 (failed once, re-queued)

Notes:
- WS-2.1 failed due to missing seed data; may need WS-1.1 migration to run first
```

**Changes to dev-loop.md:**
- Phase 0: Read `## Handoff` section if present. Restore `recentChanges[]` and `retryMap` from it.
- Phase 3 (end of each batch): Write/update `## Handoff` section with current state. Commit: `chore: update handoff state after batch N`.
- Loop END: Remove `## Handoff` section (loop complete, no handoff needed).

**Changes to dev-task.md:**
- Step 4 (mark in-progress): If task was `[🔨]` from a prior session, check for orphaned branches/PRs before starting. Clean up if found.

---

## Priority 2: Model Routing Per Task

**Effort:** Low (add field to plan-session Phase 4, pass to Agent() in dev-loop Phase 2)
**Addresses:** Cost optimization — currently all subagents use the session model regardless of task complexity.

### Current State
Every subagent inherits the session model. A simple "add a config field" task uses the same model as a complex "redesign the auth middleware" task.

### What OMC Does
Routes tasks to LOW (haiku), MEDIUM (sonnet), HIGH (opus) tiers. Claims 30-50% cost savings.

### Adoption Path
Add a `Model` column to the planning doc task table during `/plan-session` Phase 4:

| Task | Title | Est. | Deps | Model | Status |
|------|-------|------|------|-------|--------|
| WS-1.1 | Add workspace model | 2h | — | sonnet | [ ] |
| WS-1.2 | Add config field | 1h | — | haiku | [ ] |
| WS-2.1 | Redesign auth flow | 6h | WS-1.1 | opus | [ ] |

**Routing heuristics for plan-session Phase 4:**

| Complexity Signal | Model Tier |
|---|---|
| Single file, < 50 lines changed, no cross-layer impact | `haiku` |
| Standard feature work, 2-5 files, tests included | `sonnet` |
| Architectural change, cross-layer, new patterns, > 5 files | `opus` |

**Changes to dev-loop.md:**
- Phase 2a (context briefing): Read `Model` column from planning doc task entry.
- Phase 2b (Agent launch): Pass `model` parameter to `Agent()` call: `Agent(model: "{tier}")`.

**Changes to plan-session.md:**
- Phase 4 (task breakdown): Add Model column assignment using heuristics above.
- Phase 4b (consolidation): Merged tasks inherit the higher model tier.

---

## Priority 3: Task Complexity Scoring

**Effort:** Low (add scoring criteria to plan-session Phase 4)
**Addresses:** Foundation for model routing and timeout detection.

### Current State
Tasks are estimated in hours (1-8h) but have no formal complexity score. The hour estimate is a proxy but doesn't capture cross-layer impact or risk.

### What OMC Does
Scores task complexity to route to appropriate model tier and set execution parameters.

### Adoption Path
Add a `Complexity` field (1-5) to each task during `/plan-session` Phase 4:

| Score | Criteria | Typical Model | Typical Timeout |
|---|---|---|---|
| 1 | Single file, config change, no tests needed | haiku | 15 min |
| 2 | 1-2 files, straightforward logic, unit tests | haiku/sonnet | 30 min |
| 3 | 3-5 files, standard feature, integration tests | sonnet | 60 min |
| 4 | 5+ files, cross-layer, new patterns, E2E tests | sonnet/opus | 90 min |
| 5 | Architectural, multiple layers, migration, perf-sensitive | opus | 120 min |

**Scoring inputs:**
- Files touched (from Location field)
- Layers crossed (from Architecture Layer field)
- New code vs. modification
- Test requirements (unit, integration, E2E)
- Dependency count

**Changes to plan-session.md:**
- Phase 4: Score each task 1-5 using the criteria above. Store in `Complexity` column.
- Use complexity to auto-assign Model tier (Priority 2) and timeout (Priority 5).

---

## Priority 4: Persistent Metrics

**Effort:** Low (one JSONL line per task completion)
**Addresses:** No historical data to improve future estimates.

### Current State
The dev-loop retrospective prints stats (actual vs. estimated hours, retry count) but they're lost when the session ends. Each `/plan-session` starts from zero — no signal on historical estimation accuracy.

### What OMC Does
SQLite stores task duration, retry counts, cost metrics across sessions for analytics.

### Adoption Path
Append a single JSONL line to `planning/{name}/metrics.jsonl` after each task completion:

```json
{"task":"WS-1.1","title":"Add workspace model","estimated_h":2,"actual_h":1.5,"complexity":3,"model":"sonnet","retries":0,"pr":42,"hotfixes":0,"files_changed":4,"ts":"2026-03-31T14:30:00Z"}
```

**Changes to dev-loop.md:**
- Phase 3 (post-task): After confirming `[x]`, append metrics line to `metrics.jsonl`.
- Loop END (retrospective): Read `metrics.jsonl` to compute aggregate stats (mean estimation error, retry rate, model distribution).

**Changes to plan-session.md:**
- Phase 4 (estimation): If `metrics.jsonl` exists from prior runs, read it and report: "Historical data: average estimation error is +30%, consider adjusting."
- Phase 4 (model assignment): If historical data shows haiku-tier tasks succeeding < 70% of the time, suggest upgrading to sonnet.

**File format:** JSONL (one JSON object per line) — no parsing library needed, `grep` + `jq` for manual inspection.

---

## Priority 5: Timeout Detection

**Effort:** Medium (add timeout param + failure handling in dev-loop.md)
**Addresses:** Hung subagents blocking the entire loop indefinitely.

### Current State
`/dev-loop` launches subagents and waits indefinitely. If a subagent stalls (infinite loop, waiting for input it shouldn't ask for, context window exhaustion), the entire loop hangs.

### What OMC Does
Periodic heartbeat checks detect stalled workers. Auto-restarts with throttling prevent cascades.

### Adoption Path
Use the `timeout` parameter on `Agent()` calls, derived from task complexity:

| Complexity | Timeout |
|---|---|
| 1-2 | 15-30 min (900,000-1,800,000 ms) |
| 3 | 60 min (3,600,000 ms) |
| 4 | 90 min (5,400,000 ms) |
| 5 | 120 min (7,200,000 ms) |

**Changes to dev-loop.md:**
- Phase 2b (Agent launch): Pass `timeout` based on complexity score.
- Phase 3a (failure handling): If Agent returns with timeout error, treat as failure:
  - First timeout: re-queue with +1 complexity tier (give it more time/better model)
  - Second timeout: mark `[⏸]` (blocked), log to metrics

**Fallback:** If `Complexity` field is not present (older planning docs), default to 90 min timeout.

---

## Priority 6: File Impact Map (Transitive Conflict Detection)

**Effort:** Medium (new planning phase)
**Addresses:** Parallel execution merge conflicts from transitive file dependencies.

### Current State
`/dev-loop` Phase 1 checks the `Location` field for direct file overlap between tasks. Cannot detect transitive conflicts — e.g., Task A modifies `utils.ts` while Task B imports from `utils.ts` and modifies `component.tsx`.

### What OMC Does
OMC doesn't solve this directly either, but its multi-process isolation means conflicts surface as merge failures with automatic recovery. The marketplace could do better by detecting them upfront.

### Adoption Path
During `/plan-session`, build an explicit file impact map stored in the planning doc:

```markdown
## File Impact Map
<!-- Auto-generated by plan-session Phase 3b. Used by dev-loop for conflict detection. -->

| File | Direct (modifies) | Indirect (imports/depends) |
|---|---|---|
| src/models/workspace.ts | WS-1.1 | WS-1.2, WS-2.1 |
| src/routes/workspace.ts | WS-1.2 | WS-2.1 |
| prisma/schema.prisma | WS-1.1 | WS-1.2, WS-2.1, WS-3.1 |
```

**Changes to plan-session.md:**
- Phase 3b (new sub-phase): After codebase analysis, trace imports/dependencies for each task's Location files. Build the File Impact Map.
- Use Grep to find `import ... from '{file}'` patterns for each modified file.

**Changes to dev-loop.md:**
- Phase 1 (batch composition): Read File Impact Map. Two tasks conflict if either:
  - Both have the same file in their `Direct` column (existing check)
  - One has a file in `Direct` and the other has the same file in `Indirect` (new check)

---

## Priority 7: CI Wrapper

**Effort:** Low (shell one-liner)
**Addresses:** Cannot trigger dev-loop from CI/CD or headless environments.

### Current State
Shipwright operates inside Claude Code sessions only. No way to trigger `/dev-loop` from a GitHub Action, cron job, or script.

### What OMC Does
`omc autopilot` runs Claude autonomously from the terminal. Full CLI for scripting.

### Adoption Path
A thin shell script at `scripts/shipwright-ci.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

PLAN_NAME="${1:?Usage: shipwright-ci.sh <plan-name>}"

# Permission pre-flight must have been run already (plan-session Phase 7)
if [ ! -f ".claude/pipeline-permissions-added.json" ]; then
  echo "Error: Run /plan-session first to generate permissions" >&2
  exit 1
fi

claude --dangerously-skip-permissions \
  -p "Run /dev-loop ${PLAN_NAME}" \
  --max-turns 200
```

**Pairs with:** Permission pre-flight (plan-session Phase 7) which already generates the needed `.claude/settings.local.json` entries.

**Limitations:**
- `--dangerously-skip-permissions` is required for headless — security implications should be documented
- Max turns prevents runaway sessions
- No interactive pause points in CI mode (all --merge behavior)

---

## Summary

| # | Feature | Effort | Impact | Dependencies |
|---|---|---|---|---|
| 1 | Cross-session handoff | Low | High | None |
| 2 | Model routing per task | Low | High | None (enhanced by #3) |
| 3 | Task complexity scoring | Low | Medium | None (feeds #2 and #5) |
| 4 | Persistent metrics | Low | Medium | None (enhanced by #3) |
| 5 | Timeout detection | Medium | Medium | #3 (for timeout values) |
| 6 | File impact map | Medium | Medium | None |
| 7 | CI wrapper | Low | Low | Permission pre-flight (existing) |
