# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.1] - 2026-06-17

### Chart — What's New

#### Helm Chart (`charts/shipwright`)

- **Agent voice (STT/TTS)** (`agent.voice.*`): make agent speech-to-text / text-to-speech a deploy-time option. Set `agent.voice.enabled=true` to wire voice. `agent.voice.provider=whisper` (default) renders a self-hosted Whisper ASR `Deployment` + `Service` (`onerahmet/openai-whisper-asr-webservice`, `POST /asr`) and injects `WHISPER_SERVICE_URL` + the ElevenLabs TTS vars into the admin Deployment, which the admin provisioner (`buildProvisioner` → `buildAgentManifest`) flows into every provisioned agent pod. `agent.voice.provider=groq` flows `GROQ_API_KEY` for STT via a chart-managed voice `Secret` with no Whisper pod. ElevenLabs (`agent.voice.elevenlabs.apiKey` / `.voiceId`) and Groq (`agent.voice.groq.apiKey`) keys live in the voice Secret and are sourced via `secretKeyRef`. **Default: off** — no Whisper pod/Service/Secret renders and provisioned-agent env is unchanged (the 3 base vars).

#### Agent (`agent/`)

- **Whisper ASR contract alignment**: the agent's self-hosted Whisper client (`makeWhisperSvcClient`) now targets the `onerahmet/openai-whisper-asr-webservice` contract — `POST /asr?encode=true&task=transcribe&output=txt` with the audio in the `audio_file` multipart field and a plain-text response body — instead of a JSON `POST /transcribe`. This resolves the image-vs-client contract gap so the shipped Whisper pod and the agent agree.

## [1.2.0] - 2026-06-16

### Chart — What's New

#### Helm Chart (`charts/shipwright`)

- **Google OAuth bring-your-own Secret** (`auth.google.existingSecret`): source `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` from a caller-managed Secret instead of inline Helm values. The chart-managed admin Secret omits these keys when the knob is set; the Deployment sources them via `secretKeyRef`. Allows fully secret-free helm installs when combined with `admin.encryptionKeys.existingSecret`.

## [chart-1.0.0] - 2026-06-14

### Chart — What's New

#### Helm Chart (`charts/shipwright`)

- **Admin bring-your-own Postgres** (`externalDatabase.*`): point `externalDatabase.existingSecret` at a pre-created Secret holding `DATABASE_URL_SHIPWRIGHT_ADMIN` and set `postgresql.enabled=false` to wire an external Cloud SQL (or any Postgres) instance to the admin service. The chart does not manage the Secret — you create and rotate it. Default: off.

- **Cloud SQL Proxy sidecar** (`cloudSqlProxy.*`): set `cloudSqlProxy.enabled=true` and supply a `connectionName` to inject a `cloud-sql-proxy v2` sidecar into the admin pod. The proxy listens on `127.0.0.1:5432` with `--private-ip`, making a Private IP Cloud SQL instance reachable at localhost. Image defaults to `gcr.io/cloud-sql-connectors/cloud-sql-proxy:2`; runs non-root. Default: off.

- **PostHog metrics provider** (`metrics.provider.*`): configure the metrics service to send data to PostHog via `metrics.provider.type=posthog` and `metrics.provider.existingSecret` (holding `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_PROJECT_ID`). Also surfaces `METRICS_ADMIN_URL`, `METRICS_BASE_PATH`, `METRICS_REQUIRE_OWNER_ROLE`, and `METRICS_INTERNAL_API_KEY` environment controls. Default: bundled PostHog/SQLite behavior unchanged.

- **Gateway API networking** (`networking.type=gateway`): renders a `gateway.networking.k8s.io/v1` Gateway and HTTPRoutes instead of an Ingress, routing admin UI/API at `/` and the metrics dashboard at `/dashboard`. Mutually exclusive with `networking.type=ingress`. Requires Gateway API CRDs (and a controller for the chosen class) in the cluster.

- **cert-manager Certificate** (`tls.certManager.*`): setting `tls.certManager.enabled=true` renders a `cert-manager.io/v1` Certificate for `networking.gateway.host` wired to a configurable `issuerRef` (name + kind, kind defaults to `ClusterIssuer`). When enabled, the Gateway adds an HTTPS (`:443`) listener referencing the issued Secret. Disabled by default.

- **Agent-provisioning RBAC** (`agent.provisioning.enabled`): when enabled (default `false`), the chart renders a namespace-scoped Role, RoleBinding, and agent ServiceAccount, plus the full provisioner env contract in the admin Deployment (`SHIPWRIGHT_K8S_PROVISIONING`, `SHIPWRIGHT_K8S_NAMESPACE`, `SHIPWRIGHT_AGENT_IMAGE`, `SHIPWRIGHT_AGENT_IMAGE_TAG`, `SHIPWRIGHT_AGENT_REPLICAS`, `SHIPWRIGHT_API_URL`, `SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME`). Nothing is rendered and the admin service stays in Noop mode when disabled.

### Chart — How to Install

```bash
helm repo add shipwright https://app-vitals.github.io/shipwright
helm repo update
helm install shipwright shipwright/shipwright
```

**Note:** If GitHub Pages is not yet enabled (first-time setup), install directly from the GitHub Release tarball:

```bash
helm install shipwright https://github.com/app-vitals/shipwright/releases/download/shipwright-1.0.0/shipwright-1.0.0.tgz
```

## [0.1.0] - 2026-06-06

### Features

- repo scaffold — Bun workspaces, Taskfile, Biome config

### Bug Fixes

- add bun-types and placeholder src files so typecheck passes

### Documentation

- add docs/test-readiness/test-system.md
