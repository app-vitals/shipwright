# Plan: dev-task-scheduledwakeup-fix

Repo: `app-vitals/shipwright`

## Problem

`dev-task` sessions were re-running the same task repeatedly (5+ reruns observed on
several tasks over 3 days). The originally-suspected cause was a silent `ScheduleWakeup`
resume failure. Investigation (code-verified, not theoretical) found the real mechanism:

- `ScheduleWakeup` is not implemented anywhere in `app-vitals/shipwright` — grepped
  `agent/src` and the whole repo, zero references outside content-test assertions that it
  shouldn't be mentioned in `dev-task.md`. It's a harness-level capability outside
  Shipwright's control.
- A dev-task session hits a long-running Step 8 check, calls `ScheduleWakeup`, and ends its
  turn. The process exits cleanly (no error, no timeout) — from `_runClaude`'s perspective
  this is an ordinary successful run that simply didn't finish the task.
- Ending the session stops the task's claim heartbeat. Task-store's `StaleClaimReaper`
  reclaims the stale `in_progress` claim after 65 minutes, matching the observed rerun
  cadence.
- The next `shipwright-dev-task` cron tick dispatches the reclaimed task via
  `cronDeps.runner(message, undefined, ...)` (`agent/src/index.ts:224-228`) — `sessionKey`
  is hardcoded `undefined` for cron dispatch, so `_runClaude`'s resume-retry gate (gated on
  `existingSessionId`) is structurally dead code for this path regardless of whether any
  external resume succeeds or fails. Every cron-dispatched dev-task session is
  unconditionally fresh, with zero memory of prior progress.

Not destructive (task-store's claim/dedup logic prevented duplicate PRs) but a
throughput/cost problem — several sessions burned per task, mostly on re-bootstrap, before
one gets enough uniniterrupted runway to finish.

## Design

Two complementary layers:

**1. Runtime fix (the structural fix).** Give cron-dispatched **dev-task only** a real
session identity and let the runtime resume it immediately when a dispatch ends with the
task still `in_progress`, instead of waiting on the 65-minute reaper + next cron tick.
Review/patch/deploy/plan keep dispatching fresh every time (deliberate — those phases are
expected to re-validate live state on every repeat dispatch, not continue stale context).

- `agent/src/claude.ts`: `_runClaude`'s resume-retry gate currently only fires when
  `existingSessionId` was already present at the start of the call (i.e. already a resume
  attempt). Widen it to retry using any known session id — including one captured
  mid-attempt via the stream's `system`/`init` line (`earlySessionId`, already threaded onto
  every result/error type) — even when the original call was fresh. Split
  `ClaudeTimeoutError` handling: allow retry for `reason: "ceiling"` (confirmed via Sentry,
  ~67 occurrences over ~2 months, ~1/day — the expected "ran out of the hard wall-clock cap
  while still legitimately working" case), keep excluding `reason: "idle"` (zero observed
  occurrences, but it's specifically the genuine-hang signal — kept as a safety rail even
  though it isn't currently load-bearing).
- `agent/src/index.ts` + `agent/src/loop-orchestrator.ts`: give dev-task cron dispatch a
  real `sessionKey` (`dev-task:{taskId}`) instead of the hardcoded `undefined`. After a
  dev-task dispatch completes, check the task's live status; if still `in_progress`, resume
  immediately with `-r <captured-session-id>` rather than returning to the drain loop and
  waiting on the reaper. Capped at 3 auto-resumes per dispatch, each its own `AgentCronRun`
  row (same `itemId`) — this both avoids an unbounded loop on a persistently-broken task and
  gives the observability trail for free (cost already sums correctly across rows the same
  way multiple legitimate dispatches of one task already do today).
- `agent/src/cron-run-reporter.ts`: add `recordSessionId(cronId, runId, sessionId)`,
  mirroring the existing `recordProgress`'s fire-and-forget partial-PATCH pattern. No
  schema or admin-route change needed — `AgentCronRun.sessionId` and
  `admin/src/agent-cron-runs.ts`'s `patch()` already support a bare `{sessionId}` partial
  update. Wire it to the new early-session-id capture so the cron-run log has the session id
  as soon as it's known, not just at completion — useful for manual inspection/resume even
  if a run never reaches a terminal state.

**2. Guardrail fix (defense-in-depth, cost optimization).** Strengthen `dev-task.md`'s
Step 8/9b.2 guardrail (already added after the August CVF-1.1/AGH-1.1 incident, still being
ignored) with the actual mechanical reason — ScheduleWakeup ends the process, which stops
the claim heartbeat, which triggers the 65-minute reclaim — instead of just asserting the
rule. `Monitor` stays a legitimate sanctioned in-session polling option; its earlier
"requires approval" failure was traced to a missing `AgentTool` grant, not a
headless-incompatibility (confirmed by live test after the grant was added), so it's not
being pulled from the guardrail's escape hatch.

**3. Monitor availability.** Add `Monitor` to the `coding` agent type's default
`tools[]` (`agent-types/coding/manifest.yaml`) so new coding agents get it seeded
automatically going forward. Considered adding it to `FLOOR_TOOLS` instead (always granted,
non-revocable) but rejected: `Monitor`'s `command` field runs arbitrary shell commands
(same capability as `Bash`) and its `ws` mode opens arbitrary outbound connections (same
capability as `WebFetch`) — floor-including it would silently bypass the exact
capability-narrowing that keeping Bash/WebFetch/WebSearch/Agent out of the floor was
designed to enforce for any operator running a deliberately restricted agent.

## Decision Log

- Session-resume wiring scoped to dev-task only, not review/patch/deploy/plan (explicit
  product decision — those phases are meant to repeat with fresh context).
- Retry `ClaudeTimeoutError` only for `reason: "ceiling"`, not `"idle"` — informed by Sentry
  data (see above), not a default guess.
- Retry cap: 3 auto-resumes per dispatch.
- `Monitor` added via the agent-type manifest's default tools, not `FLOOR_TOOLS` — security
  tradeoff, not a default.
- Considered and explicitly rejected: scoping Step 8's local validation to changed packages
  (reusing the Coverage Gate's detection pattern). Real tradeoff (transitive/cross-package
  blind spots in a bun-workspace monorepo) but the deciding factor was genericity —
  `dev-task.md` ships as one prompt to every repo Shipwright targets, and a scoping
  heuristic tuned to this repo's dependency graph isn't a safe universal default. Left for a
  future per-repo `.claude/shipwright/` override if ever needed, not the core plugin.

## Tasks

| ID | Title | Deps | Layer | Hours | Complexity | Model |
|---|---|---|---|---|---|---|
| SWD-1.1 | Strengthen dev-task.md's Step 8/9b.2 guardrail with the actual mechanism | — | Shared | 1 | 1 | haiku |
| SWD-1.2 | Widen `_runClaude`'s retry gate + early session-id capture callback | — | Background | 4 | 4 | sonnet |
| SWD-1.3 | Dev-task-only resume wiring + early session-id cron-log push | SWD-1.2 | Background | 6 | 5 | opus |
| SWD-1.4 | Add Monitor to the coding agent type's default tools | — | Shared | 0.5 | 1 | haiku |

All four are additive — no renames/removals/constraint changes. Safe to deploy standalone.
