# Plan Session: cron-run-early-session-id

**Repo:** app-vitals/shipwright

## Problem

The streamed Claude session id is pushed onto an `AgentCronRun` row as soon as it's known —
off the CLI's leading `system`/`init` stream-json line, well before any terminal result —
via `onEarlySessionId` → `cronRunReporter.recordSessionId()`. This lets an operator find and
resume a session even if the run dies mid-flight.

Today this only fires for `shipwright-loop`-dispatched dev-task runs. Two independent gaps
cause this, both purely wiring — not a technical requirement:

1. `agent/src/cron-handler.ts` (the generic, non-loop cron path — entropy-scan, error-scan,
   security-scan, docs-freshness, etc.) has no `onEarlySessionId` concept at all. Its
   `ClaudeRunner` type is `(message, onProgress?, extraEnv?) => Promise<ClaudeRunResult>` —
   no trailing callback slot — and `index.ts`'s `cronDeps.runner` adapter calls the
   underlying full runner with only 5 positional args, silently dropping the 6th.

2. `agent/src/loop-orchestrator.ts`'s `runOneAttempt()` only constructs the
   `onEarlySessionId` callback when `sessionKey` is truthy. `sessionKey` and the early-id
   push are independent concerns at the `claude.ts` level (`_runClaude`'s
   `captureEarlySessionId` fires regardless of whether `sessionKey` is set — `sessionKey`
   only controls resume lookup/save), but the loop's wiring conflates them.

**Cross-session interaction:** `CRT-1.3` (`claim-retry-unification` session, PR #3602,
`pr_open` at plan time) generalizes the *resume* loop to review/patch/deploy by giving those
phases their own `sessionKey` (a per-dispatch nonce). Its actual diff was inspected (not just
its task description): after it merges, `sessionKey` is non-`undefined` for
dev-task/review/patch/deploy, and only `plan` remains `undefined`. Since the
`onEarlySessionId` gate is untouched by CRT-1.3, that means dev-task/review/patch/deploy
already get the early-id push for free once CRT-1.3 lands — the only phase still missing it,
via the loop, is `plan`.

## Design

1. **Generic cron path (`cron-handler.ts` / `index.ts`).** Widen `ClaudeRunner`'s type with
   an optional trailing `onEarlySessionId?: EarlySessionIdCallback`. In `handleCronRequest`,
   construct the same fire-and-forget callback shape the loop already uses
   (`(sid) => cronRunReporter.recordSessionId(jobId, runId, sid).catch(warn)`) and pass it to
   `runner(...)`. In `index.ts`'s `cronDeps.runner` adapter, forward it as the 6th positional
   arg instead of omitting it. This is the only phase-independent path — it applies to every
   system cron dispatched outside the loop.

2. **Loop path — close the `plan` gap.** In `loop-orchestrator.ts`'s `runOneAttempt()`,
   decouple `onEarlySessionId` construction from `sessionKey` truthiness — build and pass it
   unconditionally for every phase. Once CRT-1.3 has merged, this closes the one remaining
   gap (`plan`) without touching dev-task/review/patch/deploy's already-correct behavior.

## Decision Log

- CES-1.2 depends on CRT-1.3 (cross-session) rather than being sequenced independently: both
  touch the same `runOneAttempt()` lines, and CRT-1.3 was already `pr_open` at plan time —
  sequencing after it avoids a merge race and lets CES-1.2 build on the post-CRT-1.3 shape of
  `sessionKey` directly.

## Tasks

| Task    | Title                                                          | Depends on | Hours | Complexity | Model  |
|---------|-----------------------------------------------------------------|------------|-------|------------|--------|
| CES-1.1 | Add early-session-id push to the generic cron-handler path      | —          | 3     | 3          | sonnet |
| CES-1.2 | Push early session id for the loop's `plan` phase                | CRT-1.3    | 1.5   | 2          | haiku  |

No renames/removals, no constraint additions — both tasks are safe to deploy standalone.
No HITL findings.
