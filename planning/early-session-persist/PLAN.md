# Plan Session: early-session-persist

Repo: `app-vitals/shipwright`

## Problem

Claude session resumability is lost whenever the agent process itself is killed mid-run (OOM, pod restart, redeploy) — not just when the spawned `claude` CLI child is killed.

Root cause, confirmed by reading `agent/src/claude.ts` and `agent/src/loop-orchestrator.ts` and cross-checking against real okWOW agent cron-run data (task FTR-1.5, repo `ok-wow/ok-wow-ai`): in `claude.ts`'s `_runClaude`, the `captureEarlySessionId` callback (~line 847) learns the real Claude session id early — off the stream's leading `system`/`init` line — but only stashes it in a local variable (`capturedSessionId`) and relays it to the admin-API observability push. It is **not** written to the durable `sessions` key-value store (`sessions.set(sessionKey, sessionId)`) until after the spawned process settles, via `_saveSession` (success path) or `_saveSessionFromError` (failure path) in the surrounding try/catch. If the whole orchestrator process dies before that settle point, nothing was ever persisted under `sessionKey` — the next dispatch/message for that same item (dev-task item, PR phase, Slack thread, or chat-service conversation) starts a cold session with zero memory of prior progress.

The underlying Claude CLI session itself is already known to be durably resumable mid-run — the codebase already resumes from session ids captured via a thrown `ClaudeTimeoutError`/`ClaudeRunError` after the *child* process is killed (`_saveSessionFromError`), proving the CLI's own session file is incrementally durable, not just finalized on clean exit. The gap is entirely about whether *our* process survives long enough to write down which session to resume — not about whether the session itself is resumable.

**Evidence:** okWOW's dev-task cron-run history for task FTR-1.5 showed 3 dispatches ~1hr apart, 3 different session ids. Two of the three runs had `completedAt: null, outcome: null` in the admin API's cron-run record — orphaned, never closed out, consistent with the whole agent process dying mid-dispatch (not just the child being killed). The third got a clean `outcome: "failed", error: "Claude session timed out after 3600s (ceiling)"` — the orchestrator's own timer killing just the child process, which correctly persisted via `_saveSessionFromError`. The orphaned pair is the actual bug signature this task fixes.

**Explicitly out of scope:** the dev-task outer-loop resume gate (`loop-orchestrator.ts`'s `finally` block, `TERMINAL_DEV_TASK_STATUSES`) was separately investigated during this plan's discovery and confirmed working as intended — not to be touched here.

## Blast radius

`_runClaude`/`captureEarlySessionId` is the one shared choke point underneath every `createRunClaude(...)` instance in `index.ts` — there are exactly two call sites: the main `runner` (shared by Slack Bolt DM/mention threads AND all cron/loop-orchestrator phase dispatches, backed by `sessions.json`), and `chatRunner` (the HTTP chat-service poller, backed by `chat-sessions.json`). A fix here changes session-identity persistence timing for every agent's Slack conversations and chat-service conversations too, not just loop-cron dev-task work — but the change itself lives entirely in shared `claude.ts` code, not in any cron definition, so none of the "Shipwright Cron Changes" disabled-by-default rollout machinery applies.

## Design

**Business logic** — `agent/src/claude.ts`, `_runClaude`'s `captureEarlySessionId` callback (~line 847). Add a fire-and-forget `sessions.set(sessionKey, sessionId)` call there, guarded on `sessionKey` being defined, with the failure swallowed — matching the existing "best-effort persistence" pattern already used by `_saveSessionFromError`. `captureEarlySessionId` already has closure access to the same `sessions` instance via `createRunClaude(spawner, sessions, ...)`.

No API/Frontend/DB changes.

**Redundancy is fine** — `_saveSession`/`_saveSessionFromError` still write on settle as before; same key, same value, last-write-wins via `sessions.ts`'s per-key `enqueue()` write queue (already race-safe, confirmed by reading `sessions.ts` — no new serialization work needed).

**Test reasoning** — extend `claude.unit.test.ts`'s existing "session persistence on failure (CSI-1.2)" describe block, reusing its `drippingProc` fake-process pattern (emits one `system`/`init` line carrying a session id, then goes silent). New unit test: assert `sessions.set` is called immediately after that init line arrives, *before* the process ever settles (resolves, throws, or times out) — simulating the orchestrator process itself dying mid-run before any catch/finally executes. No existing tests are retired; the current CSI-1.2 tests only prove persistence happens by settle time, not before it — this closes that gap.

## Breaking Change Safety

No renames, removals, or constraint additions. Purely additive: writes the same value to the same key earlier than today. Safe to deploy standalone: yes.

## Task table

| Task | Title | Layer | Complexity | Model | Hours | Deps | HITL |
|---|---|---|---|---|---|---|---|
| ESP-1.1 | Persist Claude session id as soon as it's captured, not just on settle | Shared | 3 | sonnet | 2 | — | — |

### Dependency Map

```
[START]
  └─ ESP-1.1: Persist Claude session id as soon as it's captured, not just on settle (no deps)
```

```
Task     | Depends on | Blocks | HITL
ESP-1.1  | —          | —      |
```

## Decision Log

(No autonomous defaults applied — this plan was reviewed and approved interactively by Dan.)
