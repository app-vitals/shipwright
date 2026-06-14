# shipwright Helm chart

Deploys **Shipwright Harness** — the open-source autonomous delivery agent for
Claude Code — onto Kubernetes. The chart packages the three Shipwright services
(admin, metrics, agent) and an optional bundled PostgreSQL dependency, with
Minikube-friendly defaults.

> **Scope note (HD-2.1):** this is the chart *skeleton* — the values surface,
> helpers, NOTES, and the PostgreSQL dependency. The shipwright service workload
> templates (Deployments/Services for admin/metrics/agent) land in a later task
> (HD-3.x). With default values, `helm template` renders the PostgreSQL subchart
> and NOTES only; no shipwright workloads yet.

License: **MIT**.

## Versioning

This chart follows [Semantic Versioning](https://semver.org). The chart
`version` in `Chart.yaml` is bumped on **every** chart change, independent of
`appVersion` (which tracks the Shipwright application release the chart deploys
by default).

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
| `admin.image.repository` | `shipwright-admin` | Admin image repo. |
| `admin.image.tag` | `""` | Admin image tag (defaults to chart `appVersion`). |
| `admin.service.port` | `3001` | Admin service port. |
| `admin.replicas` | `1` | Admin replica count. |
| `metrics.enabled` | `true` | Toggle the metrics dashboard (port **3460**). |
| `metrics.image.repository` | `shipwright-metrics` | Metrics image repo. |
| `metrics.image.tag` | `""` | Metrics image tag (defaults to chart `appVersion`). |
| `metrics.service.port` | `3460` | Metrics service port. |
| `metrics.replicas` | `1` | Metrics replica count. |
| `agent.enabled` | `true` | Toggle the agent service (port **3000**). |
| `agent.image.repository` | `shipwright-agent` | Agent image repo. |
| `agent.image.tag` | `""` | Agent image tag (defaults to chart `appVersion`). |
| `agent.service.port` | `3000` | Agent service port. |
| `agent.replicas` | `1` | Agent replica count. |
| `agent.provisioning.persistence.enabled` | `true` | Create a PVC for the agent home (`AGENT_HOME`). |
| `agent.provisioning.persistence.size` | `2Gi` | Agent PVC size. |
| `agent.provisioning.persistence.storageClass` | `""` | Agent PVC StorageClass (cluster default if empty). |
| `agent.provisioning.homePath` | `/data/agent-home` | Mount path for the agent persistent home. |
| `auth.mode` | `none` | Auth gate: `none` (dev/Minikube) \| `session` \| `bearer`. |
| `postgresql.enabled` | `true` | Deploy the bundled Bitnami PostgreSQL subchart. |
| `postgresql.image.registry` | `docker.io` | PostgreSQL image registry (repoint to a mirror — see below). |
| `postgresql.image.repository` | `bitnami/postgresql` | PostgreSQL image repository. |
| `postgresql.auth.database` | `shipwright_admin` | Default database created on first boot. |
| `postgresql.auth.username` | `shipwright` | Default application user. |
| `postgresql.auth.password` | `shipwright` | Default password — **change for any non-throwaway env**, or use `existingSecret`. |
| `postgresql.auth.existingSecret` | `""` | Source DB credentials from a pre-created Secret. |
| `postgresql.primary.persistence.enabled` | `true` | Toggle PostgreSQL persistence (set `false` for ephemeral Minikube). |
| `postgresql.primary.persistence.size` | `1Gi` | PostgreSQL PVC size. |
| `postgresql.primary.resources` | `100m/128Mi → 500m/512Mi` | Modest Minikube-friendly resource requests/limits. |

The full values surface is validated by `values.schema.json` (enums for
`networking.type`, `auth.mode`, and image pull policies; required service shapes).

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

**Why this specific pin?** In **2025 Bitnami changed their catalog and registry.**
Many image tags were moved to a `bitnamilegacy` repository, and the newest
secure/hardened images moved behind **Bitnami Secure** (newer chart lines ship a
default `image.tag: latest` that no longer resolves to a concrete public tag).
Chart `16.7.27` is pinned because its **default image tag is concrete**
(`17.6.0-debian-12-r4`), not `latest`, so it renders deterministically.

**If the default Bitnami registry tags disappear**, repoint the images without
changing the chart — pick one:

1. **Mirror the whole stack** in one place:

   ```yaml
   global:
     imageRegistry: <your-mirror-registry>
   ```

2. **Use the `bitnamilegacy` mirror** for the PostgreSQL image specifically:

   ```yaml
   postgresql:
     image:
       registry: docker.io
       repository: bitnamilegacy/postgresql
       tag: 17.6.0-debian-12-r4
   ```

3. **Bring your own PostgreSQL** — disable the subchart entirely and point the
   admin service at an external database:

   ```yaml
   postgresql:
     enabled: false
   # then provide DATABASE_URL_SHIPWRIGHT_ADMIN out-of-band
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
