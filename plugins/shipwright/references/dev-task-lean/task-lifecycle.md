# Task lifecycle mechanics (Steps 1–2)

Moved from `commands/dev-task.md`. Auth header on all calls: `Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN`.

## Fetch
`curl -sf -H "$AUTH" "$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}"`. Task ids are global, not per-repo.

## PRD-shaped guard
Block when ANY holds: id matches `^prd-`; description opens with
`Commit as PRODUCT-SPEC.md and run /shipwright:plan-session`; `branch == "main"` with empty `acceptanceCriteria`.
`PATCH /tasks/{id}` `{"status":"blocked","hitl":true,"blockedReason":"misrouted_needs_plan_session_not_dev_task"}`; stop.

## Dependency check (pending only)
Satisfied when dep status ∈ {merged, done, deploying, deployed, cancelled}; or same-branch dep in
{pr_open, approved}; or `pr_open` dep whose PR GitHub reports merged. Otherwise emit
`[skip-reason:dev-task:deferred:dependency-unsatisfied:{dep-id}]` then `[silent]`, without claiming.
The tagged reason keeps the loop orchestrator from counting the defer toward `SKIP_BLOCK_THRESHOLD`.

## Missing branch
PATCH `{"status":"blocked"}` and print the PATCH command to set `branch` (`feat/{id-lowercase}`); stop.

## Same-branch sibling check
`GET /tasks?branch={branch}&status=in_progress&repo={repo}` (the `repo` filter is required: agent-scoped
tokens span several repos and an unscoped query can match a same-named branch elsewhere). Exclude own id.
A sibling is fresh if `heartbeatAt` (or, when null, `claimedAt`) is within 65 minutes (`DEFAULT_CLAIM_TTL_MS`
in `lib/claim-ttl.ts`). Any fresh sibling → `POST /tasks/{id}/release`, print the deferral, emit
`[skip-reason:dev-task:deferred:same-branch-sibling-busy:{branch}]` then `[silent]`. Stale siblings are
ignored; the Reality Check handles their abandoned branch.

## Toolchain detection
Compute the fingerprint and read `state/toolchain-cache/{repo-slug}.json` (see `toolchain-patterns.md`,
"Caching Across Runs"). Hit → reuse. Miss → docs-first discovery (CLAUDE.md, `docs/*.md`), then config-file
fallback. Store validate/test/tests/lint/`lintScoped`/typecheck/build; omit `lintScoped` rather than writing
`null`. Results go only to the cache, never into the project's docs.

## Claim
```bash
CLAIM_CODE=$(curl -s -o /tmp/task_claim.json -w '%{http_code}' -X POST -H "$AUTH" "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}/claim")
```
No body (the agent token pins `claimedBy`). Claim sets `claimedAt`/`heartbeatAt`/`startedAt` atomically.
