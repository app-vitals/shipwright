# Changelog

All notable changes to the **shipwright** Helm chart are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this chart adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The chart `version` (in `Chart.yaml`) is bumped on **every** chart change,
independent of `appVersion`. CI enforces this with
`ct lint --check-version-increment`. Each release here must mirror the
`artifacthub.io/changes` annotation in `Chart.yaml`.

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
