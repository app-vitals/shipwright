# Migration Guide

Durable notes for breaking changes and the steps needed to migrate across versions.

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
- `{ type: "hitl" }` — the task has `hitl: true` and `hitlNotifiedAt` is null (awaiting human confirmation)
- `{ type: "hitl", notified: true }` — notification was already sent (`hitlNotifiedAt` is set); the task is still excluded from `?ready=true` but no agent-actionable block remains
- `{ type: "dependency"; id: string; status: string }` — a dependency task is not satisfied (see dependency satisfaction rules in `docs/task-store.md`)

When `blockedBy` is empty, the task is ready to execute (assuming it has `status: pending`).

**What to update:**
- Any code that calls `GET /tasks` and expects an array must unwrap `.tasks` from the response.
- `check-helpers.ts` in the plugin is updated in this PR. Custom scripts or agents calling `/tasks` directly need the same fix.
- Code that checks task readiness should use the `blockedBy` array instead of duplicating dependency logic.
- `GET /tasks?ready=true` is unchanged — it still returns `Task[]` (filtered to ready tasks only, with `blockedBy` also present).

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
