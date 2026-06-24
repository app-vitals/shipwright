# Migration Guide

Durable notes for breaking changes and the steps needed to migrate across versions.

---

## `GET /tasks` response shape change

**Version**: next (feat/task-filters)

`GET /tasks` previously returned a bare `Task[]`. It now returns an envelope:

```json
{ "tasks": Task[], "total": number, "limit": number, "offset": number }
```

**What to update:**
- Any code that calls `GET /tasks` and expects an array must unwrap `.tasks` from the response.
- `check-helpers.ts` in the plugin is updated in this PR. Custom scripts or agents calling `/tasks` directly need the same fix.
- `GET /tasks?ready=true` is unchanged — it still returns `Task[]`.

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
