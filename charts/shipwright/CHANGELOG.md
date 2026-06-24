# Changelog

All notable changes to the **shipwright** Helm chart are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this chart adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The chart `version` (in `Chart.yaml`) is bumped on **every** chart change,
independent of `appVersion`. CI enforces this with
`ct lint --check-version-increment`. Each release here must mirror the
`artifacthub.io/changes` annotation in `Chart.yaml`.

## [1.6.29] - 2026-06-24

### Changed

- auto-bump to chart v1.6.29 triggered by release tag `admin-v0.87.0`

## [1.6.28] - 2026-06-24

### Changed

- auto-bump to chart v1.6.28 triggered by release tag `agent-v0.68.1`

## [1.6.27] - 2026-06-24

### Changed

- auto-bump to chart v1.6.27 triggered by release tag `admin-v0.86.0`

## [1.6.26] - 2026-06-24

### Changed

- auto-bump to chart v1.6.26 triggered by release tag `agent-v0.67.1`

## [1.6.25] - 2026-06-24

### Changed

- auto-bump to chart v1.6.25 triggered by release tag `agent-v0.67.0`

## [1.6.24] - 2026-06-24

### Changed

- Replace chart-releaser with direct gh-pages packaging for Helm chart releases (REL-2.2)

## [1.6.23] - 2026-06-24

### Changed

- auto-bump to chart v1.6.23 triggered by release tag `metrics-v0.81.0`

## [1.6.22] - 2026-06-24

### Changed

- Add bare platform-name banned-string patterns and exclude planning dir from check-strings

## [1.6.21] - 2026-06-24

### Changed

- auto-bump to chart v1.6.21 triggered by release tag `agent-v0.65.0`

## [1.6.20] - 2026-06-24

### Changed

- auto-bump to chart v1.6.20 triggered by release tag `task-store-v0.4.0`

## [1.6.19] - 2026-06-24

### Changed

- auto-bump to chart v1.6.19 triggered by release tag `admin-v0.84.0`

## [1.6.18] - 2026-06-24

### Changed

- auto-bump to chart v1.6.18 triggered by release tag `admin-v0.83.1`

## [1.6.17] - 2026-06-24

### Changed

- auto-bump to chart v1.6.17 triggered by release tag `agent-v0.64.1`

## [1.6.16] - 2026-06-24

### Changed

- auto-bump to chart v1.6.16 triggered by release tag `task-store-v0.3.0`

## [1.6.14] - 2026-06-24

### Fixed

- agent-provisioner RBAC: grant `patch`/`update` on Deployments (apps) so the
  reconcile path can strategic-merge-patch existing agent Deployments. Without
  these verbs, `POST /agents/reconcile` returned 200 but every agent failed with
  `cannot patch resource "deployments"` from the K8s API (SHI-1.3).

## [1.6.13] - 2026-06-24

### Changed

- auto-bump to chart v1.6.13 triggered by release tag `agent-v0.63.0`

## [1.6.12] - 2026-06-23

### Changed

- image-update detection and patching in reconcile (SHI-1.3)
- restore dispatch pipeline broken by #633

## [1.6.11] - 2026-06-23

### Added

- task-store HTTP adapter in the shipwright plugin; drop GitHub and Jira backends (TSS-2.1)

## [1.6.10] - 2026-06-23

### Changed

- auto-bump to chart v1.6.10 triggered by release tag `admin-v0.80.0`

## [1.6.9] - 2026-06-23

### Removed

- Deleted internal CI install-test config (no longer ships).
- Scrubbed all internal platform references from chart templates, tests, CHANGELOG, and docs; replaced with generic placeholders.

## [1.6.8] - 2026-06-23

### Changed

- auto-bump to chart v1.6.8 triggered by release tag `agent-v0.61.0`

## [1.6.7] - 2026-06-23

### Changed

- auto-bump to chart v1.6.7 triggered by release tag `admin-v0.79.1`

## [1.6.6] - 2026-06-23

### Changed

- Remove `ownerReferences` from provisioned agent Deployments, Secrets, and PVCs — ineffective cross-namespace and unsafe same-namespace (cascade-deletes all agents on admin uninstall)
- Align provisioned agent Deployment spec with Helm-managed agents: `strategy: Recreate`, `terminationGracePeriodSeconds: 120`, `readinessProbe`, `AGENT_HOME` env var, `fsGroupChangePolicy: OnRootMismatch`, `failureThreshold: 3` on liveness probe, `containerPort` declaration

## [1.6.5] - 2026-06-23

### Changed

- auto-bump to chart v1.6.5 triggered by release tag `admin-v0.79.0`

## [1.6.4] - 2026-06-22

### Added

- wire full manifest through provisioner for proper PVC mounts

## [1.6.3] - 2026-06-23

### Fixed

- bump chart version to 1.6.3 to resolve duplicate 1.6.2 release tag conflict

## [1.6.2] - 2026-06-23

### Changed

- auto-bump to chart v1.6.2 triggered by release tag `metrics-v0.79.0`

## [1.5.29] - 2026-06-22

### Changed

- auto-bump to chart v1.5.29 triggered by release tag `agent-v0.60.0`

## [1.5.28] - 2026-06-22

### Changed

- auto-bump to chart v1.5.28 triggered by release tag `agent-v0.59.0`

## [1.5.27] - 2026-06-20

### Changed

- auto-bump to chart v1.5.27 triggered by release tag `admin-v0.76.0`

## [1.5.26] - 2026-06-20

### Changed

- `agent.provisioning.pvcNameTemplate`: pass slug to provisioner callback as second arg; fallback to sanitized resource name when slug is absent; add console.warn when pvcNameTemplate is active and reconcile re-provisions without a slug

## [1.5.25] - 2026-06-20

### Changed

- auto-bump to chart v1.5.25 triggered by release tag `admin-v0.75.0`

## [1.5.24] - 2026-06-20

### Added

- `agent.provisioning.pvcNameTemplate`: optional PVC name template for provisioned agent home directories; `{name}` is replaced with the agent slug at provision time

## [1.5.23] - 2026-06-20

### Changed

- auto-bump to chart v1.5.23 triggered by release tag `agent-v0.57.0`

## [1.5.22] - 2026-06-19

### Changed

- auto-bump to chart v1.5.22 triggered by release tag `admin-v0.74.1`

## [1.5.21] - 2026-06-19

### Changed

- auto-bump to chart v1.5.21 triggered by release tag `admin-v0.74.0`

## [1.5.20] - 2026-06-19

### Changed

- auto-bump to chart v1.5.20 triggered by release tag `agent-v0.56.0`

## [1.5.19] - 2026-06-19

### Changed

- auto-bump to chart v1.5.19 triggered by release tag `metrics-v0.77.0`

## [1.5.18] - 2026-06-19

### Changed

- auto-bump to chart v1.5.18 triggered by release tag `admin-v0.72.0`

## [1.5.17] - 2026-06-19

### Changed

- auto-bump to chart v1.5.17 triggered by release tag `admin-v0.71.0`

## [1.5.16] - 2026-06-19

### Changed

- auto-bump to chart v1.5.16 triggered by release tag `metrics-v0.76.0`

## [1.5.15] - 2026-06-19

### Changed

- auto-bump to chart v1.5.15 triggered by release tag `agent-v0.53.1`

## [1.5.14] - 2026-06-19

### Changed

- auto-bump to chart v1.5.14 triggered by release tag `admin-v0.69.1`

## [1.5.13] - 2026-06-18

### Changed

- auto-bump to chart v1.5.13 triggered by release tag `admin-v0.69.0`

## [1.5.12] - 2026-06-18

### Changed

- auto-bump to chart v1.5.12 triggered by release tag `metrics-v0.75.0`

## [1.5.10] - 2026-06-18

### Changed

- auto-bump to chart v1.5.10 triggered by release tag `metrics-v0.74.14`

## [1.5.9] - 2026-06-18

### Changed

- auto-bump to chart v1.5.9 triggered by release tag `metrics-v0.74.12`

## [1.5.8] - 2026-06-18

### Changed

- auto-bump to chart v1.5.8 triggered by release tag `agent-v0.52.11`

## [1.5.7] - 2026-06-18

### Changed

- auto-bump to chart v1.5.7 triggered by release tag `agent-v0.52.10`

## [1.5.6] - 2026-06-18

### Changed

- auto-bump to chart v1.5.6 triggered by release tag `metrics-v0.74.7`

## [1.5.5] - 2026-06-18

### Changed

- auto-bump to chart v1.5.5 triggered by release tag `metrics-v0.74.6`

## [1.5.4] - 2026-06-18

### Changed

- auto-bump to chart v1.5.4 triggered by release tag `agent-v0.52.5`

## [1.5.3] - 2026-06-18

### Changed

- auto-bump to chart v1.5.3 triggered by release tag `admin-v0.68.4`

## [1.5.2] - 2026-06-18

### Changed

- auto-bump to chart v1.5.2 triggered by release tag `metrics-v0.74.2`

## [1.5.0]

### Added

- `agent-provisioning-rbac`: added a `persistentvolumeclaims` rule (`create`/`get`/`delete`) to the `agent-provisioner` Role, giving the provisioner the permissions it needs to manage workspace PVCs alongside Deployments and Secrets. Additive — no existing rules changed.

## [1.4.0]

### Added

- `agent.voice` block: agent voice (STT/TTS) as a deploy-time chart option. Disabled by default (`agent.voice.enabled=false`) — no Whisper pod/Service, no voice Secret, and the admin Deployment carries no voice env (provisioned agent pods keep their 3 base vars). When enabled:
  - `agent.voice.provider=whisper` renders a self-hosted Whisper ASR `Deployment` + `Service` (`templates/whisper-deployment.yaml`, `templates/whisper-service.yaml`) running `onerahmet/openai-whisper-asr-webservice:v1.3.0` — pinned to a concrete tag so `helm upgrade` cannot silently break the `POST /asr?task=transcribe&output=txt` plain-text contract the agent's whisper client targets. The in-cluster Service URL is injected into the admin Deployment as `WHISPER_SERVICE_URL` and flowed to provisioned agent pods by the admin provisioner.
  - `agent.voice.provider=groq` flows `GROQ_API_KEY` via the chart-managed voice Secret (`templates/voice-secret.yaml`) with no Whisper pod.
  - ElevenLabs TTS applies to both providers: `agent.voice.elevenlabs.apiKey` is stored in the voice Secret and injected as `ELEVENLABS_API_KEY`; the optional `agent.voice.elevenlabs.voiceId` is injected as the plain-value `ELEVENLABS_VOICE_ID`.
  - New values: `agent.voice.{enabled, provider, whisper.{image, service.port, resources}, elevenlabs.{apiKey, voiceId}, groq.apiKey}`, with matching `values.schema.json` constraints (`provider` enum `whisper | groq`).

## [1.3.0]

### Added

- `metrics.sessionSecret.existingSecret`: source the metrics service's `SHIPWRIGHT_SESSION_SECRET` from a caller-managed Secret instead of the chart-generated random. Point it at the same Secret the admin uses (`admin.encryptionKeys.existingSecret`) so admin-minted dashboard session JWTs validate at the metrics service when both sit behind a shared Gateway — a mismatch returns 401 on the dashboard's metrics view. `sessionSecretRef` selects the key within that Secret (defaults to `SHIPWRIGHT_SESSION_SECRET`). When set, the chart-managed metrics Secret omits `SHIPWRIGHT_SESSION_SECRET` and the Deployment injects it via `secretKeyRef` against the caller-managed Secret. Default empty preserves the existing generate-on-install / reuse-on-upgrade behaviour — purely additive.

## [1.2.0]

### Added

- `auth.google.existingSecret`: source `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` from a caller-managed Secret instead of inline Helm values. The chart-managed admin Secret omits these keys when the knob is set; the Deployment sources them via `secretKeyRef`. Allows fully secret-free helm installs when combined with `admin.encryptionKeys.existingSecret`.

## [1.1.0]

### Added

- `admin.encryptionKeys` block: source `SHIPWRIGHT_ENCRYPTION_KEY` and `SHIPWRIGHT_SESSION_SECRET` from a pre-existing Secret instead of generating random values on a fresh namespace install. Set `admin.encryptionKeys.existingSecret` to the Secret name; `encryptionKeyRef` and `sessionSecretRef` select the keys within it (default to the env var names). When set, the chart-managed Secret omits these two keys entirely and the Deployment injects them via `secretKeyRef` against the caller-managed Secret. Default is empty — existing generate-on-install / reuse-on-upgrade behaviour is unchanged.
- `admin.appBaseUrl`: sets `SHIPWRIGHT_ADMIN_APP_BASE_URL` in the admin container env when non-empty. Required when the admin service is behind a Gateway or Ingress so that OAuth redirect URIs reference the real public host rather than `localhost:3001`. Omitted from the env when left empty (default).
- `admin.extraEnv`: list of Kubernetes `envVar` objects appended to the admin container env. Provides a generic passthrough for env vars not otherwise covered by chart values. Defaults to `[]` (no extra vars).
- `networking.gateway.healthCheckPolicy.enabled`: when `true` and `networking.type=gateway`, renders a `networking.gke.io/v1 HealthCheckPolicy` for the admin Service and (when `metrics.enabled=true`) a second one for the metrics Service, both probing `/health` with 15 s interval / 5 s timeout / 1 healthy / 2 unhealthy thresholds. Without this the GKE Gateway controller default-probes `"/"` (both services → 404) and marks the backends UNHEALTHY, returning 503 on the external host. Disabled by default (`false`) so non-GKE Gateway installs are unaffected.

## [1.0.0]

_First publicly published chart version. New features in this release: externalDatabase and cloudSqlProxy (SWD-1.x). Gateway API networking, cert-manager Certificate, agent-provisioning RBAC, and metrics.provider were shipped in 0.9.0/0.9.1._

### Added

- `externalDatabase` block: bring-your-own-Postgres for the admin service. Set `postgresql.enabled=false` and `externalDatabase.existingSecret` to inject `DATABASE_URL_SHIPWRIGHT_ADMIN` from a user-managed Secret via `secretKeyRef`. The optional `externalDatabase.adminUrlKey` overrides the key name within that Secret (defaults to `DATABASE_URL_SHIPWRIGHT_ADMIN` when empty). When this path is active, the chart-managed admin Secret assembles no DB URL (no duplicate env injection). Bundled-PostgreSQL path is unchanged — this is purely additive.
- `cloudSqlProxy` sidecar: when `cloudSqlProxy.enabled=true`, a GCP Cloud SQL Auth Proxy container is injected alongside the admin container in the admin Deployment, making a Cloud SQL instance reachable at `127.0.0.1:5432`. Disabled by default (`enabled: false`). When enabled, the proxy runs with `--private-ip` and the required `cloudSqlProxy.connectionName` argument. Additional proxy arguments are configurable via `cloudSqlProxy.args`; resource limits via `cloudSqlProxy.resources`. The sidecar is purely additive — the existing admin Deployment is unchanged when the feature is off.

## [0.9.1]

### Added

- `metrics.provider` block: configurable PostHog provider (`posthog.existingSecret`, `posthog.personalApiKeyRef`, `posthog.projectIdRef`) for POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID injection via `secretKeyRef`, plus `adminUrl` (METRICS_ADMIN_URL), `basePath` (METRICS_BASE_PATH), `requireOwnerRole` (METRICS_REQUIRE_OWNER_ROLE), and `internalKey.existingSecret` / `internalKey.key` (METRICS_INTERNAL_API_KEY). All fields default to empty/false — existing `SHIPWRIGHT_SESSION_SECRET` and bundled-PG `METRICS_DATABASE_URL` paths are unchanged (additive, gated).

## [0.9.0]

### Added

- Gateway API networking. Setting `networking.type=gateway` renders a
  `gateway.networking.k8s.io/v1` `Gateway` (`templates/gateway.yaml`) and
  `HTTPRoute`(s) (`templates/httproute.yaml`) instead of an Ingress. The Gateway
  binds to a configurable `gatewayClassName` (`networking.gateway.gatewayClassName`,
  default `gke-l7-global-external-managed`) and `host`
  (`networking.gateway.host`, default `shipwright.local`), with a plain HTTP
  listener on `:80`. HTTPRoutes attach via `parentRefs` and route the admin
  UI/API at `/` to the admin Service and the metrics dashboard at `/dashboard`
  to the metrics Service (the `/dashboard` route is omitted when
  `metrics.enabled=false`). Mutually exclusive with `networking.type=ingress`:
  `gateway` renders Gateway+HTTPRoute and NO Ingress, `ingress` renders Ingress
  and NO Gateway/HTTPRoute. Requires the Gateway API CRDs (and a controller for
  the chosen class) in the cluster.
- Optional cert-manager Certificate. Setting `tls.certManager.enabled=true`
  renders a `cert-manager.io/v1` `Certificate` (`templates/certificate.yaml`)
  for `networking.gateway.host`, wired to an `issuerRef`
  (`tls.certManager.issuerRef.{name,kind}`, kind default `ClusterIssuer`). When
  enabled, the Gateway also adds an HTTPS (`:443`) listener referencing the
  issued Secret (`<fullname>-tls`). Disabled by default (Minikube = plain HTTP);
  disabled → no Certificate is rendered.
- `networking.gateway.{gatewayClassName,host,annotations}` and
  `tls.certManager.{enabled,issuerRef.{name,kind}}` values surface, with matching
  `values.schema.json` constraints (`gateway` added to the `networking.type`
  enum; the `certManager` block requires a non-empty `issuerRef.name` when
  enabled).
- Example values file `examples/values-gke-gateway.yaml` demonstrating the full
  `networking.type=gateway` + `tls.certManager.enabled=true` configuration for a
  real GKE cluster (NOT a ct-discovered `ci/` variant, since the kind e2e cluster
  has no Gateway API / cert-manager CRDs).
- Agent-provisioning RBAC + admin env contract, gated on
  `agent.provisioning.enabled` (default **false** → nothing is rendered and the
  admin service stays in **Noop** mode, requiring no cluster access). When
  enabled, the chart renders:
  - A **namespace-scoped** `Role` (`templates/agent-provisioning-rbac.yaml`) —
    NOT a `ClusterRole` — granting least-privilege verbs `create`, `get`,
    `delete` on `apps`/`Deployments` and core (`""`)/`Secrets`: exactly
    the verbs the provisioner (`KubernetesAgentProvisioner`) exercises.
  - A `RoleBinding` binding that Role to the admin `ServiceAccount`.
  - A separate **agent** `ServiceAccount`
    (`templates/agent-serviceaccount.yaml`,
    `agent.provisioning.serviceAccount.{create,name,annotations}`) that
    provisioned agent pods run as — distinct from the admin SA.
  - The provisioner **env contract** injected into the admin Deployment,
    matching `admin/src/main.ts` `buildProvisioner` exactly:
    `SHIPWRIGHT_K8S_PROVISIONING=enabled`, `SHIPWRIGHT_K8S_NAMESPACE` (via the
    **downward API**, `fieldRef: metadata.namespace`), `SHIPWRIGHT_AGENT_IMAGE`
    + `SHIPWRIGHT_AGENT_IMAGE_TAG` (tag defaults to `.Chart.AppVersion`),
    `SHIPWRIGHT_AGENT_REPLICAS`, `SHIPWRIGHT_API_URL` (built from the admin
    Service name + port, or `agent.provisioning.apiUrl`), and
    `SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME`. `SHIPWRIGHT_ADMIN_DEPLOYMENT_UID` is
    injected ONLY when `agent.provisioning.adminDeploymentUid` is set — the
    downward API cannot expose the parent Deployment's UID to its pods, so a
    missing UID is acceptable (ownerRef propagation is a separate follow-up) and
    no wrong value is fabricated.
  - New values: `agent.provisioning.{enabled, image.{repository,tag}, replicas,
    serviceAccount.{create,name,annotations}, apiUrl, adminDeploymentUid,
    pvc.{size,storageClass}}` (provisioning OFF by default). The `pvc` settings
    are surfaced for the agent manifest builder's future use and are NOT injected
    as env (not read by `buildProvisioner`).

## [0.6.0]

### Added

- Ingress networking. Setting `networking.type=ingress` renders a
  `networking.k8s.io/v1` `Ingress` (`templates/ingress.yaml`) with a configurable
  `ingressClassName` (`networking.ingress.className`, default `nginx`), `host`
  (`networking.ingress.host`, default `shipwright.local`), and controller-specific
  `annotations` (`networking.ingress.annotations`, default `{}`). Rules route the
  admin UI/API at `/` to the admin Service and the metrics dashboard at `/dashboard`
  to the metrics Service (`pathType: Prefix`). The `/dashboard` path is omitted when
  `metrics.enabled=false`. No Ingress is rendered for any other `networking.type`
  (the default stays `ClusterIP`, so the Ingress is OFF by default).
- Helm test connection hook (`templates/tests/test-connection.yaml`). A
  `helm.sh/hook: test` Pod using the public, pinned `curlimages/curl` image curls
  the admin Service `/health` (must return 200) and, when `metrics.enabled`, the
  metrics Service `/dashboard` (accepts 200 or 302), exiting non-zero on failure so
  `helm test` fails loudly. This is the smoke check `ct install` runs in the e2e job.

## [0.5.0]

### Fixed

- Initdb DB name now tracks `metrics.database.name` overrides. The hardcoded
  `shipwright_metrics` string in `postgresql.primary.initdb.scripts` has been
  replaced with a parent-chart ConfigMap (`metrics-initdb-configmap.yaml`)
  rendered via the `shipwright.metrics.databaseName` helper. The Bitnami subchart
  reads the ConfigMap name from `postgresql.primary.initdb.scriptsConfigMap`
  (evaluated through `tpl` at install time using `.Release.Name`). Previously,
  overriding `metrics.database.name` would cause a fresh install to fail because
  the Deployment targeted a database that initdb never created.

## [0.4.0]

### Added

- Metrics service workloads: `metrics-deployment.yaml`, `metrics-service.yaml`,
  and `metrics-serviceaccount.yaml` (container port 3460, liveness/readiness
  probes on the DB-independent `/health`, ServiceAccount, standard
  labels/selectors). The dashboard is served at `/dashboard`.
- Chart-managed metrics `Secret` (`metrics-secret.yaml`) assembling
  `METRICS_DATABASE_URL` for postgres mode so the database password is never
  rendered into plaintext Deployment env. Only rendered when both `metrics.enabled`
  and `postgresql.enabled` are true.
- `METRICS_DATABASE_URL` wired to the bundled Bitnami PostgreSQL subchart in
  postgres mode (`METRICS_OFFLINE=false`, `METRICS_API_PORT=3460`). The metrics
  provider bootstraps its own `events` table on boot — no separate migration job.
- `metrics.service.type`, `metrics.serviceAccount.{create,name,annotations}`,
  `metrics.resources`, and `metrics.database.name` values surface, with matching
  `values.schema.json` constraints. `metrics.database.name` empty reuses the
  bundled PostgreSQL database (no collision with the admin Prisma tables); set it
  to isolate metrics data in a separate database.
- CI: the `helm-e2e` workflow now builds and side-loads the `shipwright-metrics`
  image into kind so `ct install` schedules the real metrics workload.

## [0.3.0]

### Added

- Admin service workloads: `admin-deployment.yaml`, `admin-service.yaml`, and
  `admin-serviceaccount.yaml` (container port 3001, liveness/readiness probes on
  `/health`, ServiceAccount, standard labels/selectors).
- Chart-managed admin `Secret` (`admin-secret.yaml`) holding
  `SHIPWRIGHT_SESSION_SECRET` and `SHIPWRIGHT_ENCRYPTION_KEY`, generated with the
  lookup-then-`randAlphaNum` idiom so they survive `helm upgrade`.
- `DATABASE_URL_SHIPWRIGHT_ADMIN` wired to the bundled Bitnami PostgreSQL
  subchart. The URL is assembled in the admin Secret so the database password is
  never rendered into plaintext Deployment env.
- Auth modes for the admin service: `open` (dev auth via `ADMIN_DEV_AUTH=true`,
  **insecure — no real authentication**) and `google` (Google OAuth with
  `NODE_ENV=production`, `GOOGLE_CLIENT_ID/SECRET`, and
  `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS`).
- `admin.service.type`, `admin.serviceAccount.{create,name,annotations}`,
  `admin.resources`, and the `auth.google.{clientId,clientSecret,allowedEmails}`
  values surface, with matching `values.schema.json` constraints.

### Changed

- `auth.mode` enum is now `open | google` (was `none | session | bearer`); the
  default is `open`. NOTES.txt warns loudly when `auth.mode=open`.
  **Migration:** existing installs with `auth.mode: none` should run
  `helm upgrade --set auth.mode=open` or add `auth.mode: open` to their values
  file. The value `none` is retained as a deprecated alias for `open` and will
  be removed in a future release.
- CI values variants (`ci/*-values.yaml`) updated to the new auth modes (gke
  exercises `google`, minikube/eks exercise `open`).

## [0.2.0]

### Added

- `CHANGELOG.md` (keep-a-changelog) documenting chart versions.
- `artifacthub.io/changes` annotation in `Chart.yaml` mirroring this changelog.
- `ct` version-increment CI gate (`ct lint --check-version-increment`) wired into
  the Helm workflow — any PR touching `charts/shipwright/**` that does not bump
  the chart `version` now fails CI.

### Changed

- Documented the chart versioning discipline in the chart `README.md`
  ("Versioning" section) and `CONTRIBUTING.md`.

## [0.1.0]

### Added

- Initial chart scaffold: values surface, helpers, NOTES, `values.schema.json`,
  and the pinned Bitnami PostgreSQL dependency (HD-2.1).
- Helm test harness: `task helm:*` targets, helm-unittest specs, and the
  kind-based `ct install` CI workflow (HD-2.2).
