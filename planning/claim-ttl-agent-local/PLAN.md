# Plan: claim-ttl-agent-local

Repo: app-vitals/shipwright. Unblocks app-vitals/agent PCD-2.1.

## Design
`agent/` shipped importing `@app-vitals/agent-lib/claim-ttl` in `src/coding/pr-state-reconciler.ts` (+ unit test) and uses it as a fixture specifier in `scripts/check-lib-resolution.unit.test.ts`. CET-1.2 localized claim-ttl in `task-store/` and `admin/` but missed `agent/`. `agent/` is a separate workspace with no cross-workspace imports, so add a small local `agent/src/coding/claim-ttl.ts` (CLAIM_TTL_BUFFER_MS, DEFAULT_CLAIM_TTL_MS; still imports `claude-timeout` from agent-lib, which stays in the platform), switch importers, extend the CET-1.2 pin guard to `agent/`, and repoint comment/doc references.

## Tasks
| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| CTL-1.1 | none | PCD-2.1 (app-vitals/agent) | |

Safe to deploy standalone: yes (additive; agent-lib keeps exporting claim-ttl until PCD-2.1).

## After deploy
Add CTL-1.1 to PCD-2.1 dependencies (already done at queue time), then `POST /tasks/PCD-2.1/unblock`.

## Decision Log
- Sharing mechanism: defaulted to local copy in agent/ — no existing cross-workspace imports and the agent image ships separately.
