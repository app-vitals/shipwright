# Deploying to Kubernetes

> How to deploy the Shipwright services (admin, metrics, agent, task-store, chat, and
> MCP server) to Kubernetes with the `shipwright` Helm chart. Covers authentication
> modes and the cross-cutting concerns shared by every deployment target. For the
> networking model (`networking.type` modes, exposing the task-store externally, and
> the opt-in chat/MCP server services) — see
> [`deploy-kubernetes-networking.md`](./deploy-kubernetes-networking.md). For agent
> runtime provisioning (RBAC, the provisioner env contract, provisioning values) —
> see [`deploy-kubernetes-provisioning.md`](./deploy-kubernetes-provisioning.md). For
> the five end-to-end provider walkthroughs — Minikube (local), GKE (Gateway API +
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

This guide covers authentication modes directly, and points to companion docs for
the rest of the cross-cutting concerns shared by every deployment target:

- [Networking model](#networking-model) — `networking.type` modes, exposing the task-store externally, and the opt-in chat/MCP server services live in a companion doc
- [Cloud provider guides](#cloud-provider-guides) — Minikube (local), GKE, EKS, Traefik, and cloud-native walkthroughs live in a companion doc
- [Agent runtime provisioning model](#agent-runtime-provisioning-model) — RBAC, the provisioner env contract, and provisioning values live in a companion doc
- [Authentication modes](#authentication-modes)
- [Optional add-ons](#optional-add-ons) — agent voice, Web Push, bringing your own PostgreSQL, and bundled ingress/cert-manager live in a companion doc

> Two install paths are interchangeable below. Install from the local chart
> source (`charts/shipwright`) when working in this repo, or from the published
> Helm repo (`shipwright/shipwright`) once you've run
> `helm repo add shipwright https://app-vitals.github.io/shipwright`. The values
> are identical either way.

---

## Networking model

The full networking model — `networking.type` modes, exposing the task-store
externally, and the opt-in chat and MCP server services — lives in a companion
doc: [`deploy-kubernetes-networking.md`](./deploy-kubernetes-networking.md).

---

## Cloud provider guides

Five end-to-end deployment walkthroughs — covering Minikube (local), GKE
(Gateway API + cert-manager), EKS (ALB ingress + cert-manager), Traefik
(ingress + cert-manager, any cluster), and cloud-native (any cluster, no
pre-installed ingress controller or cert-manager required) — live in a
companion doc: [`deploy-kubernetes-providers.md`](./deploy-kubernetes-providers.md).
The cross-cutting concerns in the rest of this guide (the networking model,
agent runtime provisioning, and authentication modes below), plus the optional
add-ons covered in [`deploy-kubernetes-addons.md`](./deploy-kubernetes-addons.md)
(agent voice, Web Push, bringing your own PostgreSQL, and the bundled
ingress-controller/cert-manager subcharts), apply to all five.

---

## Agent runtime provisioning model

The full agent runtime provisioning model — RBAC, ServiceAccounts, the
provisioner env contract, provisioning values, chat-service token
provisioning, and the task-store claim TTL constraint for a multi-agent fleet
— lives in a companion doc:
[`deploy-kubernetes-provisioning.md`](./deploy-kubernetes-provisioning.md).

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

- [`deploy-kubernetes-networking.md`](./deploy-kubernetes-networking.md) — the full networking model: `networking.type` modes, exposing the task-store externally, and the opt-in chat and MCP server services.
- [`deploy-kubernetes-provisioning.md`](./deploy-kubernetes-provisioning.md) — the full agent runtime provisioning model: RBAC, the provisioner env contract, provisioning values, and the task-store claim TTL constraint.
- [`deploy-kubernetes-addons.md`](./deploy-kubernetes-addons.md) — optional add-ons: agent voice, Web Push notifications, bringing your own PostgreSQL, and bundled ingress-controllers/cert-manager.
- [`helm-repo.md`](./helm-repo.md) — installing from the published Helm repo and how publishing is triggered.
- [`charts/shipwright/README.md`](../charts/shipwright/README.md) — the chart's own README: full values table, versioning, and the Bitnami fallback.
- [`configuration.md`](./configuration.md) — every env var, including the agent-provisioning and auth-mode vars.
- [`architecture.md`](./architecture.md) — the four-artifact (plugin / metrics / agent / task-store) design.
