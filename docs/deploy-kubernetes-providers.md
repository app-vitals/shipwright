# Kubernetes Deployment: Provider Guides

> Five end-to-end walkthroughs for deploying the `shipwright` Helm chart to a
> specific target: Minikube (local), GKE (Gateway API + cert-manager), EKS (ALB
> ingress + cert-manager), Traefik (ingress + cert-manager, any cluster), and
> cloud-native (any cluster, no pre-installed ingress controller or cert-manager
> required). For the core concerns shared by all of them — the networking model,
> agent runtime provisioning, and authentication modes — see
> [`deploy-kubernetes.md`](./deploy-kubernetes.md). For the optional add-ons that
> layer on top — agent voice, Web Push notifications, bringing your own
> PostgreSQL, and the bundled ingress-controller/cert-manager subcharts — see
> [`deploy-kubernetes-addons.md`](./deploy-kubernetes-addons.md).

> Two install paths are interchangeable below. Install from the local chart
> source (`charts/shipwright`) when working in this repo, or from the published
> Helm repo (`shipwright/shipwright`) once you've run
> `helm repo add shipwright https://app-vitals.github.io/shipwright`. The values
> are identical either way.

---

## Minikube (local)

The **full stack** — admin, metrics, task-store, chat, bundled PostgreSQL, and
runtime agent provisioning — with **no hand-created Secrets**. The chart assembles
every database connection string for you. The MCP server is disabled by default; enable
it with `mcpServer.enabled=true` if needed.

Three profiles are available, selected via a `--profile` flag to the underlying `scripts/minikube.ts` script:

| Profile | Command | TLS | Ingress | Values file |
|---------|---------|-----|---------|-------------|
| **addon** (default) | `task minikube:up` | Plain HTTP | minikube's built-in `ingress` addon | `examples/values-minikube.yaml` |
| **cloud-native-nginx** | `task minikube:cloud-native` | HTTPS (selfsigned cert-manager) | Bundled ingress-nginx subchart | `examples/values-minikube-cloud-native-nginx.yaml` |
| **cloud-native-traefik** | `task minikube:cloud-native:traefik` | Plain HTTP | Bundled Traefik subchart | `examples/values-minikube-cloud-native-traefik.yaml` |

Each profile is idempotent — repeat `task minikube:up` (or the cloud-native variants) reuses an already-running VM and port-forward; `task minikube:down` tears down all three the same way (VM, helm release, port-forward).

### One command

From the repo root, pick a profile:

**Default (addon):**
```bash
task minikube:up
```

**Cloud-native with HTTPS:**
```bash
task minikube:cloud-native
```

**Cloud-native with Traefik (HTTP):**
```bash
task minikube:cloud-native:traefik
```

Each task handles the key ordering constraints that otherwise fail confusingly:
VM sizing (only settable at `minikube start`), the ingress controller setup (addon profiles enable the minikube `ingress` addon; cloud-native profiles bundle the controller via a helm subchart), waiting for the controller to be ready (addon profile waits for the webhook pod, cloud-native profiles wait on the controller Deployment after install), `helm dependency build` (all optional subcharts — PostgreSQL, ingress-nginx, Traefik, cert-manager — are pinned in `Chart.lock`), and the `/etc/hosts` entry (only possible once there's a routable address to point it at). It then waits on each Deployment individually and runs `helm test`.

With the `docker` driver (the default on macOS/Colima), `minikube ip` returns
an address on a Docker-internal network the host can't route to at all, so the
script starts a background `kubectl port-forward` to the ingress controller Service. The port-forward binds to a local port (`8080` for addon and cloud-native-traefik; both `8080` and `8443` for cloud-native-nginx which also terminates HTTPS), and `/etc/hosts` is pointed at `127.0.0.1`. The port-forward's PID is tracked in
`state/minikube-port-forward.pid` so repeat task runs reuse an already-running forwarder rather than starting duplicates; `task minikube:down` tears it down automatically.

Tear down with `task minikube:down` (stops the port-forward, then helm
uninstall, then minikube delete).

### By hand

The `task minikube:*` commands automate these steps. To run them manually, follow the addon profile example below, or substitute the cloud-native values file and ingress setup steps (see the script source in `scripts/minikube.ts` for the exact cloud-native ingress controller wait commands).

**Addon profile (default):**
```bash
minikube start --cpus=4 --memory=8192 --disk-size=40g
minikube addons enable ingress
kubectl wait --namespace ingress-nginx --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller --timeout=120s
helm dependency build charts/shipwright
helm upgrade --install shipwright charts/shipwright \
  --namespace shipwright --create-namespace \
  -f charts/shipwright/examples/values-minikube.yaml --wait
kubectl port-forward --namespace ingress-nginx svc/ingress-nginx-controller 8080:80 &
echo "127.0.0.1 shipwright.local" | sudo tee -a /etc/hosts
```

**Cloud-native-nginx profile (HTTPS):**
```bash
minikube start --cpus=4 --memory=8192 --disk-size=40g
helm dependency build charts/shipwright
helm upgrade --install shipwright charts/shipwright \
  --namespace shipwright --create-namespace \
  -f charts/shipwright/examples/values-minikube-cloud-native-nginx.yaml --wait
kubectl rollout status deployment/shipwright-ingress-nginx-controller \
  --namespace shipwright --timeout=5m
kubectl port-forward --namespace shipwright svc/shipwright-ingress-nginx-controller 8080:80 8443:443 &
echo "127.0.0.1 shipwright.local" | sudo tee -a /etc/hosts
```

**Cloud-native-traefik profile (HTTP):**
```bash
minikube start --cpus=4 --memory=8192 --disk-size=40g
helm dependency build charts/shipwright
helm upgrade --install shipwright charts/shipwright \
  --namespace shipwright --create-namespace \
  -f charts/shipwright/examples/values-minikube-cloud-native-traefik.yaml --wait
kubectl rollout status deployment/shipwright-traefik \
  --namespace shipwright --timeout=5m
kubectl port-forward --namespace shipwright svc/shipwright-traefik 8080:80 &
echo "127.0.0.1 shipwright.local" | sudo tee -a /etc/hosts
```

### Sizing

The agent pod dominates: **500m CPU / 2Gi memory requests, 8Gi memory limit,
4Gi ephemeral-storage** (`admin/src/agent-manifest.ts`). Ephemeral-storage was
raised from a 1Gi default that left no room for a build step's scratch space
and caused mid-run evictions; tool caches are pinned to the PVC, so this
budget only covers genuinely transient writes. Everything else is small.

| VM size | Good for |
|---|---|
| `--cpus=4 --memory=8192` | Floor — the platform plus **one** agent |
| `--cpus=6 --memory=12288` | Comfortable — an agent doing real work, or two idle agents |
| Below 4 CPU / 6Gi | The agent pod schedules and then thrashes. Don't. |

`--disk-size=40g` covers the agent image plus the PVCs, not RAM.

### What the chart generates for you

Everything in this table used to require a pre-created Secret or hand-wired
`extraEnv`:

| Generated | Where it lives | Notes |
|---|---|---|
| Admin + metrics DB connection strings | `<release>-admin`, `<release>-metrics` | Password never in plaintext env |
| Task-store + chat DB connection strings | `<release>-task-store`, `<release>-chat` | Opt in with `database.existingSecret: ""` |
| The `shipwright_metrics` / `_task_store` / `_chat` databases | initdb ConfigMap + bootstrap hook Job | Each service needs its own (Prisma P3005) |
| Session + encryption keys | `<release>-admin` | Preserved across `helm upgrade` |

All of them are generated on first install and **reused** on upgrade via Helm's
`lookup`. Two consequences worth knowing:

- `helm template | kubectl apply` does **not** execute `lookup`, so that flow
  would rotate every generated token on each apply. Use
  `admin.encryptionKeys.existingSecret` if you deploy that way.
- Any service-specific `existingSecret` overrides the generated value, and
  `extraEnv` — which renders last — overrides everything.

Everything else — inter-service tokens included — is **manual, per-service
`existingSecret` wiring**; the chart does not auto-generate or auto-mesh them.
For example, the chat admin token that powers the admin console's Chat tab is
wired via `chat.adminToken.existingSecret` (see
[Chat service (opt-in)](./deploy-kubernetes.md#chat-service-opt-in)), and the task-store bearer token consumed by
the metrics dashboard is wired via `metrics.provider.taskStoreToken.existingSecret`.
The Minikube example values file below leaves the task-store token unset (see
its comments) since the chart has no equivalent seed-token wiring for
task-store yet — the metrics dashboard falls back to admin-only data until
that Secret is created and referenced by hand.

### Reaching the services

The Ingress routes `/dashboard` to metrics, `/task-store` to the task store, and
`/` (catch-all) to admin. The metrics app mounts its whole router under
`provider.basePath` (`/dashboard` in the Minikube example values) and its own
dashboard route is itself named `/dashboard`, so the two compose — the
browsable URL is `/dashboard/dashboard`, not `/dashboard`.

**Addon and cloud-native-traefik profiles (HTTP):**
- Admin UI/API: `http://shipwright.local/`
- Metrics dashboard: `http://shipwright.local/dashboard/dashboard`
- Task store: `http://shipwright.local/task-store/health`

**Cloud-native-nginx profile (HTTPS):**
- Admin UI/API: `https://shipwright.local:8443/`
- Metrics dashboard: `https://shipwright.local:8443/dashboard/dashboard`
- Task store: `https://shipwright.local:8443/task-store/health`

The task doesn't print this whole list — the console root (`/`)
redirects to a Google sign-in page the Minikube profile never configures, a
dead end for a fresh stack. Instead it prints and auto-opens exactly one link,
`/admin/dev-login` (via `buildAccessUrls()` in `scripts/minikube.ts`), which
mints a dev session outright and lands on `/admin/agents`; every other surface
above is reachable from the console once you're signed in. If `/etc/hosts`
isn't mapped yet it prints the `echo … | sudo tee -a /etc/hosts` line instead
of opening the browser. (For cloud-native-nginx with HTTPS, the script also
prints a kubectl command to check the cert-manager Issuer and Certificate status.)

Or port-forward instead (works with the default `networking.type=ClusterIP`):

```bash
kubectl port-forward svc/shipwright-admin      3001:3001 -n shipwright
kubectl port-forward svc/shipwright-metrics    3460:3460 -n shipwright
kubectl port-forward svc/shipwright-task-store 3000:3000 -n shipwright
kubectl port-forward svc/shipwright-chat       3002:3000 -n shipwright
```

### Creating your first agent

**The chart creates no agents.** Agents are provisioned at runtime by the admin
service, so make one at `http://shipwright.local/admin/agents/new`:

- Pick **Provisioned in-cluster** for the runtime — the admin service creates the
  agent's Deployment, Secret, and PVC for you. (The option is disabled unless
  `agent.provisioning.enabled` is set, which puts `SHIPWRIGHT_K8S_PROVISIONING=enabled`
  on the admin service.) **Self-hosted** is for agents whose container you run
  yourself.
- Paste a Claude credential (`CLAUDE_CODE_OAUTH_TOKEN`) into the form — this chart
  does not provision deployment-wide Claude credentials. You can also set
  `ANTHROPIC_API_KEY` from the agent's detail page afterwards.

**Slack and GitHub Authentication are optional and inline.** Both appear as optional
fieldsets on the New Agent form: **Slack (optional)** reveals an inline Slack App
Configuration Token field when checked, and **GitHub Authentication (optional)** offers
three radio options (Skip, Personal Access Token, or Create GitHub App). You can
connect either one at creation time, skip both and connect them later from the agent's
detail page, or mix and match — it is your choice. An agent with no Slack or GitHub
tokens boots in offline mode and is driven from the admin console's **Chat** tab
(`http://shipwright.local/admin/chat`).

### TLS and security

None — Minikube runs plain HTTP (`tls.certManager.enabled=false`, the default).

> ⚠️ The Minikube profile sets `auth.mode=open`, which sets `ADMIN_DEV_AUTH=true`
> (plus `NODE_ENV=development`, overriding the image's baked-in production default):
> **anyone who can reach the admin service is treated as authenticated.** It also
> sets a known literal PostgreSQL password. Never expose this install publicly.
> For real access control use `auth.mode=google` (see the GKE section).

The profile sets `postgresql.auth.password` explicitly rather than letting Bitnami
generate one. That is deliberate: a generated password is only readable via
`lookup`, which cannot resolve on the **first** install (the Secret does not exist
yet), so the assembled connection strings would carry an empty password. For
anything persistent, use `postgresql.auth.existingSecret` instead.

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
  `letsencrypt-prod`). If you're bringing your own cert-manager, its CRDs
  (`cert-manager.io/v1`) must exist before install. **Alternatively,** you can
  bundle cert-manager in this same Helm release (see [Bundled ingress
  controllers and cert-manager](./deploy-kubernetes-addons.md#bundled-ingress-controllers-and-cert-manager-optional)
  below) — the chart will then apply the `Certificate` after cert-manager's
  CRDs are ready via a post-install Job hook.

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
- Metrics dashboard: `https://shipwright.example.com/dashboard/dashboard`
  (the metrics app mounts its whole router under `provider.basePath` and its
  own dashboard route is itself named `/dashboard`, so the two compose — see
  the Minikube [Reaching the services](#reaching-the-services) note)

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
- **TLS management:** use either AWS Certificate Manager (via annotations,
  requires no cert-manager), or cert-manager (when bundled or pre-installed). If
  bringing your own cert-manager, its CRDs (`cert-manager.io/v1`) must exist
  before install. Alternatively, you can bundle cert-manager in this same Helm
  release (see [Bundled ingress controllers and cert-manager](./deploy-kubernetes-addons.md#bundled-ingress-controllers-and-cert-manager-optional)
  below) — the chart will then apply any chart-managed `Issuer` after
  cert-manager's CRDs are ready via a post-install Job hook.

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

The example below uses **AWS Certificate Manager (ACM)** for TLS — the traditional EKS path that requires no cert-manager:

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
    enabled: false      # ACM path: leave cert-manager off
auth:
  mode: google
  google:
    clientId: <your-oauth-client-id>
    clientSecret: <your-oauth-client-secret>
    allowedEmails: you@your-domain.example
```

Alternatively, use **cert-manager** to fully automate certificate provisioning and renewal:

```yaml
networking:
  type: ingress
  ingress:
    className: alb
    host: shipwright.example.com
    tls:
      enabled: true                # render spec.tls on the Ingress
      redirect: false              # no-op here — `redirect` only renders the nginx-specific ssl-redirect annotation, so it has no effect on ALB
    annotations:
      alb.ingress.kubernetes.io/scheme: internet-facing
      alb.ingress.kubernetes.io/target-type: ip
      alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
      # NOTE: listen-ports alone does NOT redirect HTTP->HTTPS on ALB — it only opens
      # both listeners. To force a redirect, add an actions.ssl-redirect annotation
      # (protocol: HTTPS, port: "443", statusCode: HTTP_301) plus a matching ingress
      # rule pointing at the `ssl-redirect` service (servicePort: use-annotation).
      # Omitted here for brevity; see the AWS Load Balancer Controller docs on SSL redirect.
tls:
  certManager:
    enabled: true                  # enable cert-manager ingress-shim (controller-agnostic annotation)
    issuerRef:
      name: letsencrypt-prod       # a ClusterIssuer that must already exist
      kind: ClusterIssuer
auth:
  mode: google
  google:
    clientId: <your-oauth-client-id>
    clientSecret: <your-oauth-client-secret>
    allowedEmails: you@your-domain.example
```

Both paths work on EKS — pick the one that fits your infrastructure. ACM is simpler if you're already using AWS Certificate Manager; cert-manager is more flexible if you prefer a cluster-native certificate controller.

### Networking

`networking.type=ingress` with `className: alb` renders an `Ingress` the AWS
Load Balancer Controller turns into an ALB. The path layout is the same as the
nginx case: `/dashboard` → metrics, `/` (catch-all) → admin. The
`networking.ingress.annotations` map is passed straight onto the `Ingress`, so
all ALB behavior (scheme, target type, listener ports, certificate) is
controller-driven through those annotations.

Point your DNS record at the ALB's DNS name once provisioned, then reach:

- Admin UI/API: `https://shipwright.example.com/`
- Metrics dashboard: `https://shipwright.example.com/dashboard/dashboard`
  (see the Minikube [Reaching the services](#reaching-the-services) note on
  why the path is doubled)

### TLS

On the ingress path, TLS can be terminated via two mechanisms:

1. **AWS Certificate Manager (ACM)** — the example above. Requires no
   cert-manager installation. Set `tls.certManager.enabled=false` and use the
   `alb.ingress.kubernetes.io/certificate-arn` annotation (an ACM certificate)
   plus `listen-ports` to configure TLS on the ALB itself. This is the
   traditional EKS path and requires you to manage the certificate out-of-band.

2. **cert-manager ingress-shim** — when `tls.certManager.enabled=true`, the
   chart renders the cert-manager ingress-shim annotation
   (`cert-manager.io/issuer` or `cert-manager.io/cluster-issuer`) on the
   `Ingress`. cert-manager watches the annotation and automatically creates and
   manages the TLS Secret. This way the certificate is fully automated and
   rotated by cert-manager — the `spec.tls` stanza is rendered by the chart, and
   you only need to configure the Issuer reference via `tls.certManager.issuerRef`
   (e.g., `letsencrypt-prod`). The chart does **not** render a `Certificate` CR
   for the ingress path — cert-manager's ingress-shim watches the Ingress
   annotation and creates it automatically.

---

## Traefik (ingress + cert-manager)

Production deployment on any Kubernetes cluster with Traefik as the ingress controller, with TLS issued by cert-manager. A ready-to-apply example lives at
[`charts/shipwright/examples/values-cloud-native-traefik.yaml`](../charts/shipwright/examples/values-cloud-native-traefik.yaml).

### Prerequisites

- **Traefik installed** as the cluster's ingress controller, with the Traefik
  API group CRDs (e.g., `traefik.io/v1alpha1` `Middleware`) applied. Most
  Traefik Helm charts include these by default.
- **cert-manager** installed, with a `ClusterIssuer` already created (e.g.
  `letsencrypt-prod`). If you're bringing your own cert-manager, its CRDs
  (`cert-manager.io/v1`) must exist before install. **Alternatively,** you can
  bundle cert-manager in this same Helm release (see [Bundled ingress
  controllers and cert-manager](./deploy-kubernetes-addons.md#bundled-ingress-controllers-and-cert-manager-optional)
  below) — the chart will then apply the `Ingress` TLS stanza and any
  chart-managed `Issuer` after cert-manager's CRDs are ready via a post-install
  Job hook.

### Install

```bash
helm install shipwright charts/shipwright \
  --namespace shipwright --create-namespace \
  -f charts/shipwright/examples/values-cloud-native-traefik.yaml
```

### Key values

```yaml
networking:
  type: ingress
  ingress:
    className: traefik
    host: shipwright.example.com
    # Traefik-specific settings: entrypoint names configured on the Traefik
    # instance itself, plus whether to enable the HTTP→HTTPS redirect route.
    controller: traefik
    tls:
      enabled: true                # render spec.tls on the Ingress
      redirect: true               # render a separate HTTP redirect Ingress (Traefik TLS-only router pattern)
    traefik:
      entrypoints:
        web: web                   # Traefik's HTTP entrypoint name
        websecure: websecure       # Traefik's HTTPS entrypoint name
admin:
  # Public base URL for OAuth/OIDC redirect URIs so they use the public
  # hostname instead of localhost:3001. An explicit value here always wins.
  # When left empty and networking.type is "ingress" or "gateway", the chart
  # auto-derives it as "<scheme>://<public host>" from networking.ingress.host
  # / .gateway.host (https when TLS is on) — no manual override needed for
  # those paths. ClusterIP/NodePort/LoadBalancer installs have no chart-known
  # public host, so the env var stays omitted unless set explicitly here.
  appBaseUrl: ""  # omit or set to ""  to auto-derive from ingress/gateway
tls:
  certManager:
    enabled: true
    issuerRef:
      name: letsencrypt-prod       # a ClusterIssuer that must already exist
      kind: ClusterIssuer
auth:
  mode: google
  google:
    clientId: <your-oauth-client-id>
    clientSecret: <your-oauth-client-secret>
    allowedEmails: you@your-domain.example
```

### Networking

`networking.type=ingress` with `className: traefik` and `controller: traefik`
renders an `Ingress` the Traefik controller watches, plus additional Middleware
CRs for path stripping (when the task-store is exposed).

When Traefik is **bundled** (`traefik.enabled=true`), the chart pins the
subchart's IngressClass to `traefik.ingressClass.name: traefik` so it matches
the Ingress's `ingressClassName` (`networking.ingress.className`) out of the
box. Traefik only routes an Ingress whose explicit `ingressClassName` matches
an existing IngressClass by exact name — a mismatch is skipped silently and
every request through the controller returns 404 — so if you rename either
value, keep the two equal. (The subchart's own default is `<release>-traefik`.)

Unlike nginx and ALB, Traefik uses annotations to configure routing behavior:

- `traefik.ingress.kubernetes.io/router.entrypoints` — selects which Traefik
  entrypoint serves this Ingress (e.g., `web` for HTTP-only, `websecure` for
  HTTPS). The entrypoint names are operator-defined on the Traefik install
  itself, so they're configurable via `networking.ingress.traefik.entrypoints`.
- `traefik.ingress.kubernetes.io/router.tls` — when set to `"true"`, tells
  Traefik to terminate TLS on this Ingress (distinct from the cert-manager
  certificate issuance below).
- `traefik.ingress.kubernetes.io/router.middlewares` — attaches `Middleware`
  resources (like `StripPrefix`) to the Traefik router; automatically applied
  when `taskStore.expose.enabled=true`.

When `networking.ingress.tls.enabled=true` and `tls.redirect=true`, the chart
renders two Ingress objects:

1. A main HTTPS-terminating `Ingress` (on the `websecure` entrypoint) routing
   traffic to admin and metrics.
2. A separate HTTP `Ingress` (on the `web` entrypoint) that issues a 301 redirect
   to HTTPS. This is Traefik's standard pattern because an `Ingress` with
   `spec.tls` is a TLS-only router and cannot also serve plain HTTP — the
   separate redirect Ingress bridges that gap.

Point your DNS `A`/`AAAA` record at the Traefik gateway's external address once
provisioned, then reach:

- Admin UI/API: `https://shipwright.example.com/`
- Metrics dashboard: `https://shipwright.example.com/dashboard/dashboard`
  (see the Minikube [Reaching the services](#reaching-the-services) note on
  why the path is doubled)

### TLS

cert-manager issues the certificate when `tls.certManager.enabled=true`. The
chart renders the cert-manager ingress-shim annotation
(`cert-manager.io/cluster-issuer` or `cert-manager.io/issuer`) on the main
HTTPS-terminating `Ingress`; cert-manager watches the annotation and creates a
`Certificate` CR automatically. The certificate is stored in the `<release>-tls`
Secret, which the Ingress's `spec.tls` stanza consumes. This annotation-based
model is controller-agnostic — it works with Traefik, nginx, ALB, and any other
ingress controller cert-manager supports.

---

## Cloud-native (any cluster)

Unlike the GKE, EKS, and Traefik sections above — which assume an
already-installed ingress controller and cert-manager — this profile bundles
**everything the chart needs as subcharts in the same Helm release**: an
ingress controller (ingress-nginx or Traefik), cert-manager, and PostgreSQL.
It works on any conformant Kubernetes cluster, cloud or bare-metal, with zero
pre-installed cluster dependencies.

> ⚠️ **Do not enable `cert-manager.enabled=true` on a cluster that already
> runs cert-manager.** A second bundled copy installs a second set of CRDs
> and controllers, which can collide with the existing installation (webhook
> conflicts, duplicate CRD ownership, and a `helm uninstall` of this release
> deleting CRDs the other installation still needs). If cert-manager is
> already present cluster-wide, leave `cert-manager.enabled=false` and point
> `tls.certManager.*` at it instead — see the [GKE](#gke-gateway-api--cert-manager),
> [EKS](#eks-alb-ingress--cert-manager), or [Traefik](#traefik-ingress--cert-manager)
> sections for that bring-your-own-cert-manager path.

**Install (ingress-nginx variant):**

```bash
helm upgrade --install shipwright charts/shipwright \
  --namespace shipwright --create-namespace \
  -f charts/shipwright/examples/values-cloud-native.yaml --wait
```

**Install (Traefik variant):**

```bash
helm upgrade --install shipwright charts/shipwright \
  --namespace shipwright --create-namespace \
  -f charts/shipwright/examples/values-cloud-native-traefik.yaml --wait
```

Both example values files bundle `cert-manager` with a `letsencrypt-prod`
issuer and set `admin.appBaseUrl` explicitly for OAuth/OIDC redirects — swap
in a selfsigned issuer or your own hostname as needed. `admin.appBaseUrl`
can now be left empty instead, since the chart auto-derives it from the
ingress/gateway host. See [Bundled ingress
controllers and cert-manager](./deploy-kubernetes-addons.md#bundled-ingress-controllers-and-cert-manager-optional)
in the main deployment guide for the full values reference (per-subchart toggles, the CRD-bootstrap
hook, and the mutual-exclusion rule between `ingress-nginx` and `traefik`),
and [Minikube (local)](#minikube-local) for a dev-tuned variant of this same
profile (`task minikube:cloud-native` / `task minikube:cloud-native:traefik`).

