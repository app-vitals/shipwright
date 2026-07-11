# Deploying to Kubernetes

> How to deploy the five Shipwright services (admin, metrics, agent, task-store, chat) to
> Kubernetes with the `shipwright` Helm chart — local on Minikube, and in
> production on GKE (Gateway API + cert-manager) or EKS (ALB + cert-manager).

The chart lives at [`charts/shipwright`](../charts/shipwright) and is also
published to a Helm repo on every chart version bump (see
[`helm-repo.md`](./helm-repo.md)). It packages the admin (port **3001**), metrics
(port **3460**), agent (port **3000**), task-store (port **3000**), and optional chat
(port **3000**) services plus an optional bundled PostgreSQL dependency,
with Minikube-friendly defaults throughout. Task-store and chat are disabled by
default; the agent is provisioned dynamically when `agent.provisioning.enabled=true`
is set.

This guide covers three deployment targets end-to-end, then the cross-cutting
concerns shared by all of them:

- [Minikube (local, HTTP + nginx ingress)](#minikube-local)
- [GKE (Gateway API + cert-manager)](#gke-gateway-api--cert-manager)
- [EKS (ALB ingress + cert-manager)](#eks-alb-ingress--cert-manager)
- [Agent runtime provisioning model](#agent-runtime-provisioning-model)
- [Authentication modes](#authentication-modes)
- [Bringing your own PostgreSQL / Bitnami registry fallback](#bringing-your-own-postgresql--bitnami-registry-fallback)

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
| `ingress` | An `Ingress` routing `/dashboard` → metrics, `/` → admin | Minikube (nginx), EKS (ALB) |
| `gateway` | A Gateway API `Gateway` + `HTTPRoute`s | GKE (managed L7) |

`ingress` and `gateway` are mutually exclusive — only one of the two is ever
rendered. TLS via cert-manager (`tls.certManager.enabled`) currently applies to
the **gateway** path only; on the ingress path TLS is configured through
controller-specific annotations (see the EKS section).

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
app serves `/tasks`, `/tokens`, `/prs`, `/health` at root). Reach it at
`https://<host>/task-store`. Requires `taskStore.enabled=true`; the prefix is
configurable via `taskStore.expose.pathPrefix`.

> **ALB caveat:** AWS ALB ingress does **not** support the
> `nginx.ingress.kubernetes.io/rewrite-target` annotation. On EKS/ALB, configure
> path rewriting via ALB actions (`alb.ingress.kubernetes.io/actions.*`) or
> expose the task-store on a dedicated host instead.

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
  configured". Add a raw token to a Secret (key
  `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` by default), then:

```bash
kubectl -n shipwright patch secret shipwright-secrets --type merge \
  -p "{\"stringData\":{\"SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN\":\"$(openssl rand -hex 32)\"}}"
```

Then upgrade the chart:

```bash
helm upgrade shipwright charts/shipwright \
  --set chat.enabled=true \
  --set chat.adminToken.existingSecret=shipwright-secrets
```

  The chart injects the **same raw token** into both sides: the chat container
  gets it as `CHAT_SEED_ADMIN_TOKEN` (the service upserts the SHA-256 hash into
  its DB at every boot — idempotent), and the admin container gets it as
  `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` plus `SHIPWRIGHT_CHAT_SERVICE_URL`
  pointing at the in-cluster chat Service. This also enables per-agent
  chat-token minting during agent provisioning, which injects
  `SHIPWRIGHT_CHAT_SERVICE_URL`/`SHIPWRIGHT_CHAT_SERVICE_TOKEN` into each
  provisioned agent pod so its chat poll loop starts. Agents provisioned
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

---

## Minikube (local)

A quick local deployment over plain HTTP using the Minikube nginx ingress addon.
PostgreSQL is bundled, so no external database is required.

### Prerequisites

```bash
minikube start
minikube addons enable ingress      # installs the NGINX ingress controller
```

### Install

From the chart source:

```bash
helm dependency build charts/shipwright    # resolve the pinned PostgreSQL subchart
helm install shipwright charts/shipwright \
  --namespace shipwright --create-namespace \
  --set networking.type=ingress \
  --set networking.ingress.className=nginx \
  --set networking.ingress.host=shipwright.local
```

### Key values

```yaml
networking:
  type: ingress
  ingress:
    className: nginx
    host: shipwright.local
tls:
  certManager:
    enabled: false        # Minikube = plain HTTP, no cert-manager installed
auth:
  mode: open              # dev auth — see the security warning below
postgresql:
  enabled: true           # bundled PostgreSQL (default)
```

### Networking and reaching the services

With `networking.type=ingress` the chart renders an `Ingress` that routes
`/dashboard` to the metrics service and `/` (catch-all) to the admin service.
Point the host at the Minikube IP:

```bash
echo "$(minikube ip) shipwright.local" | sudo tee -a /etc/hosts
```

Then:

- Admin UI/API: `http://shipwright.local/`
- Metrics dashboard: `http://shipwright.local/dashboard`

Or skip the ingress entirely and port-forward (works with the default
`networking.type=ClusterIP` too):

```bash
kubectl port-forward svc/shipwright-admin   3001:3001 -n shipwright   # → http://localhost:3001
kubectl port-forward svc/shipwright-metrics 3460:3460 -n shipwright   # → http://localhost:3460/dashboard
```

### TLS

None — Minikube runs plain HTTP (`tls.certManager.enabled=false`, the default).

The bundled PostgreSQL ships **no** default password: the Bitnami subchart
auto-generates a random one on install. Retrieve it per the NOTES printed after `helm install`. A
generated password is **not** stable across `helm upgrade` — fine for a
throwaway Minikube, but for anything persistent set
`postgresql.auth.existingSecret`. See
[the chart README](../charts/shipwright/README.md#quick-start-minikube).

---

## GKE (Gateway API + cert-manager)

Production deployment on GKE using the managed external L7 load balancer via the
Gateway API, with TLS issued by cert-manager. A ready-to-apply example lives at
[`charts/shipwright/examples/values-gke-gateway.yaml`](../charts/shipwright/examples/values-gke-gateway.yaml).

### Prerequisites

- **Gateway API CRDs** (`gateway.networking.k8s.io/v1`) installed in the cluster.
  On GKE these are provided by the Gateway API add-on, and the
  `gke-l7-global-external-managed` GatewayClass ships with GKE's managed gateway
  controller.
- **cert-manager** installed, with a `ClusterIssuer` already created (e.g.
  `letsencrypt-prod`). cert-manager's CRDs (`cert-manager.io/v1`) must exist
  before the chart renders the `Certificate`.

> The chart's `ci/` values used by chart-testing do **not** enable the gateway
> or cert-manager, because the test kind cluster has neither set of CRDs. That's
> why the GKE configuration lives under `examples/` and is applied manually on a
> real cluster — see the header comment in the example file.

### Install

```bash
helm install shipwright charts/shipwright \
  --namespace shipwright --create-namespace \
  -f charts/shipwright/examples/values-gke-gateway.yaml
```

### Key values

```yaml
networking:
  type: gateway
  gateway:
    gatewayClassName: gke-l7-global-external-managed
    host: shipwright.example.com
tls:
  certManager:
    enabled: true
    issuerRef:
      name: letsencrypt-prod      # a ClusterIssuer that must already exist
      kind: ClusterIssuer
auth:
  mode: google                    # real OAuth for a public deployment
  google:
    clientId: <your-oauth-client-id>
    clientSecret: <your-oauth-client-secret>
    allowedEmails: you@your-domain.example
```

### Networking

`networking.type=gateway` renders a `Gateway` plus `HTTPRoute`s:

- A plain **HTTP listener on :80** for the configured host, always present.
- When `tls.certManager.enabled=true`, an additional **HTTPS listener on :443**
  referencing the cert-manager-issued Secret (`<release>-tls`).
- An `HTTPRoute` routing `/dashboard` → metrics and `/` → admin. With TLS
  enabled, these routes attach to the `https` listener, and a dedicated
  **HTTP→HTTPS redirect** route on the `http` listener issues a `301` so
  plaintext traffic is redirected — the standard expectation for
  `gke-l7-global-external-managed`.

Point your DNS `A`/`AAAA` record (or the host's reserved IP) at the Gateway's
external address once provisioned, then reach:

- Admin UI/API: `https://shipwright.example.com/`
- Metrics dashboard: `https://shipwright.example.com/dashboard`

### TLS

cert-manager issues the certificate. With `tls.certManager.enabled=true` and
`networking.type=gateway`, the chart renders a `cert-manager.io/v1`
`Certificate` for `networking.gateway.host`, signed by the referenced
`(Cluster)Issuer`. cert-manager writes the issued cert into the `<release>-tls`
Secret, which the Gateway's HTTPS listener consumes. (The `Certificate` is
**only** rendered when both `certManager.enabled=true` and
`networking.type=gateway` — it has no effect on the ingress path.)

---

## EKS (ALB ingress + cert-manager)

Production deployment on EKS using the AWS Load Balancer Controller to provision
an Application Load Balancer from the chart's `Ingress`, with cert-manager for
certificate management.

### Prerequisites

- **AWS Load Balancer Controller** installed in the cluster — it watches
  `Ingress` objects with `ingressClassName: alb` and provisions an ALB. Without
  it, the rendered `Ingress` has no controller and no load balancer appears.
- **cert-manager** (or AWS Certificate Manager via annotations) for TLS.

### Install

```bash
helm install shipwright charts/shipwright \
  --namespace shipwright --create-namespace \
  --set networking.type=ingress \
  --set networking.ingress.className=alb \
  --set networking.ingress.host=shipwright.example.com \
  --set-string 'networking.ingress.annotations.alb\.ingress\.kubernetes\.io/scheme=internet-facing' \
  --set-string 'networking.ingress.annotations.alb\.ingress\.kubernetes\.io/target-type=ip'
```

In practice prefer a values file for the annotations:

### Key values

```yaml
networking:
  type: ingress
  ingress:
    className: alb
    host: shipwright.example.com
    annotations:
      alb.ingress.kubernetes.io/scheme: internet-facing
      alb.ingress.kubernetes.io/target-type: ip
      alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
      # TLS via AWS Certificate Manager — point at your issued cert ARN:
      alb.ingress.kubernetes.io/certificate-arn: <your-acm-certificate-arn>
tls:
  certManager:
    enabled: false      # ingress-path TLS is via ALB/ACM annotations, not the Gateway Certificate
auth:
  mode: google
  google:
    clientId: <your-oauth-client-id>
    clientSecret: <your-oauth-client-secret>
    allowedEmails: you@your-domain.example
```

### Networking

`networking.type=ingress` with `className: alb` renders an `Ingress` the AWS
Load Balancer Controller turns into an ALB. The path layout is the same as the
nginx case: `/dashboard` → metrics, `/` (catch-all) → admin. The
`networking.ingress.annotations` map is passed straight onto the `Ingress`, so
all ALB behavior (scheme, target type, listener ports, certificate) is
controller-driven through those annotations.

Point your DNS record at the ALB's DNS name once provisioned, then reach:

- Admin UI/API: `https://shipwright.example.com/`
- Metrics dashboard: `https://shipwright.example.com/dashboard`

### TLS

On the ingress path, TLS is terminated at the ALB via the
`alb.ingress.kubernetes.io/certificate-arn` annotation (an ACM certificate) and
`listen-ports`. The chart's cert-manager `Certificate` template applies only to
the **gateway** path, so leave `tls.certManager.enabled=false` here. If you
prefer cert-manager-managed certs on EKS, you can still use cert-manager to
populate a TLS Secret and reference it through the appropriate controller
annotations, but the chart does not render the `Certificate` for the ingress
path.

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

- A **`ClusterRole`** (not a namespace-scoped `Role`) named
  `<admin>-agent-provisioner` granting `create`, `get`, and `delete` on
  `PersistentVolumeClaims` (core), `Deployments` (`apps`), and `Secrets` (core)
  — exactly the verbs the provisioner exercises. The ClusterRole enables the
  admin service to provision agents in any target namespace, not just its own
  release namespace (e.g. provisioning agents with PVCs pinned to a dedicated
  target namespace).
- A **`ClusterRoleBinding`** binding that ClusterRole to the **admin ServiceAccount**.
  The subject's namespace scopes which ServiceAccount is granted the
  cluster-wide permissions.
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
```

These map to the admin service's provisioning env vars
(`SHIPWRIGHT_K8S_PROVISIONING`, `SHIPWRIGHT_K8S_NAMESPACE`,
`SHIPWRIGHT_AGENT_IMAGE`, `SHIPWRIGHT_AGENT_IMAGE_TAG`, `SHIPWRIGHT_AGENT_REPLICAS`,
`SHIPWRIGHT_API_URL`, `SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME`,
`SHIPWRIGHT_ADMIN_DEPLOYMENT_UID`) — documented in full in
[`configuration.md`](./configuration.md#agent-provisioning-admin-service).

### Chat service provisioning (opt-in)

By default the admin service **does not** mint chat-service tokens — provisioned agents carry no chat-service credentials. To enable per-agent chat-service token provisioning on `POST /agents`, set both `SHIPWRIGHT_CHAT_SERVICE_URL` and `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` on the admin Deployment:

- `SHIPWRIGHT_CHAT_SERVICE_URL` — in-cluster base URL of the chat service (e.g. `http://chat:3000`). Injected into the agent Deployment as `SHIPWRIGHT_CHAT_SERVICE_URL` (plain env value).
- `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` — bearer token for the admin service to mint/revoke chat-service tokens via the chat-service REST API. Env-var-only (secret).

When both are set, the provisioner mints a scoped per-agent token during `POST /agents`, stores it in the agent Secret (key `chat-service-token`), and injects it into the Deployment as `SHIPWRIGHT_CHAT_SERVICE_TOKEN` (via `secretKeyRef`). On agent deletion the token is revoked via `DELETE /tokens/:id`. When either var is unset, chat-service token provisioning is disabled and agents carry no chat-service credentials.

**Chart values:**

```yaml
agent:
  provisioning:
    enabled: true
    # ... other values
  chatService:
    enabled: false                   # set to true to enable chat-service token provisioning
    url: http://chat:3000            # in-cluster chat service URL; required when enabled=true
    adminToken: ""                   # secret bearer token; required when enabled=true
```

---

## Agent voice (STT/TTS)

Agent voice — speech-to-text (STT) for incoming voice notes and text-to-speech
(TTS) for spoken replies — is a **deploy-time option**, off by default. When
disabled, no voice resources render and provisioned agent pods carry only the
three base env vars (`SHIPWRIGHT_AGENT_ID`, `SHIPWRIGHT_API_URL`,
`SHIPWRIGHT_AGENT_API_KEY`).

Enable it with `agent.voice.enabled=true` and pick an STT provider:

- **`provider: whisper`** (default) — the chart renders a self-hosted Whisper
  ASR **Deployment + Service** running `onerahmet/openai-whisper-asr-webservice`.
  The agent's transcription client POSTs to that image's `/asr` endpoint
  (`?encode=true&task=transcribe&output=txt`, audio in the `audio_file` field,
  plain-text response). The admin Deployment gets `WHISPER_SERVICE_URL` pointing
  at the in-cluster Service, which the provisioner flows into each agent pod.
- **`provider: groq`** — no Whisper pod; Groq cloud STT is used instead. The
  `GROQ_API_KEY` is stored in the chart-managed voice `Secret` and injected into
  the admin (and provisioned agents) via `secretKeyRef`.

TTS is **ElevenLabs** for both providers (the agent falls back to an in-pod
`edge-tts` if no key is set). The ElevenLabs key + optional voice id and the Groq
key live in the chart-managed voice `Secret`; non-secret values (the Whisper
Service URL, the voice id) are plain Deployment env.

> Voice env reaches provisioned agent pods through the admin provisioner:
> `agent.voice.*` → admin Deployment env → `admin/src/main.ts` `buildProvisioner`
> → `buildAgentDeploymentManifest`. So `agent.provisioning.enabled=true` is what actually
> stamps the voice env onto agent pods; with provisioning off the admin stays in
> Noop mode and the voice env is inert.

### Voice values

```yaml
agent:
  voice:
    enabled: true
    provider: whisper            # "whisper" (self-hosted pod) | "groq" (cloud STT)
    whisper:
      image: onerahmet/openai-whisper-asr-webservice:latest  # pin a concrete tag in prod
      service:
        port: 9000               # in-cluster Service port → WHISPER_SERVICE_URL
      resources: {}              # ASR is heavy; size for your model
    elevenlabs:
      apiKey: ""                 # → ELEVENLABS_API_KEY (TTS); empty → edge-tts fallback
      voiceId: ""                # → ELEVENLABS_VOICE_ID (optional)
    groq:
      apiKey: ""                 # → GROQ_API_KEY (only used when provider=groq)
```

These map to the agent voice env vars (`WHISPER_SERVICE_URL`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `GROQ_API_KEY`) read by
`agent/src/config.ts`.

---

## Authentication modes

The admin service's `auth.mode` selects how users authenticate to the admin UI.

### `auth.mode=open` — dev auth (default)

Sets `ADMIN_DEV_AUTH=true`: a working UI with **no real authentication**. Anyone
who can reach the service is authenticated. This is the Minikube/dev default.

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
required mode for the GKE and EKS targets above.

---

## Bringing your own PostgreSQL / Bitnami registry fallback

The bundled PostgreSQL is the **Bitnami `postgresql` subchart**, pinned to a
chart version whose default image tag is concrete (not `latest`) so it renders
deterministically. In 2025 Bitnami changed their catalog and registry, so if the
default registry tags become unavailable you can repoint the images without
changing the chart, or bring your own database:

- **Mirror the whole stack:** set `global.imageRegistry: <your-mirror>`.
  When set, this prefix is applied **only** to bare repository names (those not
  already naming a registry host). Shipwright's service images default to
  fully-qualified GHCR paths (e.g., `ghcr.io/app-vitals/shipwright-admin`),
  which are **not** prefixed — avoiding double-prefixing
  (e.g., `registry/ghcr.io/...`). A repository's first `/`-delimited segment is
  checked: if it contains a `.` or `:` (e.g., `ghcr.io`, `docker.io`,
  `localhost:5000`), it's treated as a fully-qualified registry host and left
  alone. Only bare names (e.g., `shipwright-admin` or the whisper image
  `onerahmet/openai-whisper-asr-webservice`) receive the prefix.

- **Use the `bitnamilegacy` mirror** for PostgreSQL specifically.

- **Bring your own PostgreSQL:** set `postgresql.enabled=false` and point
  `externalDatabase.existingSecret` at a pre-created Kubernetes Secret holding
  `DATABASE_URL_SHIPWRIGHT_ADMIN`. The chart injects the value into the admin
  pod from that Secret — you create and rotate the Secret outside the chart.
  If you enable task-store (`taskStore.enabled=true`), also pre-create a Secret
  holding `DATABASE_URL_SHIPWRIGHT_TASK_STORE` and point `taskStore.database.existingSecret`
  at it — the task-store database **must be separate** from the admin database.
  Similarly, if you enable chat (`chat.enabled=true`), pre-create a Secret
  holding `DATABASE_URL_SHIPWRIGHT_CHAT` — the chat database **must also be separate**
  from both the admin and task-store databases.

  ```yaml
  postgresql:
    enabled: false
  externalDatabase:
    existingSecret: my-db-secret          # Secret you create and manage
    adminUrlKey: DATABASE_URL_SHIPWRIGHT_ADMIN   # key within the Secret (default if omitted)
  ```

- **Cloud SQL Proxy (GKE):** when the Postgres instance uses a Private IP (Cloud
  SQL or equivalent), set `cloudSqlProxy.enabled=true` and supply a
  `cloudSqlProxy.connectionName`. The chart injects a `cloud-sql-proxy v2`
  sidecar into the admin pod; the proxy listens on `127.0.0.1:5432` with
  `--private-ip`, making the instance reachable as `localhost` from the admin
  container. Use together with `externalDatabase.existingSecret` and
  `postgresql.enabled=false`.

  ```yaml
  postgresql:
    enabled: false
  externalDatabase:
    existingSecret: my-cloud-sql-secret
  cloudSqlProxy:
    enabled: true
    connectionName: "project:region:instance"   # required
    image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2
  ```

The full image-override / mirror guidance and the exact pinned version are in
[the chart README — "Bitnami registry risk and image-override / mirror fallback"](../charts/shipwright/README.md#-bitnami-registry-risk-and-image-override--mirror-fallback).

---

## See also

- [`helm-repo.md`](./helm-repo.md) — installing from the published Helm repo and how publishing is triggered.
- [`charts/shipwright/README.md`](../charts/shipwright/README.md) — the chart's own README: full values table, versioning, and the Bitnami fallback.
- [`configuration.md`](./configuration.md) — every env var, including the agent-provisioning and auth-mode vars.
- [`architecture.md`](./architecture.md) — the four-artifact (plugin / metrics / agent / task-store) design.
