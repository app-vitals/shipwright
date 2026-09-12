# Kubernetes deploy: optional add-ons

> Optional, deploy-time feature add-ons for the `shipwright` Helm chart — agent
> voice (STT/TTS), Web Push notifications, bringing your own PostgreSQL, and the
> bundled ingress-controller/cert-manager subcharts. All are disabled by default
> and layer on top of the core deploy concerns covered in
> [`deploy-kubernetes.md`](./deploy-kubernetes.md) (networking model, cloud
> provider guides, agent runtime provisioning, and authentication modes).

- [Agent voice (STT/TTS)](#agent-voice-stttts)
- [Web Push notifications (optional)](#web-push-notifications-optional)
- [Bringing your own PostgreSQL / Bitnami registry fallback](#bringing-your-own-postgresql--bitnami-registry-fallback)
- [Bundled ingress controllers and cert-manager (optional)](#bundled-ingress-controllers-and-cert-manager-optional)

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

TTS defaults to **Piper** — a self-hosted binary baked into the agent image,
invoked as a local subprocess (stdin in, WAV file out, no network call). Setting
`agent.voice.elevenlabs.apiKey` opts into **ElevenLabs** cloud TTS instead, for
both providers; the agent checks for that key at synthesis time and, if present,
calls ElevenLabs over the network instead of spawning Piper. The ElevenLabs key +
optional voice id and the Groq key live in the chart-managed voice `Secret`; Piper
voice configuration (`PIPER_VOICE` — the voice name) and non-secret values (the
Whisper Service URL) are plain Deployment env.

### Zero-egress vs. opt-in egress

Voice can run **fully self-hosted, with no third-party network calls**, or you
can opt into cloud providers for either leg independently:

| STT (speech-to-text) | TTS (text-to-speech) | Egress? |
|---|---|---|
| `provider: whisper` (self-hosted Whisper pod) | Piper (default — `agent.voice.elevenlabs.apiKey` unset) | **None.** Both legs stay in-cluster/in-pod. |
| `provider: whisper` (self-hosted Whisper pod) | ElevenLabs (`agent.voice.elevenlabs.apiKey` set) | TTS only — every spoken reply is sent to `api.elevenlabs.io`. |
| `provider: groq` (Groq cloud STT) | Piper (default) | STT only — every voice note is sent to Groq's API. |
| `provider: groq` (Groq cloud STT) | ElevenLabs (`agent.voice.elevenlabs.apiKey` set) | Both legs — voice notes to Groq, replies to ElevenLabs. |

So the zero-egress configuration is: `agent.voice.enabled=true`,
`agent.voice.provider=whisper`, and `agent.voice.elevenlabs.apiKey` left empty
(the default). Setting `agent.voice.provider=groq` or populating
`agent.voice.elevenlabs.apiKey` each independently reintroduce egress to that
respective third party — you can mix and match (e.g. self-hosted STT with cloud
TTS) since the two legs are selected independently.

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
      image: onerahmet/openai-whisper-asr-webservice:v1.10.0  # default; do not float to :latest — the plain-text /asr contract is tightly coupled to this tag
      service:
        port: 9000               # in-cluster Service port → WHISPER_SERVICE_URL
      model: ""                  # ASR model name → ASR_MODEL (e.g. tiny, base, small, medium, large-v3, tiny.en); empty = image default
      resources: {}              # ASR is heavy; size for your model
    elevenlabs:
      apiKey: ""                 # → ELEVENLABS_API_KEY (TTS); empty → Piper TTS fallback
      voiceId: ""                # → ELEVENLABS_VOICE_ID (optional)
    groq:
      apiKey: ""                 # → GROQ_API_KEY (only used when provider=groq)
```

These map to the agent voice env vars (`WHISPER_SERVICE_URL`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `GROQ_API_KEY`) and Whisper pod env vars
(`ASR_MODEL`) read by `agent/src/config.ts` and the Whisper container respectively.

---

## Web Push notifications (optional)

Web Push notifications alert users when an agent replies, enabling **always-on chat**
even when the admin console tab is in the background. When disabled (the default),
the chat page polls for new messages but does not render a notification opt-in toggle.

To enable Web Push, you must generate VAPID keypair (used to sign RFC 8292
`Authorization` headers for Web Push Protocol requests):

```bash
# Generate a VAPID keypair (do this once, outside the cluster)
npx web-push generate-vapid-keys

# Example output:
#   Public Key: BEfJ3...
#   Private Key: aBc1...
```

Then configure the three required env vars and an optional webhook token:

```yaml
admin:
  extraEnv:
    - name: SHIPWRIGHT_ADMIN_VAPID_PUBLIC_KEY
      value: "BEfJ3..."                       # Public key (base64url, sent to browser — NOT secret)
    - name: SHIPWRIGHT_ADMIN_VAPID_PRIVATE_KEY
      valueFrom:
        secretKeyRef:
          name: shipwright-secrets            # Secret name (default)
          key: shipwright-admin-vapid-private-key  # Secret key
    - name: SHIPWRIGHT_ADMIN_VAPID_SUBJECT
      value: "mailto:admin@example.com"       # RFC 8292 subject: mailto or https URL
    - name: SHIPWRIGHT_ADMIN_PUSH_MAX_DETAIL
      value: "title"                          # Hard ceiling: "generic" | "title" | "preview" (default: "title")
```

Add the private key to the Secret:

```bash
kubectl -n shipwright patch secret shipwright-secrets --type merge \
  -p '{"stringData":{"shipwright-admin-vapid-private-key":"aBc1..."}}'
```

If deploying the chat service (which triggers notifications on agent replies), also
configure the shared bearer token the chat service uses to authenticate its webhook:

```bash
kubectl -n shipwright patch secret shipwright-secrets --type merge \
  -p "{\"stringData\":{\"shipwright-admin-push-webhook-token\":\"$(openssl rand -hex 32)\"}}"
```

```yaml
admin:
  extraEnv:
    - name: SHIPWRIGHT_ADMIN_PUSH_WEBHOOK_TOKEN
      valueFrom:
        secretKeyRef:
          name: shipwright-secrets
          key: shipwright-admin-push-webhook-token
```

Separately, inject the same token into the chat service:

```yaml
chat:
  extraEnv:
    - name: SHIPWRIGHT_ADMIN_PUSH_WEBHOOK_TOKEN
      valueFrom:
        secretKeyRef:
          name: shipwright-secrets
          key: shipwright-admin-push-webhook-token
```

**Graceful degradation:** when any VAPID config is missing, the `POST /admin/push/notify`
webhook returns `503 Service Unavailable` (safe for the calling chat service — it
retries), and the chat page's notification toggle does not render (users see the
poll-only experience instead). When `SHIPWRIGHT_ADMIN_PUSH_WEBHOOK_TOKEN` is unset,
the webhook also returns `503 Service Unavailable` (the handler treats a missing
token the same as push being disabled, before it ever checks the caller's bearer
token) — set the token, alongside the VAPID keys, to enable the inbound trigger
path. `401 Unauthorized` is only returned once the token is configured server-side
and the chat service presents a bearer value that doesn't match it.

See [`configuration.md`](./configuration.md#metrics--admin--chat--task-store-services)
for the full list of Web Push env vars and their defaults.

### Session alerts (waiting / reminder / completed)

The same VAPID configuration above also powers a second, independent notification type:
the **session alert sweeper** (`session-alert-sweeper.ts`), a background loop that pushes
"session is waiting" / daily-reminder / "session completed" notifications to session
followers — distinct from the chat-reply notifier's webhook-triggered push above, this one
runs on its own interval and reads sessions directly from the task-store.

No extra VAPID setup is needed — the sweeper only starts once the VAPID env vars above are
configured, **and** the admin service can reach the task-store as an admin caller:

```yaml
admin:
  extraEnv:
    - name: SHIPWRIGHT_TASK_STORE_URL
      value: "http://task-store:3000"
    - name: SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN
      valueFrom:
        secretKeyRef:
          name: shipwright-secrets
          key: shipwright-task-store-admin-token
    - name: SHIPWRIGHT_ADMIN_SESSION_ALERT_INTERVAL_MS
      value: "60000"                          # optional — tick cadence in ms (default: 60000)
```

If either the task-store connection or a VAPID var is missing, the sweeper is simply never
registered (no error, no degraded-mode banner — it's absent).

Retention for these same sessions is a separate, task-store-side concern — set on `taskStore.extraEnv`,
not `admin.extraEnv`:

```yaml
taskStore:
  extraEnv:
    - name: SHIPWRIGHT_TASK_STORE_SESSION_ARCHIVE_AFTER_DAYS
      value: "30"                             # optional — days of inactivity before archiving (default: 30; 0 disables the sweep)
```

Archiving is non-destructive (it only hides a session from the default list view) and reversible
(any new task written into an archived session un-archives it automatically) — see
[`task-store.md`](./task-store.md#session-archive-sweep) for the full sweep rules. There is no
purge/delete endpoint anywhere in this pipeline; nothing this chart configures ever deletes a
session or its tasks.

See [`configuration.md`](./configuration.md#metrics--admin--chat--task-store-services)
for the full env var reference (`SHIPWRIGHT_ADMIN_SESSION_ALERT_INTERVAL_MS`,
`SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN`, `SHIPWRIGHT_TASK_STORE_SESSION_ARCHIVE_AFTER_DAYS`).

---

## Bringing your own PostgreSQL / Bitnami registry fallback

The bundled PostgreSQL is the **Bitnami `postgresql` subchart**, pinned to a
chart version whose default image tag is concrete (not `latest`) so it renders
deterministically. In 2025 Bitnami changed their catalog and registry, moving
many image tags to a `bitnamilegacy` repository — the chart now **defaults to
the `bitnamilegacy/postgresql` image** so a fresh install pulls successfully
from the public registry. You can repoint the images without changing the
chart, or bring your own database:

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

- **Use the standard `bitnami/postgresql` repository** instead of the default
  `bitnamilegacy` mirror (e.g., if you have Bitnami Secure access) by setting
  `postgresql.image.repository: bitnami/postgresql`.

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

  By default, the proxy runs as a **regular sidecar container** alongside the
  main application containers. For Kubernetes clusters running **1.29+**, you can
  optionally use a **native sidecar** (a feature GA in Kubernetes 1.29) by setting
  `cloudSqlProxy.nativeSidecar=true`. Native sidecars start before the main
  container and persist after it exits (via `restartPolicy: Always`), providing
  cleaner lifecycle management and better separation of concerns. When enabled,
  the proxy runs as an `initContainer` instead of a regular `container` in the
  Deployment.

  ```yaml
  postgresql:
    enabled: false
  externalDatabase:
    existingSecret: my-cloud-sql-secret
  cloudSqlProxy:
    enabled: true
    connectionName: "project:region:instance"   # required
    image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2
    nativeSidecar: false                        # set to true for Kubernetes 1.29+
  ```

  The full image-override / mirror guidance and the exact pinned version are in
  [the chart README — "Bitnami registry risk and image-override / mirror fallback"](../charts/shipwright/README.md#-bitnami-registry-risk-and-image-override--mirror-fallback).

---

## Bundled ingress controllers and cert-manager (optional)

The chart includes **optional bundled subcharts** for ingress-nginx, Traefik, and
cert-manager, all disabled by default. Bring your own ingress controller and
certificate issuer unless you opt in — this keeps default deployments lightweight.

### Ingress-nginx (bundled, optional)

Enable the bundled ingress-nginx subchart to run the NGINX ingress controller
alongside Shipwright:

```yaml
ingress-nginx:
  enabled: true
```

By default, the admission webhook is **disabled** (`controller.admissionWebhooks.enabled=false`)
because it requires a Kubernetes API server reachable at install time — an unsafe
requirement for fresh installs. If your cluster can tolerate it (e.g., you're
upgrading an existing release), enable it:

```yaml
ingress-nginx:
  enabled: true
  controller:
    admissionWebhooks:
      enabled: true
```

**Only one bundled ingress controller is allowed at a time.** Enabling both
ingress-nginx and Traefik together will fail validation:

```yaml
ingress-nginx:
  enabled: true
traefik:
  enabled: true  # ❌ Error: both ingress controllers cannot run simultaneously
```

### Traefik (bundled, optional)

Enable the bundled Traefik subchart to run the Traefik ingress controller:

```yaml
traefik:
  enabled: true
```

This is independent of `networking.ingress.controller=traefik` (which only selects
Traefik-flavored annotations in the chart's `Ingress` manifest). Set **both** to
fully bundle and use Traefik end-to-end:

```yaml
networking:
  type: ingress
  ingress:
    controller: traefik  # Select Traefik annotation style
traefik:
  enabled: true         # Also bundle and run the Traefik controller
```

As with ingress-nginx, enabling Traefik alongside ingress-nginx is not permitted
— validation will reject the render.

### cert-manager (bundled, optional)

Enable the bundled cert-manager subchart to run the cert-manager controller:

```yaml
cert-manager:
  enabled: true
  crds:
    enabled: true   # Install cert-manager's CRDs (v1.15+ convention)
    keep: true      # Keep CRDs on `helm uninstall`
  startupapicheck:
    enabled: true   # Run post-install readiness check
```

The subchart automatically installs cert-manager's CRDs inline (no separate CRD
chart needed per jetstack v1.15+ convention) and runs a startup API check to ensure
the CRDs are ready. When you `helm uninstall`, the CRDs are preserved to avoid
deleting custom resources (Certificates, Issuers, etc.) cluster-wide.

#### CRD-bootstrap hook for bundled cert-manager

When cert-manager is bundled in the **same release** (`cert-manager.enabled=true`)
and `tls.certManager.enabled=true` with a chart-managed `Issuer` and/or `Certificate`
to apply (`tls.certManager.issuer.create=true` or `networking.type=gateway`), the
chart uses a **post-install/post-upgrade bootstrap Job** (CNH-7.1) to apply those
CRs. This is necessary because on first install, cert-manager's CRDs are templates
in this release and do not exist at apply time — an inline `Issuer` or `Certificate`
manifest would fail to apply until cert-manager's webhook is up. The bootstrap Job
waits for cert-manager to be Available, then applies the CRs from a ConfigMap.

A cleanup Job (pre-delete hook) is also rendered by default to delete the applied
CRs on `helm uninstall`, preserving the issued TLS Secret and ACME account Secret
so the next install does not force a fresh ACME order. To disable cleanup on
delete, set `tls.certManager.bootstrap.cleanupOnDelete: false`.

This bootstrap hook is **only** used for the bundled cert-manager path. If you're
using `cert-manager.enabled=false` and bringing your own cert-manager (which has
already had its CRDs installed separately), the chart applies CRs as ordinary inline
manifests.

This is independent of whether you bring your own cert-manager — the bundled
cert-manager subchart is purely the **controller**. The chart's TLS wiring picks up
that controller and uses it. You can run cert-manager elsewhere and leave this
bundled subchart disabled; or enable it here to bring both controller and TLS
wiring up together with no external dependencies.

### All three together (self-contained cloud-native setup)

For a **fully self-contained install** with no external dependencies, enable all
three:

```yaml
ingress-nginx:
  enabled: true
cert-manager:
  enabled: true
  crds:
    enabled: true
    keep: true
  startupapicheck:
    enabled: true
networking:
  type: ingress
admin:
  # Public base URL for OAuth/OIDC redirects. Auto-derived from
  # networking.ingress.host when left empty (https when TLS is on).
  appBaseUrl: ""  # leave empty to auto-derive
tls:
  certManager:
    enabled: true
    issuer:
      create: true
      type: letsencrypt
      # ... issuer config
```

Example value files are provided:
- [`examples/values-cloud-native.yaml`](../charts/shipwright/examples/values-cloud-native.yaml) — production-oriented: bundles ingress-nginx + cert-manager with `letsencrypt-prod`, uses `shipwright.local` with a selfsigned cert, and sets `admin.appBaseUrl: https://shipwright.local:8443` explicitly (could be left empty to auto-derive `https://shipwright.local` instead, since the port is non-default)
- [`examples/values-cloud-native-traefik.yaml`](../charts/shipwright/examples/values-cloud-native-traefik.yaml) — production-oriented: bundles Traefik + cert-manager with `letsencrypt-prod`, uses `shipwright.example.com`, and sets `admin.appBaseUrl: https://shipwright.example.com` explicitly (equivalent to leaving it empty and letting the chart auto-derive)

**Note:** the Minikube task `task minikube:cloud-native` and `task minikube:cloud-native:traefik` use simplified versions (`charts/shipwright/examples/values-minikube-cloud-native-nginx.yaml` and `charts/shipwright/examples/values-minikube-cloud-native-traefik.yaml`) tuned for local development with self-signed certs and without OAuth/OIDC setup — see [Minikube (local)](./deploy-kubernetes-providers.md#minikube-local) in the provider guides for details.

---

## See also

- [`deploy-kubernetes.md`](./deploy-kubernetes.md) — core deploy concerns: networking model, cloud provider guides, agent runtime provisioning, and authentication modes.
- [`helm-repo.md`](./helm-repo.md) — installing from the published Helm repo and how publishing is triggered.
- [`charts/shipwright/README.md`](../charts/shipwright/README.md) — the chart's own README: full values table, versioning, and the Bitnami fallback.
- [`configuration.md`](./configuration.md) — every env var, including the voice and Web Push vars.
