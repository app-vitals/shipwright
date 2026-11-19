# Plan: member-task-pr-visibility

## Pass 1 — 2026-11-19 — no spec file (verbal request from Dan)

### Goal
Agent members (non-admin `AgentMember`) get the same access to Tasks and PRs in the
admin app that their agents have in the task-store. Today `/admin/tasks*` and
`/admin/prs*` return 403 for them (`resolveTaskStoreView` → `kind: "none"`), even
though the nav shows the tabs.

### Access rule (mirrors task-store agent-token scope)
- Task visible iff `assignee ∈ member's agents` OR `repo ∈ those agents' repos[]`
  (task-store `agentScope`; note: assignee only, not `claimedBy`).
- PR visible iff `repo ∈ those agents' repos[]` (task-store PR scope).
- Member scope = union across all their agents (`resolveVisibilityScope`, as the sessions list does).
- Out-of-scope detail pages return 404 (existence not leaked). Zero memberships → 403.
- Read-only: quick-add / promote / release stay admin-only.

### Design
- **task-store** `/tasks`: add an admin-token-only multi-agent scope (assignee in agent ids OR repo in repos), generalising the single-agent `agentScope`. `/prs` already supports repeated `?repo=`, no change.
- **admin**: new member kind in `resolveTaskStoreView` (admin-ui-coding.ts) carrying `{agentIds, repos}`; `scopedTaskStore` passes it to the task-store; detail routes re-check visibility.
- Nav needs no change: agent-lib 1.73.0 `TOOLBAR_NAV_ITEMS` already hides Settings from members; Chat already filters by agent.

### Tasks
| Task | Repo | Depends on |
|---|---|---|
| MPV-1.1 task-store multi-agent scope on /tasks | app-vitals/shipwright | — |
| MPV-1.2 admin member view + Tasks scoping | app-vitals/shipwright | MPV-1.1 |
| MPV-1.3 admin PR scoping | app-vitals/shipwright | MPV-1.2 |

Safe to deploy standalone: yes (all additive; no renames/removals).

### Out of scope
- **Metrics.** With `METRICS_REQUIRE_OWNER_ROLE` unset in prod (vitals-os helm values; chart default false) and the metrics service using the unrestricted admin bearer, any signed-in member sees fleet-wide metrics via the Metrics tab, `/dashboard` and `/metrics/*`. Fix would be (a) drop `member` from the Metrics audiences in agent-lib `TOOLBAR_NAV_ITEMS` (app-vitals/agent + release gate + pin bump) and (b) 403 non-admin sessions in `metrics/src/api.ts`. Deferred by Dan on 2026-11-19.

## Decision Log
- Repo-overlap breadth: confirmed by Dan — same as sessions.
- Members read-only: confirmed — "same access their agents do".
- Pagination approach: decided in planning — scope server-side in task-store, not post-fetch filtering in admin.
