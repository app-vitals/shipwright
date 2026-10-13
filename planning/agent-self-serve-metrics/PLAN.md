# Plan: agent self-serve metrics

Session: `agent-self-serve-metrics` · Repo: `app-vitals/shipwright`

Source: Dan, in conversation with the agent (2026-10-13), following up on a dev-task-adherence
bug fix for DTA-2.3. Dan: "agents can't check their own numbers. you have to be an admin. i
like that an admin can see everything, but i also want to be able to ask an agent."

## Goal

Let an individual agent query its own metrics — dev-task adherence, chat-token daily stats,
cron-run token stats, cron-run outcomes — using its own `SHIPWRIGHT_AGENT_API_KEY`, without
needing an admin key. Admin-wide (fleet) access is unchanged and stays admin-only.

## Evidence (from investigation, not guesses)

All four aggregate endpoints are admin-only today, gated by an explicit `isAdmin` check in the
handler:

- `GET /agents/all/cron-runs/stats` → `agentCronRunStatsService.query()` (`admin/src/agent-cron-run-stats.ts:329`)
- `GET /agents/all/cron-runs/outcomes` → `agentCronRunStatsService.outcomes()` (`:448`)
- `GET /agents/all/cron-runs/dev-task-adherence` → `devTaskAdherenceService.report()` (`admin/src/dev-task-adherence.ts:296`)
- `GET /agents/chat-tokens/daily/stats` → `agentChatTokenService.queryStats()` (`admin/src/agent-chat-tokens.ts:141`)

Each handler (`admin/src/agents-api.ts:1988-2038`) does `if (c.get("isAdmin") !== true) throw new
ForbiddenError(...)`, and none of the four service methods accept an `agentId` filter — there is
no way to narrow them even by request shape today.

An agent is **not** entirely blind, though: `GET /agents/{id}/crons/{cronId}/runs`
(`admin/src/agents-api.ts:701-718`) has no admin check at all — it relies purely on the generic
auth middleware (`admin/src/api-auth.ts:207-213`), which enforces that a per-agent bearer token's
`agentId` matches the `:id` in the path. `GET /agents/{id}/config` (`admin/src/api.ts`) uses the
exact same scoping and is the clean precedent for "self, never others."

`AgentCronRun.agentId` is denormalized directly on every row (`admin/prisma/schema.prisma:286`,
"denormalized from cron.agentId for efficient queries") — every one of the four services can
filter on it without a join or schema change.

## Design

**Approach:** add a parallel `GET /agents/:id/...` route for each of the four endpoints, reusing
`/config`'s auth pattern — no explicit `isAdmin` check needed in the new handlers, since the
generic `createAdminAuthMiddleware` already enforces agentId-match for per-agent bearer tokens
(and still lets admin/session callers through unchanged). Each service method gains an optional
`agentId` param: present → filter to that agent only; omitted → unchanged fleet-wide behavior
(the existing admin routes keep calling the same methods with no `agentId`).

**Route registration order.** The existing static segments (`/agents/all/...`,
`/agents/chat-tokens/...`) are registered before any `/:id` route specifically "to prevent the
literal 'all' being matched as an agentId" (comments at `agents-api.ts:1986-1987, 2024-2025`).
The four new `/:id` routes must stay registered *after* those static routes, never before.

**Complexity split — why four tasks, not one.** `devTaskAdherenceService.report()` (Prisma
`findMany`) and `agentChatTokenService.queryStats()` (Prisma `groupBy`) each take a one-line
`where: { agentId }` addition. `agentCronRunStatsService.query()` and `.outcomes()` are raw SQL
with four independent `SELECT` blocks apiece — each block needs its own `WHERE`/`AND
r."agentId" = $x` fragment. Splitting keeps the low-risk Prisma-filter tasks shippable
immediately and isolates the fiddlier multi-block SQL work.

**Testing.** Each task adds an integration test (real Postgres) seeding rows for two different
agents and asserting the self-scoped route returns only the caller's own agent's rows — this is
an auth-scoping behavior that a unit test with mocked data can't actually prove end-to-end. No
existing test is retired; this is new coverage for new routes.

**No breaking change.** Every change is additive: a new optional service param that defaults to
current fleet-wide behavior, and new routes. Safe to deploy standalone.

## Tasks

| ID | Task | Layer | Hours | Complexity | Model | Depends on |
|---|---|---|---|---|---|---|
| SSM-1.1 | Self-serve dev-task-adherence route scoped to the caller's own agent | API | 2 | 2 | haiku | none |
| SSM-1.2 | Self-serve chat-token daily stats route scoped to the caller's own agent | API | 2 | 2 | haiku | none |
| SSM-1.3 | Self-serve cron-run token stats route scoped to the caller's own agent | API | 4 | 3 | sonnet | none |
| SSM-1.4 | Self-serve cron-run outcomes route scoped to the caller's own agent | API | 4 | 3 | sonnet | none |

All four are independent — different files, different branches, no bundling.

## Breaking Change Safety

All four: additive optional param + additive route. Safe to deploy standalone: yes for every task.

## HITL

None. Pure code change, no infra/secrets/`.claude/**` touch.
