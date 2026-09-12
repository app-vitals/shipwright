# Deploying to Kubernetes

> How to deploy the Shipwright services (admin, metrics, agent, task-store, chat, and
> MCP server) to Kubernetes with the `shipwright` Helm chart. Covers the networking
> model and the cross-cutting concerns shared by every deployment target. For the
> five end-to-end provider walkthroughs — Minikube (local), GKE (Gateway API +
> cert-manager), EKS (ALB + cert-manager), Traefik (ingress + cert-manager), and
> cloud-native (any cluster) — see
> [`deploy-kubernetes-providers.md`](./deploy-kubernetes-providers.md). For optional
> feature add-ons (agent voice, Web Push, bringing your own PostgreSQL, bundled
> ingress/cert-manager) — see [`deploy-kubernetes-addons.md`](./deploy-kubernetes-addons.md).

The chart lives at [`charts/shipwright`](../charts/shipwright) and is also
published to a Helm repo on every chart version bump (see
[`helm-repo.md`](./helm-repo.md)). It packages the admin (port **3001**), metrics
(port **3460**), agent (port **3000**), task-store (port **3000**), optional chat
(port **3000**), and optional MCP server (port **3010**) services plus optional bundled
dependencies (PostgreSQL, ingress-nginx, Traefik, cert-manager), with Minikube-friendly defaults
throughout. Task-store, chat, MCP server, and all bundled dependencies are disabled by default;
the agent is provisioned dynamically when `agent.provisioning.enabled=true` is set.

This guide covers the networking model, then the cross-cutting concerns shared
by every deployment target:

- [Networking model](#networking-model)
- [Cloud provider guides](#cloud-provider-guides) — Minikube (local), GKE, EKS, Traefik, and cloud-native walkthroughs live in a companion doc
- [Agent runtime provisioning model](#agent-runtime-provisioning-model)
- [Authentication modes](#authentication-modes)
- [Optional add-ons](#optional-add-ons) — agent voice, Web Push, bringing your own PostgreSQL, and bundled ingress/cert-manager live in a companion doc

> Two install paths are interchangeable below. Install from the local chart
> source (`charts/shipwright`) when working in this repo, or from the published
> Helm repo (`shipwright/shipwright`) once you've run
> `helm repo add shipwright https://app-vitals.github.io/shipwright`. The values
> are identical either way.

---

## Networking model

`networking.type` selects how the services are exposed. The admin UI/API is
served at `/` and the metrics dashboard at `/dashboard`, on a single host:

| `networking.type` | What renders | Typical target |
|---|---|---|
| `ClusterIP` | Services only; reach via `kubectl port-forward` | Default; any cluster |
| `NodePort` | NodePort Services | Bare-metal / kind |
| `LoadBalancer` | LoadBalancer Services | Cloud L4 LB |
| `ingress` | An `Ingress` routing `/dashboard` → metrics, `/` → admin | Minikube (nginx), EKS (ALB), or any cluster with Traefik |
| `gateway` | A Gateway API `Gateway` + `HTTPRoute`s | GKE (managed L7) |

`ingress` and `gateway` are mutually exclusive — only one of the two is ever
rendered. TLS via cert-manager (`tls.certManager.enabled`) applies to **both**
the gateway and ingress paths (see the [GKE](./deploy-kubernetes-providers.md#gke-gateway-api--cert-manager)
and [EKS](./deploy-kubernetes-providers.md#eks-alb-ingress--cert-manager) sections in the provider guides for details on how each
implements it). On the ingress path, cert-manager is integrated via the
ingress-shim annotation mechanism rather than a chart-rendered Certificate.

### Exposing the task-store externally (opt-in)

By default the task-store Service is `ClusterIP`-only and has no external route —
reachable only inside the cluster. To make it reachable from outside (e.g. for a
local/self-hosted agent holding a scoped token), set:

```bash
--set taskStore.enabled=true --set taskStore.expose.enabled=true
```

This adds a `/task-store` path on the existing host (no extra DNS/cert work):

- **gateway**: an `HTTPRoute` on `/task-store` with a `URLRewrite`
  (`ReplacePrefixMatch: /`) filter, attached to the same `Gateway` (and the
  `https` listener when cert-manager is enabled).
- **ingress**: a `/task-store(/|$)(.*)` path plus the
  `nginx.ingress.kubernetes.io/rewrite-target: /$2` annotation.

Both **strip the `/task-store` prefix** before traffic reaches the Service (the
app serves `/tasks`, `/tokens`, `/prs`, `/health`, and `/health/ready` at root). Reach it at
`https://<host>/task-store`. Requires `taskStore.enabled=true`; the prefix is
configurable via `taskStore.expose.pathPrefix`.

> **ALB caveat:** AWS ALB ingress does **not** support the
> `nginx.ingress.kubernetes.io/rewrite-target` annotation. On EKS/ALB, configure
> path rewriting via ALB actions (`alb.ingress.kubernetes.io/actions.*`) or
> expose the task-store on a dedicated host instead.
>
> **Traefik caveat:** Traefik uses a `StripPrefix` middleware instead of a
> rewrite-target annotation. The chart renders this middleware automatically
> when `networking.ingress.controller=traefik` and `taskStore.expose.enabled=true`
> (see `templates/ingress-traefik-middleware.yaml`); no manual annotation work is needed.

### Chat service (opt-in)

The optional chat service (`@shipwright/chat`) manages web chat threads, messages, and
scoped agent tokens. By default it is **disabled** (`chat.enabled=false`) — purely
additive and safe to deploy without. To enable it:

```bash
--set chat.enabled=true
```

The chat service requires:

- **A dedicated Postgres database** via `DATABASE_URL_SHIPWRIGHT_CHAT` (read from
  a Kubernetes Secret, not bundled in the chart). The chart's `chat-deployment.yaml`
  injects it via `secretKeyRef` pointing at the Secret named by
  `chat.database.existingSecret` (default: `shipwright-secrets`). **Must be
  separate** from the admin and task-store databases — the schema forbids sharing
  a database connection.
- **Admin-token wiring** (`chat.adminToken`) to light up the admin console's
  Chat tab (`/admin/chat`). Without it the tab renders "Chat service not
  configured". Leave `chat.adminToken.existingSecret` unset and the chart
  **generates the token for you**, into its own chart-managed chat Secret
  (reused across `helm upgrade` via the same `lookup`-based idiom as the
  auto-generated DB secrets above — nothing to create by hand):

```bash
helm upgrade shipwright charts/shipwright --set chat.enabled=true
```

  To supply your own token instead, add a raw one to a Secret (key
  `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` by default), then point
  `chat.adminToken.existingSecret` at it:

```bash
kubectl -n shipwright patch secret shipwright-secrets --type merge \
  -p "{\"stringData\":{\"SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN\":\"$(openssl rand -hex 32)\"}}"
```

```bash
helm upgrade shipwright charts/shipwright \
  --set chat.enabled=true \
  --set chat.adminToken.existingSecret=shipwright-secrets
```

  Either way, the chart injects the **same raw token** into both sides: the
  chat container gets it as `CHAT_SEED_ADMIN_TOKEN` (the service upserts the
  SHA-256 hash into its DB at every boot — idempotent), and the admin
  container gets it as `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` plus
  `SHIPWRIGHT_CHAT_SERVICE_URL` pointing at the in-cluster chat Service. This
  also enables per-agent chat-token minting during agent provisioning, which
  injects `SHIPWRIGHT_CHAT_SERVICE_URL`/`SHIPWRIGHT_CHAT_SERVICE_TOKEN` into
  each provisioned agent pod so its chat poll loop starts. Agents provisioned
  **before** this wiring existed need a re-provision to pick up the chat env.
- **Optional agent scope resolution:** when agents create chat tokens, the chat
  service can query which repos a token may access. Pass these via `chat.extraEnv`
  so they land in the chat container (not admin):

```bash
--set chat.enabled=true \
  --set-string 'chat.extraEnv[0].name=SHIPWRIGHT_CHAT_AGENTS_URL' \
  --set-string 'chat.extraEnv[0].value=http://admin:3001' \
  --set-string 'chat.extraEnv[1].name=SHIPWRIGHT_CHAT_AGENTS_API_KEY' \
  --set-string 'chat.extraEnv[1].value=<api-key>'
```

The chat service runs as a standalone `Deployment` (one pod by default) listening
on port **3000**. By default the Service is `ClusterIP`-only and has no external
route — reachable only from within the cluster (e.g. by agents over the internal
network). No ingress path or external exposure is provided — chat is typically
accessed via the agent's internal network, not the public host.

See [configuration.md](./configuration.md#metrics--admin--chat--task-store-services)
for the full list of chat service env vars and their defaults.

### MCP server (opt-in)

The optional MCP server (`@shipwright/mcp-server`) exposes the task-store API via the
[Model Context Protocol](https://modelcontextprotocol.io/), allowing remote MCP clients
(e.g. Claude Desktop custom connectors) to query and mutate tasks and pull requests. By
default it is **disabled** (`mcpServer.enabled=false`) — purely additive and safe to deploy
without. To enable it:

```bash
--set mcpServer.enabled=true --set mcpServer.taskStoreUrl=http://shipwright-task-store:3000
```

The MCP server requires:

- **A task-store to proxy to** (either this chart's own task-store component or external).
  Set via `mcpServer.taskStoreUrl` — the chart does not auto-derive it from `taskStore.*` so
  both in-cluster and external task-stores are supported.
- **Auth tokens via a Kubernetes Secret.** Both the inbound bearer token MCP server requires
  (`SHIPWRIGHT_MCP_SERVER_TOKEN`, secures the tool proxy surface itself) and the outbound
  task-store bearer token (`SHIPWRIGHT_TASK_STORE_TOKEN`, authenticates the mcp-server to
  the task-store) are always sourced via `secretKeyRef`, never plaintext env. Add them to
  a Secret (default: `shipwright-secrets`), then reference via
  `mcpServer.auth.existingSecret`:

```bash
kubectl -n shipwright patch secret shipwright-secrets --type merge \
  -p "{\"stringData\":{\"SHIPWRIGHT_MCP_SERVER_TOKEN\":\"$(openssl rand -hex 32)\",\"SHIPWRIGHT_TASK_STORE_TOKEN\":\"<token>\"}}"
```

The MCP server runs as a standalone `Deployment` (one pod by default) listening on
port **3010**. By default the Service is `ClusterIP`-only and has no external route —
reachable only from within the cluster. **Deliberately exposing it externally
(e.g. via `networking.type=ingress` or `networking.type=gateway`) is a separate, human
decision outside this chart.** The chart only renders the internal ClusterIP Service; any
external path routing is operator-driven.

See [configuration.md](./configuration.md#metrics--admin--chat--task-store-services)
for the full list of MCP server env vars and their defaults.

---

## Cloud provider guides

Five end-to-end deployment walkthroughs — covering Minikube (local), GKE
(Gateway API + cert-manager), EKS (ALB ingress + cert-manager), Traefik
(ingress + cert-manager, any cluster), and cloud-native (any cluster, no
pre-installed ingress controller or cert-manager required) — live in a
companion doc: [`deploy-kubernetes-providers.md`](./deploy-kubernetes-providers.md).
The cross-cutting concerns in the rest of this guide (networking model above,
agent runtime provisioning, and authentication modes below), plus the optional
add-ons covered in [`deploy-kubernetes-addons.md`](./deploy-kubernetes-addons.md)
(agent voice, Web Push, bringing your own PostgreSQL, and the bundled
ingress-controller/cert-manager subcharts), apply to all five.

---

## Agent runtime provisioning model

By default the admin service runs in **Noop** mode: creating an agent
(`POST /agents`) or deleting one (`DELETE /agents/:id`) only writes a database
row — no cluster access is required, and the chart renders no provisioning RBAC.
This is the safe default for any deployment that doesn't need the admin service
to spin up real agent workloads.

Setting `agent.provisioning.enabled=true` switches the admin service to the
**Kubernetes** provisioner. Then:

- `POST /agents` creates a per-agent **PersistentVolumeClaim** (for persistent
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
    adminDeploymentUid: ""         # optional, for ownerRef GC; omitted when empty (downward API can't supply it)
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
`SHIPWRIGHT_API_URL`, `SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME`,
`SHIPWRIGHT_ADMIN_DEPLOYMENT_UID`) — documented in full in
[`configuration.md`](./configuration.md#agent-provisioning-admin-service).

The provisioned agent container's resource requests/limits can also be
overridden per field via `SHIPWRIGHT_K8S_AGENT_CPU_REQUEST`,
`SHIPWRIGHT_K8S_AGENT_MEMORY_REQUEST`, `SHIPWRIGHT_K8S_AGENT_MEMORY_LIMIT`, and
`SHIPWRIGHT_K8S_AGENT_EPHEMERAL_STORAGE` — unset fields keep today's defaults
(500m cpu / 2Gi memory request / 8Gi memory limit / 4Gi ephemeral storage, no
CPU limit). See [`configuration.md`](./configuration.md#agent-provisioning-admin-service)
for full defaults and rationale.

### Chat service provisioning (opt-in)

By default the admin service **does not** mint chat-service tokens — provisioned agents carry no chat-service credentials. Per-agent chat-service token provisioning on `POST /agents` is enabled the same way the admin console's Chat tab is: via the top-level `chat.enabled` + `chat.adminToken.existingSecret` chart values described in [Chat service (opt-in)](#chat-service-opt-in) above — there is no separate `agent.provisioning.chatService.*` value block.

When `chat.enabled=true` and `chat.adminToken.existingSecret` is set, the chart injects `SHIPWRIGHT_CHAT_SERVICE_URL` and `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` into the admin Deployment. With those present, the provisioner mints a scoped per-agent token during `POST /agents`, stores it in the agent Secret (key `chat-service-token`), and injects it into the agent Deployment as `SHIPWRIGHT_CHAT_SERVICE_TOKEN` (via `secretKeyRef`). On agent deletion the token is revoked via `DELETE /tokens/:id`. When the admin token wiring is absent, chat-service token provisioning is disabled and agents carry no chat-service credentials.

### Task-store claim TTL and the agent fleet

Task-store and the agent are separate deployables with independent env surfaces. When provisioning a **fleet of N agents sharing one task-store**, each agent can have its own `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` (the hard ceiling timeout, defaulting to 1 hour — a backstop; see `SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS` for the primary, idle-reset timeout), configured per-agent via the admin service's `POST`/`PATCH /agents/:id/envs` endpoints. Task-store itself has a single `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` (the claim reaping timeout, defaulting to 65 minutes) that gates how long a claim remains valid without a heartbeat.

To prevent claims from being reaped mid-session when long-running agents approach their session timeout, `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` must exceed the **maximum** `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` across all provisioned agents, plus the standard 5-minute buffer. Task-store has a startup check (`checkClaimTtlBuffer` in `task-store/src/claim-ttl-buffer-check.ts`) that validates this constraint: the chart ships `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` set to 3600000 ms (1 hour, matching the agent's default ceiling from CSU-1.2) in task-store's env by default. If you are provisioning a **multi-agent fleet** where agents have different timeouts, raise this value to the **maximum** `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` across your entire fleet (via `taskStore.extraEnv` in the chart), and if the resolved claim TTL is insufficient, task-store will `console.warn` at startup with both values and a suggested minimum TTL. The check is purely a warning — it does not block startup — so you can deploy and adjust the TTL upward to resolve it. When the configured claim TTL is insufficient, the warning message includes both the current TTL and the recommended minimum. See [`configuration.md`](./configuration.md#server) for the full `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` and `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` variable descriptions and defaults.

**Caveat for existing `taskStore.extraEnv` overrides:** Helm replaces array-typed values wholesale rather than merging them. If your deployment already sets `taskStore.extraEnv` (e.g. for the `SHIPWRIGHT_TASK_STORE_AGENTS_URL`/`AGENTS_API_KEY` scope-resolver wiring), upgrading to a chart version that ships this new `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` default will silently drop it — your override entirely replaces the chart's default list, with no warning. Re-add the `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` entry to your own `taskStore.extraEnv` override yourself after upgrading.

---

## Authentication modes

The admin service's `auth.mode` selects how users authenticate to the admin UI.

### `auth.mode=open` — dev auth (default)

Sets `ADMIN_DEV_AUTH=true` and `NODE_ENV=development`: a working UI with **no
real authentication**. Anyone who can reach the service is authenticated. This is
the Minikube/dev default. The explicit `NODE_ENV=development` matters — the admin
image bakes `NODE_ENV=production`, which hard-blocks the dev-auth path unless the
deployment overrides it.

> ⚠️ **Security warning — do not expose `auth.mode=open` publicly.** It performs
> no authentication: any client that can reach the admin service is treated as a
> logged-in user. Use it only on a local cluster or behind a private network you
> fully control. For any internet-reachable deployment, use `auth.mode=google`.

### `auth.mode=google` — Google OAuth (production)

Sets `NODE_ENV=production` (which also hard-blocks the dev-only escapes like
`ADMIN_DEV_AUTH`) and enables real Google OAuth.
Requires:

```yaml
auth:
  mode: google
  google:
    clientId: <your-oauth-client-id>
    clientSecret: <your-oauth-client-secret>      # stored in the chart-managed admin Secret
    allowedEmails: you@your-domain.example,teammate@your-domain.example   # comma-separated allow-list
```

Only emails on `allowedEmails` may sign in. The client secret is kept in the
chart-managed admin Secret, never in plaintext Deployment env. This is the
required mode for the [GKE](./deploy-kubernetes-providers.md#gke-gateway-api--cert-manager)
and [EKS](./deploy-kubernetes-providers.md#eks-alb-ingress--cert-manager) targets
in the provider guides.

### `auth.mode=okta` — Okta OIDC (production)

Sets `NODE_ENV=production` and enables Okta OIDC authentication. Okta is an optional
alternative to Google OAuth; both providers can be configured simultaneously (see below
for how sign-in works when both are enabled).
Requires:

```yaml
auth:
  mode: okta
  okta:
    issuer: https://your-org.okta.com/oauth2/default
    clientId: <your-okta-client-id>
    clientSecret: <your-okta-client-secret>      # stored in the chart-managed admin Secret
    allowedEmails: you@your-domain.example,teammate@your-domain.example   # comma-separated allow-list
```

Only emails on `allowedEmails` may sign in. The client secret is kept in the
chart-managed admin Secret, never in plaintext Deployment env. Okta sign-in is
available at `/admin/auth/okta`. When `OKTA_ISSUER`, `OKTA_CLIENT_ID`, and
`OKTA_CLIENT_SECRET` are set, the login page (`/admin/login`) renders a "Sign in
with Okta" button alongside the Google sign-in button.

---

## Optional add-ons

Beyond the core deploy concerns above, the chart supports several optional,
deploy-time feature add-ons — agent voice (STT/TTS), Web Push notifications,
bringing your own PostgreSQL, and the bundled ingress-controller/cert-manager
subcharts. These are documented in a companion doc:
[`deploy-kubernetes-addons.md`](./deploy-kubernetes-addons.md).

---

## See also

- [`deploy-kubernetes-addons.md`](./deploy-kubernetes-addons.md) — optional add-ons: agent voice, Web Push notifications, bringing your own PostgreSQL, and bundled ingress-controllers/cert-manager.
- [`helm-repo.md`](./helm-repo.md) — installing from the published Helm repo and how publishing is triggered.
- [`charts/shipwright/README.md`](../charts/shipwright/README.md) — the chart's own README: full values table, versioning, and the Bitnami fallback.
- [`configuration.md`](./configuration.md) — every env var, including the agent-provisioning and auth-mode vars.
- [`architecture.md`](./architecture.md) — the four-artifact (plugin / metrics / agent / task-store) design.
