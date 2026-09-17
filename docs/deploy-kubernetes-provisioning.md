# Kubernetes Agent Runtime Provisioning Model

> How the admin service provisions agent workloads into Kubernetes when
> `agent.provisioning.enabled=true` — RBAC, ServiceAccounts, the provisioner
> env contract, provisioning values, chat-service token provisioning, and the
> task-store claim TTL constraint for a multi-agent fleet. Split out of
> [`deploy-kubernetes.md`](./deploy-kubernetes.md) to stay under the docs
> line-count threshold.

## Agent runtime provisioning model

By default the admin service runs in **Noop** mode: creating an agent
(via the admin console form at `/admin/agents/new`) or deleting one
(`DELETE /agents/:id`) only writes a database
row — no cluster access is required, and the chart renders no provisioning RBAC.
This is the safe default for any deployment that doesn't need the admin service
to spin up real agent workloads.

Setting `agent.provisioning.enabled=true` switches the admin service to the
**Kubernetes** provisioner. Then:

- Creating an agent creates a per-agent **PersistentVolumeClaim** (for persistent
  agent home storage), mints a scoped per-agent token, creates a per-agent
  **Secret** (carrying the token), and a per-agent **Deployment** (referencing
  both), in that order. All operations are idempotent and safe to retry. **Exception:** if the agent is marked `selfHosted: true`, provisioning is skipped — the agent is expected to manage its own workload.
- `DELETE /agents/:id` runs the full `deleteAgentFully()` orchestration:
  deprovisions the agent's Kubernetes workload (Deployment, Secret, and PVC),
  revokes the agent's task-store and chat-service tokens, deletes its chat
  threads, and deletes the agent database row (last step, only if all other
  steps succeeded). Every step is idempotent and safe to retry. Deleted agents
  do not leak persistent storage.

### What the chart renders when provisioning is enabled

- RBAC scope depends on `agent.provisioning.namespace`:
  - **Empty (default, same-namespace provisioning):** a namespace-scoped
    **`Role`** + **`RoleBinding`** named `<admin>-agent-provisioner`, granting
    `create`, `get`, `list`, `patch`, `update`, and `delete` on `Deployments`
    (`apps`) and `create`, `get`, `delete` on `Secrets` and
    `PersistentVolumeClaims` (core) — exactly the verbs the provisioner
    exercises, scoped to the release namespace (least privilege).
  - **Non-empty (cross-namespace provisioning):** a **`ClusterRole`** +
    **`ClusterRoleBinding`** with the same name and verb set, so the admin
    service can provision agents into a namespace other than its own release
    namespace.
  - Either way the binding's subject is the **admin ServiceAccount**; the
    subject's namespace scopes which ServiceAccount is granted the
    permissions.
- A separate **agent ServiceAccount** that provisioned agent pods run as
  (distinct from the admin SA).
- The provisioner env contract injected into the admin Deployment, matching
  `admin/src/main.ts` `buildProvisioner`.

### Provisioning values

```yaml
agent:
  provisioning:
    enabled: true
    namespace: ""                  # target namespace for provisioned agent resources; defaults to the admin pod's release namespace
    image:
      repository: ghcr.io/app-vitals/shipwright-agent
      tag: agent-v0.172.0
    replicas: 1                    # replicas for each provisioned agent Deployment
    serviceAccount:
      create: true
      name: ""                     # generated if empty
    apiUrl: ""                     # in-cluster admin URL handed to agents; built from the admin Service DNS if empty
    resources:
      requests:
        cpu: ""                     # e.g. "320m"; empty keeps the provisioner's own default
        memory: ""                  # e.g. "3Gi"; empty keeps the provisioner's own default
      limits:
        memory: ""                  # e.g. "9Gi"; empty keeps the provisioner's own default
      ephemeralStorage: ""          # e.g. "5Gi"; applied to both request and limit; empty keeps the provisioner's own default
```

These map to the admin service's provisioning env vars
(`SHIPWRIGHT_K8S_PROVISIONING`, `SHIPWRIGHT_K8S_NAMESPACE`,
`SHIPWRIGHT_AGENT_IMAGE`, `SHIPWRIGHT_AGENT_IMAGE_TAG`, `SHIPWRIGHT_AGENT_REPLICAS`,
`SHIPWRIGHT_API_URL`) — documented in full in
[`configuration-agent.md`](./configuration-agent.md#agent-provisioning-admin-service). (An
earlier `ownerReference`-based garbage-collection mechanism —
`SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME`/`SHIPWRIGHT_ADMIN_DEPLOYMENT_UID`,
`adminDeploymentUid` — was removed in #593: ineffective across the
admin/agent namespace split and unsafe same-namespace, since it would
cascade-delete every provisioned agent on admin uninstall.)

The provisioned agent container's resource requests/limits can also be
overridden per field via `SHIPWRIGHT_K8S_AGENT_CPU_REQUEST`,
`SHIPWRIGHT_K8S_AGENT_MEMORY_REQUEST`, `SHIPWRIGHT_K8S_AGENT_MEMORY_LIMIT`, and
`SHIPWRIGHT_K8S_AGENT_EPHEMERAL_STORAGE` — unset fields keep today's defaults
(500m cpu / 2Gi memory request / 8Gi memory limit / 4Gi ephemeral storage, no
CPU limit). See [`configuration-agent.md`](./configuration-agent.md#agent-provisioning-admin-service)
for full defaults and rationale.

### Chat service provisioning (opt-in)

By default the admin service **does not** mint chat-service tokens — provisioned agents carry no chat-service credentials. Per-agent chat-service token provisioning at agent-creation time is enabled the same way the admin console's Chat tab is: via the top-level `chat.enabled` + `chat.adminToken.existingSecret` chart values described in [Chat service (opt-in)](#chat-service-opt-in) above — there is no separate `agent.provisioning.chatService.*` value block.

When `chat.enabled=true` and `chat.adminToken.existingSecret` is set, the chart injects `SHIPWRIGHT_CHAT_SERVICE_URL` and `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` into the admin Deployment. With those present, the provisioner mints a scoped per-agent token when an agent is created, stores it in the agent Secret (key `chat-service-token`), and injects it into the agent Deployment as `SHIPWRIGHT_CHAT_SERVICE_TOKEN` (via `secretKeyRef`). On agent deletion the token is revoked via `DELETE /tokens/:id`. When the admin token wiring is absent, chat-service token provisioning is disabled and agents carry no chat-service credentials.

### Task-store claim TTL and the agent fleet

Task-store and the agent are separate deployables with independent env surfaces. When provisioning a **fleet of N agents sharing one task-store**, each agent can have its own `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` (the hard ceiling timeout, defaulting to 1 hour — a backstop; see `SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS` for the primary, idle-reset timeout), configured per-agent via the admin service's `POST`/`PATCH /agents/:id/envs` endpoints. Task-store itself has a single `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` (the claim reaping timeout, defaulting to 65 minutes) that gates how long a claim remains valid without a heartbeat.

To prevent claims from being reaped mid-session when long-running agents approach their session timeout, `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` must exceed the **maximum** `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` across all provisioned agents, plus the standard 5-minute buffer. Task-store has a startup check (`checkClaimTtlBuffer` in `task-store/src/claim-ttl-buffer-check.ts`) that validates this constraint: the chart ships `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` set to 3600000 ms (1 hour, matching the agent's default ceiling from CSU-1.2) in task-store's env by default. If you are provisioning a **multi-agent fleet** where agents have different timeouts, raise this value to the **maximum** `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` across your entire fleet (via `taskStore.extraEnv` in the chart), and if the resolved claim TTL is insufficient, task-store will `console.warn` at startup with both values and a suggested minimum TTL. The check is purely a warning — it does not block startup — so you can deploy and adjust the TTL upward to resolve it. When the configured claim TTL is insufficient, the warning message includes both the current TTL and the recommended minimum. See [`configuration-agent.md`](./configuration-agent.md#server) for the full `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` and `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` variable descriptions and defaults.

**Caveat for existing `taskStore.extraEnv` overrides:** Helm replaces array-typed values wholesale rather than merging them. If your deployment already sets `taskStore.extraEnv` (e.g. for the `SHIPWRIGHT_TASK_STORE_AGENTS_URL`/`AGENTS_API_KEY` scope-resolver wiring), upgrading to a chart version that ships this new `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` default will silently drop it — your override entirely replaces the chart's default list, with no warning. Re-add the `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` entry to your own `taskStore.extraEnv` override yourself after upgrading.

