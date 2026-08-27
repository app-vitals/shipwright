# shipwright Helm chart

Deploys **Shipwright Harness** — the open-source autonomous delivery agent for
Claude Code — onto Kubernetes. The chart packages the Shipwright services
(admin, metrics, task-store, chat), runtime agent provisioning, and an optional
bundled PostgreSQL, with Minikube-friendly defaults.

> **Agents are not a Deployment in this chart.** The admin service provisions
> agent workloads at runtime via the Kubernetes API (`agent.provisioning.enabled`),
> so you create agents from the admin console rather than from values.

License: **MIT**.

## Full local stack on Minikube

Brings up admin + metrics + task-store + chat + PostgreSQL + agent provisioning
with **no hand-created Secrets** — the chart assembles every database
connection string itself.

From the repo root:

```bash
task minikube:up      # handles VM sizing, ingress addon, dependency build, rollout waits
task minikube:down    # helm uninstall, then minikube delete
```

Or by hand:

```bash
minikube start --cpus=4 --memory=8192 --disk-size=40g
minikube addons enable ingress
helm dependency build charts/shipwright
helm upgrade --install shipwright charts/shipwright \
  --namespace shipwright --create-namespace \
  -f charts/shipwright/examples/values-minikube.yaml --wait
echo "$(minikube ip) shipwright.local" | sudo tee -a /etc/hosts
```

**Sizing.** The agent pod dominates: 500m CPU / 2Gi memory requests, 8Gi limit.
`--cpus=4 --memory=8192` is the floor for the platform plus one agent;
`--cpus=6 --memory=12288` is comfortable for an agent doing real work. Below
4 CPU / 6Gi the agent pod schedules and then thrashes.

Then create your first agent at `http://shipwright.local/admin/agents/new` and
set its Claude credential (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`)
there — the chart does not provision a deployment-wide credential.

> ⚠️ The Minikube profile sets `auth.mode=open` (no authentication at all) and a
> known literal PostgreSQL password. Local use only.

## Helm Repository

The chart is published to a [GitHub Pages](https://pages.github.com/) Helm repository on every merge to `main` that bumps the `Chart.yaml` version. The [`chart-release.yml`](../../.github/workflows/chart-release.yml) workflow packages the chart and commits the `.tgz` plus a merged `index.yaml` directly to the `gh-pages` branch root — no GitHub Releases are created. See [docs/helm-repo.md](../../docs/helm-repo.md) for the full mechanism.

**Add the repo:**

```bash
helm repo add shipwright https://app-vitals.github.io/shipwright
helm repo update
helm install my-release shipwright/shipwright
```

**GitHub Pages publish path:** On each push to `main` with a chart version bump, `chart-release.yml` packages the chart, merges it into the `gh-pages` `index.yaml` (with `--url https://app-vitals.github.io/shipwright`), and commits the `.tgz` + `index.yaml` to the `gh-pages` root. The `gh-pages` branch must exist and GitHub Pages must be serving from it (**Settings → Pages → gh-pages branch → / (root)**) — see [docs/helm-repo.md](../../docs/helm-repo.md) for the one-time setup.

**Fallback — direct .tgz download:** If the Helm repo is not yet available (before the first release lands), you can install directly from the published `.tgz` on GitHub Pages:

```bash
helm install my-release https://app-vitals.github.io/shipwright/shipwright-1.0.0.tgz
```

## Versioning

This chart follows [Semantic Versioning](https://semver.org). The chart
`version` in `Chart.yaml` is bumped on **every** chart change, independent of
`appVersion`. `appVersion` is not used by the default install — each
service's `image.tag` (`admin`, `metrics`, `agent`, `taskStore`, `chat`) ships
pre-pinned to its own released tag by the
[`auto-bump-chart.yml`](../../.github/workflows/auto-bump-chart.yml) workflow,
so a default install always runs the exact per-service tags pinned at that
chart version with no overrides required. Templates still fall back to
`appVersion` if an `image.tag` override is cleared — `appVersion` is a static
placeholder (`"0.1.0"`), so don't rely on that fallback for a real deploy.

**On any change under `charts/shipwright/**`:**

1. Bump `version` in `Chart.yaml` (patch / minor / major per the nature of the
   change).
2. Add a matching entry to [`CHANGELOG.md`](./CHANGELOG.md) (keep-a-changelog
   style).
3. Mirror that entry in the `artifacthub.io/changes` annotation in `Chart.yaml`.

CI enforces step 1: the Helm workflow runs
`ct lint --check-version-increment`, which fails any PR that modifies the chart
without bumping `version`. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Quick start (Minikube)

```bash
# Resolve the pinned PostgreSQL subchart and write Chart.lock + charts/*.tgz
helm dependency build charts/shipwright

# Lint and preview the rendered manifests with default values
helm lint charts/shipwright
helm template my-release charts/shipwright

# Install
helm install my-release charts/shipwright --namespace shipwright --create-namespace
```

The chart ships **no** default PostgreSQL password: `postgresql.auth.password` is
empty, so the Bitnami subchart auto-generates a random one on install (retrieve it
via the `kubectl get secret ... | base64 -d` command printed in NOTES). A generated
password is **not** stable across `helm upgrade` — for any persistent or production
environment, set `postgresql.auth.existingSecret` to a pre-created Secret (or set
`postgresql.auth.password` explicitly to a value you manage).

## Values

| Key | Default | Description |
|-----|---------|-------------|
| `global.imageRegistry` | `""` | Override the registry for **all** images (chart + subcharts). Point at a mirror if Bitnami's default registry tags disappear. |
| `global.imagePullSecrets` | `[]` | Global image pull secret names. |
| `global.storageClass` | `""` | Global StorageClass for PVCs. |
| `imagePullPolicy` | `IfNotPresent` | Default pull policy for shipwright service images. |
| `nameOverride` / `fullnameOverride` | `""` | Naming overrides. |
| `networking.type` | `ClusterIP` | Service exposure: `ClusterIP` \| `NodePort` \| `LoadBalancer`. ClusterIP is the Minikube-friendly default. |
| `serviceAccount.create` | `true` | Whether to create a ServiceAccount. |
| `serviceAccount.name` | `""` | ServiceAccount name (generated if empty). |
| `serviceAccount.annotations` | `{}` | Annotations for the ServiceAccount. |
| `admin.enabled` | `true` | Toggle the admin service (port **3001**). |
| `admin.image.repository` | `ghcr.io/app-vitals/shipwright-admin` | Admin image repo (fully-qualified GHCR default). |
| `admin.image.tag` | pinned per release | Admin image tag, rewritten on every chart release. |
| `admin.service.port` | `3001` | Admin service port. |
| `admin.replicas` | `1` | Admin replica count. |
| `metrics.enabled` | `true` | Toggle the metrics dashboard (port **3460**). |
| `metrics.image.repository` | `ghcr.io/app-vitals/shipwright-metrics` | Metrics image repo (fully-qualified GHCR default). |
| `metrics.image.tag` | pinned per release | Metrics image tag, rewritten on every chart release. |
| `metrics.service.port` | `3460` | Metrics service port. |
| `metrics.replicas` | `1` | Metrics replica count. |
| `metrics.sessionSecret.existingSecret` | `""` | Source the metrics `SHIPWRIGHT_SESSION_SECRET` from a pre-created Secret. Point at the admin's Secret so admin-minted dashboard JWTs validate (a mismatch 401s the dashboard). Empty = chart-generated. |
| `agent.enabled` | `true` | Toggle the agent service (port **3000**). |
| `agent.image.repository` | `ghcr.io/app-vitals/shipwright-agent` | Agent image repo (fully-qualified GHCR default). |
| `agent.image.tag` | pinned per release | Agent image tag, rewritten on every chart release. |
| `agent.service.port` | `3000` | Agent service port. |
| `agent.replicas` | `1` | Agent replica count. |
| `agent.provisioning.persistence.enabled` | `true` | Create a PVC for the agent home (`AGENT_HOME`). |
| `agent.provisioning.persistence.size` | `2Gi` | Agent PVC size. |
| `agent.provisioning.persistence.storageClass` | `""` | Agent PVC StorageClass (cluster default if empty). |
| `agent.provisioning.homePath` | `/data/agent-home` | Mount path for the agent persistent home. |
| `agent.voice.enabled` | `false` | Master switch for agent voice (STT/TTS). Off = no Whisper pod/Service/Secret and no voice env (provisioned agents keep the 3 base vars). |
| `agent.voice.provider` | `whisper` | STT provider: `whisper` (self-hosted ASR pod) \| `groq` (Groq cloud STT). TTS is Piper (self-hosted, in-image) unless `agent.voice.elevenlabs.apiKey` is set, in which case ElevenLabs is used instead for both providers. |
| `agent.voice.whisper.image` | `onerahmet/openai-whisper-asr-webservice:v1.3.0` | Whisper ASR image (exposes `POST /asr`). Already pinned to a tested tag — do not float to `:latest`. |
| `agent.voice.whisper.service.port` | `9000` | In-cluster Whisper Service port → `WHISPER_SERVICE_URL`. |
| `agent.voice.whisper.model` | `""` | ASR model name → `ASR_MODEL` (e.g. `tiny`, `base`, `small`, `medium`, `large-v3`, `tiny.en`). Empty = no env var set, image default model is used. |
| `agent.voice.whisper.resources` | `{}` | Whisper container resources (empty = no limits). |
| `agent.voice.elevenlabs.apiKey` | `""` | ElevenLabs TTS key → `ELEVENLABS_API_KEY` (voice Secret). Empty = in-pod Piper TTS fallback. |
| `agent.voice.elevenlabs.voiceId` | `""` | Optional ElevenLabs voice id → `ELEVENLABS_VOICE_ID`. |
| `agent.voice.groq.apiKey` | `""` | Groq STT key → `GROQ_API_KEY` (voice Secret); used only when `provider=groq`. |
| `auth.mode` | `open` | Admin auth: `open` (dev auth, **no OAuth — insecure, do not expose publicly**) \| `google` (Google OAuth, `NODE_ENV=production`) \| `okta` (Okta OIDC env plumbing only, `NODE_ENV=production` — **not yet backed by an admin-app login path, see warning below**). One deployment runs exactly one provider at a time. |
| `auth.google.clientId` | `""` | Google OAuth client ID (used when `auth.mode=google`). |
| `auth.google.clientSecret` | `""` | Google OAuth client secret (kept in the chart-managed admin Secret). |
| `auth.google.allowedEmails` | `""` | Comma-separated allow-list of emails permitted to sign in. |
| `auth.okta.issuer` | `""` | Okta OIDC issuer URL, e.g. `https://dev-123456.okta.com` (used when `auth.mode=okta`; chart-only today, see warning below). |
| `auth.okta.clientId` | `""` | Okta OIDC client ID (used when `auth.mode=okta`; chart-only today, see warning below). |
| `auth.okta.clientSecret` | `""` | Okta OIDC client secret (kept in the chart-managed admin Secret). |
| `auth.okta.allowedEmails` | `""` | Comma-separated allow-list of emails permitted to sign in. |

> ⚠️ **`auth.mode=okta` is chart-only today — do not deploy it expecting a working login.**
> This chart wires `OKTA_ISSUER`/`OKTA_CLIENT_ID`/`OKTA_CLIENT_SECRET`/
> `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` into the admin Deployment and sets
> `NODE_ENV=production`, but the admin application (`admin/src/`) has no Okta
> OIDC client implementation yet — only `auth.mode=google` has a working login
> path in the app today. Deploying with `auth.mode=okta` sets
> `NODE_ENV=production` (which blocks the `auth.mode=open` dev-auth escape)
> with no functioning login route, locking you out of the admin UI. Use
> `auth.mode=google` or `auth.mode=open` (non-public only) until Okta app
> support ships.
| `admin.service.type` | `ClusterIP` | Admin Service type. |
| `admin.serviceAccount.create` | `true` | Whether to create the admin ServiceAccount. |
| `admin.serviceAccount.name` | `""` | Admin ServiceAccount name (generated if empty). |
| `admin.resources` | `50m/64Mi → 250m/256Mi` | Admin container resource requests/limits. |
| `postgresql.enabled` | `true` | Deploy the bundled Bitnami PostgreSQL subchart. |
| `postgresql.image.registry` | `docker.io` | PostgreSQL image registry (repoint to a mirror — see below). |
| `postgresql.image.repository` | `bitnamilegacy/postgresql` | PostgreSQL image repository. |
| `postgresql.auth.database` | `shipwright_admin` | Default database created on first boot. |
| `postgresql.auth.username` | `shipwright` | Default application user. |
| `postgresql.auth.password` | `shipwright` | Default password — **change for any non-throwaway env**, or use `existingSecret`. |
| `postgresql.auth.existingSecret` | `""` | Source DB credentials from a pre-created Secret. |
| `postgresql.primary.persistence.enabled` | `true` | Toggle PostgreSQL persistence (set `false` for ephemeral Minikube). |
| `postgresql.primary.persistence.size` | `1Gi` | PostgreSQL PVC size. |
| `postgresql.primary.resources` | `100m/128Mi → 500m/512Mi` | Modest Minikube-friendly resource requests/limits. |
| `ingress-nginx.enabled` | `false` | Deploy the bundled ingress-nginx subchart as the cluster's ingress controller. Mutually exclusive with `traefik.enabled`. |
| `traefik.enabled` | `false` | Deploy the bundled Traefik subchart as the cluster's ingress controller. Mutually exclusive with `ingress-nginx.enabled`. Independent of `networking.ingress.controller: traefik` (set both to fully bundle and use Traefik). |
| `cert-manager.enabled` | `false` | Deploy the bundled cert-manager subchart (controller + CRDs). Pairs with `tls.certManager.enabled` for the chart's own Issuer/Certificate wiring. |

The full values surface is validated by `values.schema.json` (enums for
`networking.type`, `auth.mode`, and image pull policies; required service shapes).

## Cloud-native install (single chart)

For a fully self-contained install with **no pre-existing ingress controller or
cert-manager on the cluster**, bundle all optional subcharts in one release:

```yaml
ingress-nginx:
  enabled: true
cert-manager:
  enabled: true
networking:
  type: ingress
tls:
  certManager:
    enabled: true
    issuer:
      create: true
      type: letsencrypt
```

Swap `ingress-nginx` for `traefik` (and set `networking.ingress.controller:
traefik`) to bundle Traefik instead. See [`docs/deploy-kubernetes.md`](../../docs/deploy-kubernetes.md#cloud-native-any-cluster)
for the full walkthrough and ready-to-use example values files.

> ⚠️ **Do not bundle cert-manager on a cluster that already has it installed.**
> Enabling `cert-manager.enabled=true` when cert-manager is already running
> cluster-wide installs a second copy of its CRDs and controllers, which can
> collide with the existing installation (webhook conflicts, duplicate CRD
> ownership, `helm uninstall` deleting CRDs a different release still needs).
> Leave `cert-manager.enabled=false` and point `tls.certManager.*` at the
> cluster's existing cert-manager instead.

## Dependencies

The chart vendors **four optional subcharts** — each gated by its own
`condition` and off by default except PostgreSQL:

| Subchart | Version | Repository | Condition | Default |
|---|---|---|---|---|
| `postgresql` | `16.7.27` | `oci://registry-1.docker.io/bitnamicharts` | `postgresql.enabled` | **on** |
| `ingress-nginx` | `4.15.1` | `https://kubernetes.github.io/ingress-nginx` | `ingress-nginx.enabled` | off |
| `traefik` | `41.3.0` | `https://traefik.github.io/charts` | `traefik.enabled` | off |
| `cert-manager` | `v1.21.1` | `https://charts.jetstack.io` | `cert-manager.enabled` | off |

`ingress-nginx` and `traefik` are mutually exclusive — enabling both fails the
render (`templates/_validation.tpl`). See [Cloud-native install](#cloud-native-install-single-chart)
above for bundling `cert-manager` alongside either one.

## ⚠️ Bitnami registry risk and image-override / mirror fallback

The bundled PostgreSQL dependency is the **Bitnami `postgresql` subchart**,
pinned to chart version **`16.7.27`** (PostgreSQL app `17.6.0`) via OCI:

```yaml
dependencies:
  - name: postgresql
    version: "16.7.27"
    repository: oci://registry-1.docker.io/bitnamicharts
    condition: postgresql.enabled
```

**Why this specific pin and mirror?** In **2025 Bitnami changed their catalog and registry.**
Many image tags were moved to a `bitnamilegacy` repository, and the newest
secure/hardened images moved behind **Bitnami Secure** (newer chart lines ship a
default `image.tag: latest` that no longer resolves to a concrete public tag).
Chart `16.7.27` is pinned because its **default image tag is concrete**
(`17.6.0-debian-12-r4`), not `latest`, so it renders deterministically.
**The chart now defaults to the `bitnamilegacy` mirror** to ensure a fresh
install pulls successfully from the public registry.

**If you need the standard `bitnami` repository** (e.g., you have Bitnami Secure
access or the legacy mirror is deprecated), override the image explicitly:

```yaml
postgresql:
  image:
    repository: bitnami/postgresql
```

**For other registry scenarios**, pick one of these alternatives:

1. **Mirror the whole stack** in one place:

   ```yaml
   global:
     imageRegistry: <your-mirror-registry>
   ```

2. **Bring your own PostgreSQL** — disable the subchart entirely and point the
   admin service at an external database via the `externalDatabase` block:

   ```yaml
   postgresql:
     enabled: false
   externalDatabase:
     existingSecret: my-db-secret        # Secret you create and manage
     adminUrlKey: DATABASE_URL_SHIPWRIGHT_ADMIN   # key within the Secret (default if omitted)
   ```

   For **GCP Cloud SQL**, add the `cloudSqlProxy` sidecar so the instance is
   reachable at `127.0.0.1:5432` from the admin pod:

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

If `helm dependency build` cannot reach the OCI registry, the classic Bitnami
repo is the documented fallback:

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
# and set repository: "https://charts.bitnami.com/bitnami" in Chart.yaml
```

`Chart.lock` is the committed artifact that records the resolved dependency.

## Regenerating the dependency lock

```bash
helm dependency build charts/shipwright   # reads Chart.lock, fetches charts/*.tgz
helm dependency update charts/shipwright  # re-resolves and rewrites Chart.lock
```
