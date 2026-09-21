# Plan: agent-tool-background-dispatch-fix

Repo: `app-vitals/shipwright`

## Problem

Several `plugins/shipwright/commands/*.md` prompts dispatch a fix/implementation subagent
via the Agent tool ("Dispatch a `general-purpose` subagent via the Agent tool, ...") without
pinning `run_in_background: false`. The Agent tool's own default is background dispatch.

When the dispatching command is running as a one-shot cron `claude -p` invocation (not an
interactive session), and the top-level turn ends — e.g. the model reasons "I'll be notified
automatically when the subagent completes, no need to poll" — the parent process exits
immediately. There is no live session left to receive the subagent's completion notification
or continue the work, so a background-dispatched subagent that is still mid-flight at that
point is orphaned: any commits/pushes it was about to make never happen, and the cron run
still reports `outcome: completed` because the *turn* completed normally, even though the
dispatched work did not finish.

Confirmed live twice on `patch`, on a separate Shipwright deployment (`ok-wow/ok-wow`):

- PR #2293 — a fix subagent wrote and verified a real regression test, but its transcript
  stopped before `git add`/`commit`/`push`; the parent session had already reasoned its way
  into a passive wait and exited.
- PR #2311 — the fix subagent got one step further (committed locally, `57743fcfd`) but
  never pushed; the worktree was also left in detached HEAD with unrelated dirty files, a
  related but distinct issue (see `[[project_shipwright_worktree_detached_head_stale_branch_push]]`
  in this agent's own memory — not addressed by this plan).

The same underlying mechanism — background `Agent` dispatch from a one-shot `claude -p`
turn — was also the confirmed root cause of a 2+ week silent outage in the
`shipwright-test-readiness` cron (2026-09-02 through 2026-09-17), independently diagnosed
before this incident. This plan is the first time the fix is being applied broadly across
the command prompts that share the vulnerable pattern, rather than one incident at a time.

This is a different bug from `dev-task-scheduledwakeup-fix` (DTW-1.1..1.4, shipped
2026-09-18): that one was about `ScheduleWakeup` mid-Step-8 causing the task-store's
`StaleClaimReaper` to reclaim a stale claim and re-bootstrap the task from scratch. This one
is about the Agent tool's own `run_in_background` default causing silent work loss at any
subagent dispatch site, independent of `ScheduleWakeup`.

## Design

Audited every `Dispatch ... subagent via the Agent tool` site across `patch.md`, `dev-task.md`,
`review.md`, and `deploy.md`:

- **`patch.md`** — 3 sites (Step 4b conflict resolution, Step 5b fix subagent, Step 6c
  CI-fix), none pin `run_in_background`.
- **`dev-task.md`** — 4 sites (Step 5b implementation subagent — highest risk, this is the
  one that commits code — Step 6.5 spec compliance, Step 8.5a docs-refresher, Step 9b.3
  CI-fix), plus a nested case: Step 5b's own subagent prompt text separately instructs *that*
  subagent to spawn `shipwright:researcher` via the Agent tool, the same risk one level down.
  None pin `run_in_background`.
- **`review.md`** — Step 7 already does this correctly via prose ("This call is synchronous
  and blocking ... do not schedule a wakeup or background monitor for this dispatch") but
  never passes the literal `run_in_background: false` parameter — grepped, that string
  appears nowhere in `commands/`. Not a live bug; tightened here for defense-in-depth so the
  behavior doesn't depend solely on the dispatching model reading and honoring the prose.
- **`deploy.md`** — dispatches no subagents via the Agent tool. Not in scope.

Fix: add an explicit `run_in_background: false` to every dispatch instruction identified
above. This is the minimal, targeted fix — no change to prompt content beyond the one
parameter, no restructuring of the surrounding steps.

Separately, `agent/workspace/CLAUDE.md.template` — the template rendered into every deployed
agent's workspace `CLAUDE.md` — has a "Waiting and Polling" section that thoroughly covers
`ScheduleWakeup` and Bash blocking-wait patterns, but never mentions the Agent tool's own
background-default trap. Add a short warning there: for any cron-dispatched (non-interactive)
subagent work where the parent turn needs the result before it ends, pass
`run_in_background: false` — the Agent tool's default assumes a live session to receive its
completion notification, which a one-shot `claude -p` invocation does not have once the turn
ends.

## Decision Log

- Scoped to the 4 files actually containing "Dispatch ... via the Agent tool" instructions
  (`patch.md`, `dev-task.md`, `review.md`, `CLAUDE.md.template`) — `deploy.md` was audited
  and confirmed to dispatch no subagents, so it is explicitly out of scope rather than
  silently skipped.
- `review.md`'s fix is included even though it is not a live bug — the prose-only guidance
  is a weaker guarantee than the literal parameter, and the fix is nearly free.
- The `ok-wow/ok-wow` PR #2311 detached-HEAD/dirty-worktree issue is explicitly NOT addressed
  by this plan — it is a separate, already-memoried issue
  (`[[project_shipwright_worktree_detached_head_stale_branch_push]]`) with its own fix
  direction (force a real branch checkout instead of detached HEAD in the worktree-setup
  steps), out of scope here.

## Tasks

| ID | Title | Deps | Layer | Hours | Complexity | Model |
|---|---|---|---|---|---|---|
| ABD-1.1 | Pin run_in_background:false on patch.md's 3 subagent dispatch sites | — | Shared | 1 | 2 | haiku |
| ABD-1.2 | Pin run_in_background:false on dev-task.md's 4 subagent dispatch sites + nested researcher spawn | — | Shared | 1 | 2 | haiku |
| ABD-1.3 | Pin explicit run_in_background:false on review.md's Step 7 dispatch | — | Shared | 0.5 | 2 | haiku |
| ABD-1.4 | Add Agent-tool background-dispatch warning to CLAUDE.md.template's Waiting and Polling section | — | Shared | 0.5 | 2 | haiku |

All four are additive — no renames/removals/constraint changes. Safe to deploy standalone.
