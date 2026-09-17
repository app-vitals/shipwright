# Kubernetes Networking Model

> How the `shipwright` Helm chart exposes its services — `networking.type` modes,
> optionally exposing the task-store externally, and the opt-in chat and MCP
> server services. Split out of [`deploy-kubernetes.md`](./deploy-kubernetes.md)
> to stay under the docs line-count threshold.

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

See [configuration-agent.md](./configuration-agent.md#metrics--admin--chat--task-store-services)
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

See [configuration-agent.md](./configuration-agent.md#metrics--admin--chat--task-store-services)
for the full list of MCP server env vars and their defaults.

