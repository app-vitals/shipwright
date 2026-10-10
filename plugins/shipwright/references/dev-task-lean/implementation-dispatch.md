# Implementation dispatch (Step 5)

Moved from `commands/dev-task.md`.

## Resolving the subagent type
```bash
DEV_TASK_SUBAGENT_TYPE=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -r '.phaseMethodology["dev-task"] // "general-purpose"')
DEV_TASK_SUBAGENT_TYPE=${DEV_TASK_SUBAGENT_TYPE:-general-purpose}
```
Bracket notation is required (hyphenated key). Fail closed to `general-purpose`. Any compliant subagent follows
`methodology-contracts/dev-task.md`; Steps 6–10 are not swappable. Set `EFFECTIVE_MODEL = task.model ?? 'sonnet'`
at dispatch; Step 10 writes it back as `model`.

## Subagent brief
Working dir = worktree; no new branch; conventional commits. Include the Step 3 implementation brief,
CLAUDE.md contents, and toolchain (test, test layers, validate, typecheck). Instructions: [A] discover and spawn
`shipwright:researcher`; [B] plan minimal architecture; [C] RED: write failing tests first (Expected Tests verbatim,
must fail); [D] GREEN: minimal code, all tests pass; [E] refactor green; [F] run validation and record each outcome
(`ran_passed|ran_failed|skipped|timed_out`) per `pre-ship-checks.md`. Report `STATUS` / `CONCERNS` / `BLOCKER`.

## Status handling
- DONE → continue. DONE_WITH_CONCERNS → fix correctness/scope gaps, note observations.
- NEEDS_CONTEXT → re-dispatch with the answer.
- BLOCKED → upgrade the model once (haiku → sonnet → opus) with the blocker appended. Still blocked or already opus →
  supply context / split / escalate; true dead end → PATCH `{"status":"blocked","blockedReason":"implementation_blocked_after_model_escalation"}`, stop.
- Failed dispatch or no parseable STATUS: retry once. Still failing: with the built-in type, treat as BLOCKED; with a
  configured override, dispatch `general-purpose` with the same prompt (retry it once too), print a fallback note, and
  only then enter the BLOCKED ladder. Always end with a parsed response before Step 6.

## Heartbeat
`POST /tasks/{id}/heartbeat` before dispatch and after completion; implementation is the longest step and can
threaten the 65-minute claim TTL.
