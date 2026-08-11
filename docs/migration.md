# Migration Guide

Durable notes for breaking changes and the steps needed to migrate across versions.

---

## New: `TaskService.list()` multi-repo/org filters and distinct `orgs` field

**Version**: next (ORF-1.2)

`TaskService.list()` now accepts `repo` as `string | string[]` and a new `org: string | string[]`
filter (repo prefix match, e.g. `"app-vitals"` matches any `repo` starting with `"app-vitals/"`).
`TaskService.distinct()` now also returns a third field, `orgs: string[]` — the distinct
organization prefixes extracted from the `repos` it already returns.

- **`GET /tasks` HTTP route** — now accepts repeatable `?repo=` and `?org=` query params. `?repo=` can be passed multiple times (e.g. `?repo=org/a&repo=org/b`) to match any repo in the list; a single `?repo=` behaves identically to before (exact match). `?org=` matches any repo whose `org/repo` string starts with the given org prefix (e.g. `?org=app-vitals`), and is also repeatable. Both filters combine via AND intersection when supplied together.
- **`GET /tasks/distinct`** — now returns a third field `orgs: string[]`, containing the distinct organization prefixes extracted from all visible `repo` values (the `org` part of each `org/repo`). This field is live over HTTP, since the route passes `TaskService.distinct()`'s result straight through.

**For API callers**: `GET /tasks/distinct` responses gain a new `orgs` field — safe to ignore if your UI doesn't need it. `GET /tasks` now accepts repeatable `?repo=` and `?org=` query params, expanding filtering beyond single-repository queries.

**For TaskService implementations**: The `distinct()` method's return type has changed from `{ sessions: string[]; repos: string[] }` to `{ sessions: string[]; repos: string[]; orgs: string[] }`. If you override `distinct()`, update your implementation to compute and return the `orgs` array (extract unique organization prefixes from the `repos` array). The `list()` filters type gained `repo?: string | string[]` (single string keeps the old exact-match shape) and `org?: string | string[]`.

---

## Breaking: `dev-task`/`review`/`patch`/`deploy` require `shipwright-loop` (or an explicit target)

**Version**: next (WLS-6.1)

`dev-task`, `review`, `patch`, and `deploy` no longer self-discover work. Each is now an
explicit-target-only executor: `dev-task` requires a task id, and `review`/`patch`/`deploy`
require an `org/repo#number` PR. Candidate selection — deciding *what* to work on — now
happens exclusively upstream, in the `shipwright-loop` cron's in-process candidate
providers (`agent/src/check-dev-task.ts`, `check-review.ts`, `check-patch.ts`,
`check-deploy.ts`), which merge candidates and dispatch the winning item's command with its
id/PR embedded directly in the prompt. No self-search fallback remains inside any of the
four commands.

**Impact**: any agent running `shipwright-dev-task`, `shipwright-review`, or
`shipwright-patch` as **standalone crons** (i.e. without `shipwright-loop` enabled) will see
those crons go silently inert. Their stored prompt (e.g. `/shipwright:dev-task`) carries no
target, so the command responds `[silent]` and exits immediately on every tick — no error,
no Slack message, no work done.

**What to update**: enable the `shipwright-loop` system cron (`PATCH
/agents/:id/crons/:cronId` with `{"enabled": true}`, or via the admin UI). `dev-task`,
`review`, and `patch` are enabled by default, so once the loop is on, they resume working
automatically. `shipwright-deploy` remains an explicit opt-in — its per-phase cron ships
`enabled: false`, so toggle it on separately if you also want deploys driven by the loop.

---

## Upgrading to chart 1.6.132

Remove `metrics.provider.posthog.*` from your `values.yaml` before running `helm upgrade`. The `posthog` key is no longer accepted by the values schema — with `additionalProperties: false` still in place, Helm will reject the upgrade with a schema validation error if any `metrics.provider.posthog.*` keys remain.

```yaml
# Before (remove these lines)
metrics:
  provider:
    posthog:
      apiKey: "..."
      host: "..."
```

No replacement value is needed — the metrics service now auto-detects the provider.

---

## New: `GET /tasks/distinct` endpoint for filter autocomplete

**Version**: next (feat/afa-task-filter-autocomplete)

A new endpoint returns distinct non-null `session` and `repo` values across tasks, limited to the top 100 of each. This powers filter autocomplete in the UI:

```json
{
  "sessions": ["session-name-1", "session-name-2"],
  "repos": ["org/repo-1", "org/repo-2"]
}
```

Agent tokens are scoped to their own assigned tasks; admin tokens see all. Returns `200` with empty arrays if no tasks exist.

**What to update:**
- UI/client code implementing filter autocomplete can now call `GET /tasks/distinct` instead of fetching all tasks and computing distinct values client-side.
- The endpoint is backward compatible — existing code continues to work without changes.

---

## Breaking: `PullRequest.hitl`/`hitlNotifiedAt` and `Task.hitlNotifiedAt` columns dropped

**Version**: next (HSR-1.1)

The single overloaded `hitl` signal on `PullRequest` is split into two distinct signals, and
the dead `hitlNotifiedAt` fields are removed:

- **Removed**: `PullRequest.hitl`, `PullRequest.hitlNotifiedAt`, `Task.hitlNotifiedAt`.
- **Added**: `PullRequest.blocked` (Boolean, default `false`) — replaces `PullRequest.hitl` as
  the PR-level pipeline-block signal; `PullRequest.blockedReason` is unchanged.

A data migration accompanying this change clears `Task.hitl` on records that were actually
pipeline-escalation/spin-detection rather than genuine Type A infra tasks (moving still-open
ones to `Task.status = 'blocked'`), and carries forward open PRs' `hitl: true` into
`PullRequest.blocked: true` before dropping the old columns.

**Silent-drop behavior on `PATCH /prs/:id`**: `hitl` and `hitlNotifiedAt` are removed from
`PATCH_ALLOWED_FIELDS` and replaced with `blocked`. Because this repo assumes rolling
deployments, a stale client still running pre-migration code that PATCHes `hitl` or
`hitlNotifiedAt` in its request body will have those fields **silently stripped, not
rejected** — no error surfaces, the write is just a no-op on those fields specifically (any
other fields in the same PATCH still apply normally).

**What to update:**
- Any code/client PATCHing `PullRequest.hitl`/`hitlNotifiedAt` directly should migrate to
  `PullRequest.blocked`.
- Any code reading `Task.hitlNotifiedAt` should be removed — it was dead and has no
  replacement.

---

## `GET /tasks` and `GET /tasks/:id` response shape change

**Version**: next (feat/task-filters, feat/ts-api-blocked-by)

`GET /tasks` previously returned a bare `Task[]`. It now returns an envelope:

```json
{ "tasks": Task[], "total": number, "limit": number, "offset": number }
```

Each `Task` in the response now includes a `blockedBy` array describing why the task is not yet ready:

```json
{
  "tasks": [
    {
      "id": "task-1",
      "status": "pending",
      ...
      "blockedBy": [
        { "type": "hitl" },
        { "type": "dependency", "id": "dep-1", "status": "in_progress" }
      ]
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

`BlockedByEntry` is one of:
- `{ type: "hitl" }` — the task has `hitl: true`; it is never considered ready, regardless of `hitlNotifiedAt`
- `{ type: "blocked"; reason: string | null }` — the task is at `status: "blocked"`; `reason` carries `task.blockedReason` (or `null` when none was recorded)
- `{ type: "dependency"; id: string; status: string }` — a dependency task is not satisfied (see dependency satisfaction rules in `docs/task-store.md`)

These gates are independent and accumulate — e.g. a `status: "blocked"` task can also carry an `hitl` entry and/or unsatisfied-dependency entries in the same array.

When `blockedBy` is empty, the task is ready to execute (assuming it has `status: pending`).

**What to update:**
- Any code that calls `GET /tasks` and expects an array must unwrap `.tasks` from the response.
- `check-helpers.ts` in the plugin is updated in this PR. Agent in-process code can import shared helpers directly from `agent/src/check-helpers.ts` (a ported native copy); custom plugin scripts still depend on the plugin version.
- Code that checks task readiness should use the `blockedBy` array instead of duplicating dependency logic.
- `GET /tasks?ready=true` is unchanged — it still returns `Task[]` (filtered to ready tasks only, with `blockedBy` also present).

---

## Repo-scoped task visibility for agent tokens

**Version**: next (feat/rbv-2-1-repo-scoped-visibility)

Agent tokens (as opposed to admin tokens) can now have a scoped list of repositories associated with them. When a scope is present, the task-store API enforces repo-scoped visibility:

- **Pool tasks (unassigned)** are now visible to agents whose repos include the task's `repo` field. Previously, unassigned pool tasks were only visible to admin tokens.
- **Task ownership** for individual task operations (`GET /tasks/:id`, `PATCH /tasks/:id`, `DELETE /tasks/:id`) now includes pool tasks in scope — an agent can access an unassigned pool task if the task's repo is in the agent's scope.
- **`GET /tasks?ready=true`** now passes the agent's scoped repos to `listReady()`, allowing agents to see ready pool tasks in their scope.
- **`GET /tasks?repo=X`** list queries now use an `agentScope` filter that includes both assigned tasks and repo-scoped pool tasks (OR union), instead of a simple `assignee` match.

**Configuration**: When the task-store is deployed with `SHIPWRIGHT_TASK_STORE_AGENTS_URL` and `SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY`, the scope resolver fetches each agent's `repos` from the agents service and applies these rules. Without both env vars set, the scope resolver is disabled and agent tokens behave as before (no pool task visibility).

**For API callers**: If you are calling task-store endpoints directly with agent tokens:
- **Pool task visibility changes**: You may now see unassigned tasks with `repo` values that match your agent's scope.
- **No action required**: The changes are additive; existing assigned-task queries behave identically. Only the visibility of pool tasks expands.

**For implementers of `TaskService.listReady()`**: The method signature has changed from `listReady(agentId?: string)` to `listReady(agentId?: string, repos?: string[], filters?: TaskListPostFilters)`. Implementations that override `listReady()` must update to accept the `repos` parameter and apply the same filtering rule: include unassigned pool tasks whose `repo` is in the `repos` list. When `filters` is supplied, apply its `session`, `source`, `repo`, `org`, `claimedBy`, `pr`, `branch`, and `assignee` fields as post-filters after dependency resolution (never folded into the initial query, since a filtered-out task can still satisfy a dependency edge for an in-scope task).

---

## `AgentProvisioner.reconcile()` interface change _(v4.29.0)_

- **`reconcile(agentIds: string[])` → `reconcile(agents: Array<{ id: string; slug?: string }>)`**: The `AgentProvisioner` interface's `reconcile()` method now accepts structured agent objects instead of raw ID strings. This is a **compile-time breaking change** for any code that implements or calls `AgentProvisioner` directly.

  **Why**: The new `slug` field enables PVC name templates to use a human-readable agent slug instead of the raw agent ID, supporting custom PVC naming conventions (e.g. per-client storage naming).

  **Migration**: callers passing a `string[]` must change to `agents.map(id => ({ id }))`. The `slug` field is optional — existing callers that do not need custom PVC naming can omit it.

  ```ts
  // Before
  await provisioner.reconcile(["agent-id-1", "agent-id-2"]);

  // After
  await provisioner.reconcile([{ id: "agent-id-1" }, { id: "agent-id-2" }]);

  // With optional slug for custom PVC naming
  await provisioner.reconcile([{ id: "agent-id-1", slug: "my-agent" }]);
  ```

- **`ReconcileResult` now includes `updated: string[]` field**: In v4.30.0, the return type of `reconcile()` was extended to include a new `updated` field tracking agent IDs whose Deployments were already running but had stale images that were patched to the current version. This is **backward compatible** — code that only reads `recreated` and `orphans` fields will continue to work. The complete return shape is now:

  ```ts
  {
    recreated: string[];      // Deployments that were missing and re-provisioned
    updated: string[];        // Deployments that were patched with the current image
    orphans: string[];        // Deployments with no matching agent ID
    failed: Array<{ agentId: string; error: string }>  // Operations that failed
  }
  ```

---

## `Task.requiresHumanApproval` field removed _(RHA-1)_

**Version**: next (RHA-1)

The `Task.requiresHumanApproval` field has been removed entirely from the database schema and API layer. The field was no longer consulted by any workflow; the deploy command's merge-approval logic has been simplified to a single unconditional path — human approval is no longer gated at the task level.

**What changed**:
- The `deploy` command no longer reads `Task.requiresHumanApproval` when evaluating PR approval.
- The `plan-session` command no longer classifies tasks as "Type B" (requiring merge approval) — it only recognizes Type A (human-executable tasks with `hitl: true`) and neither (standard tasks).
- The deploy workflow's Step 3a no longer branches on `requiresHumanApproval: true` — it proceeds directly to the self-review approval fallback path when GitHub's review decision is not APPROVED.
- In RHA-1.4, the column was dropped from the Prisma schema and the database via migration `20260811000000_drop_requires_human_approval`. The filter parameter was removed from the task-store API in RHA-1.3.

**Migration**:
- **For existing tasks**: No action required. The field is gone and has no replacement.
- **For API consumers**: Remove any code that filters by `?requiresHumanApproval=` or writes to this field. Attempts to set it via `PATCH /tasks/:id` will be silently ignored (the field no longer exists in the schema).
- **For code reading the field**: All references have been removed. The field is purely historical and has been completely eliminated from the system.

