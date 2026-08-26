{{/*
Expand the name of the chart.
*/}}
{{- define "shipwright.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this
(by the DNS naming spec). If release name contains chart name it will be used as a
full name.
*/}}
{{- define "shipwright.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "shipwright.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "shipwright.labels" -}}
helm.sh/chart: {{ include "shipwright.chart" . }}
{{ include "shipwright.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "shipwright.selectorLabels" -}}
app.kubernetes.io/name: {{ include "shipwright.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use.
*/}}
{{- define "shipwright.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "shipwright.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Assemble a container image reference, applying global.imageRegistry only when it
is safe to do so.

Args: a dict with keys
  - context:    the root "." context (to reach .Values.global.imageRegistry)
  - repository: the image repository (may be bare or fully-qualified)
  - tag:        the image tag

DCC-3.1: the shipwright service repositories default to fully-qualified GHCR
paths (e.g. ghcr.io/app-vitals/shipwright-admin). Blindly prefixing
global.imageRegistry onto those would DOUBLE-prefix them
(registry/ghcr.io/app-vitals/...). Following the standard Helm/OCI community
convention, a repository is treated as already naming a registry host when its
first "/"-delimited segment contains a "." or ":" (e.g. "ghcr.io",
"docker.io", "localhost:5000"). Such fully-qualified repositories are rendered
verbatim; only BARE repository names (e.g. a user-overridden "shipwright-admin")
receive the global.imageRegistry prefix.
*/}}
{{- define "shipwright.imageRef" -}}
{{- $registry := .context.Values.global.imageRegistry -}}
{{- $repository := .repository -}}
{{- $tag := .tag -}}
{{- $firstSegment := $repository | splitList "/" | first -}}
{{- if and $registry (not (or (contains "." $firstSegment) (contains ":" $firstSegment))) -}}
{{- printf "%s/%s:%s" $registry $repository $tag -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end }}

{{/*
Admin component fullname: "<fullname>-admin".
*/}}
{{- define "shipwright.admin.fullname" -}}
{{- printf "%s-admin" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Admin selector labels — fullname selector labels plus the component label.
*/}}
{{- define "shipwright.admin.selectorLabels" -}}
{{ include "shipwright.selectorLabels" . }}
app.kubernetes.io/component: admin
{{- end }}

{{/*
Admin labels — common labels plus the component label.
*/}}
{{- define "shipwright.admin.labels" -}}
{{ include "shipwright.labels" . }}
app.kubernetes.io/component: admin
{{- end }}

{{/*
Name of the ServiceAccount the admin workload uses.
*/}}
{{- define "shipwright.admin.serviceAccountName" -}}
{{- if .Values.admin.serviceAccount.create }}
{{- default (include "shipwright.admin.fullname" .) .Values.admin.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.admin.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the chart-managed admin Secret (session + encryption keys, and the
assembled DATABASE_URL when the bundled PostgreSQL subchart is used).
*/}}
{{- define "shipwright.admin.secretName" -}}
{{- printf "%s-admin" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Agent component fullname: "<fullname>-agent".
*/}}
{{- define "shipwright.agent.fullname" -}}
{{- printf "%s-agent" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Agent labels — common labels plus the component label.
*/}}
{{- define "shipwright.agent.labels" -}}
{{ include "shipwright.labels" . }}
app.kubernetes.io/component: agent
{{- end }}

{{/*
Name of the ServiceAccount provisioned agent pods run as (SEPARATE from the admin
SA). Defaults to "<fullname>-agent" when create=true and no name override.
*/}}
{{- define "shipwright.agent.serviceAccountName" -}}
{{- if .Values.agent.provisioning.serviceAccount.create }}
{{- default (include "shipwright.agent.fullname" .) .Values.agent.provisioning.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.agent.provisioning.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Whisper component fullname: "<fullname>-whisper". The self-hosted Whisper ASR
pod (onerahmet/openai-whisper-asr-webservice) rendered only when
agent.voice.enabled and agent.voice.provider == "whisper".
*/}}
{{- define "shipwright.whisper.fullname" -}}
{{- printf "%s-whisper" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Whisper selector labels — fullname selector labels plus the component label.
*/}}
{{- define "shipwright.whisper.selectorLabels" -}}
{{ include "shipwright.selectorLabels" . }}
app.kubernetes.io/component: whisper
{{- end }}

{{/*
Whisper labels — common labels plus the component label.
*/}}
{{- define "shipwright.whisper.labels" -}}
{{ include "shipwright.labels" . }}
app.kubernetes.io/component: whisper
{{- end }}

{{/*
In-cluster URL of the Whisper Service ("http://<fullname>-whisper:<port>").
This is the WHISPER_SERVICE_URL injected into the admin (and via the provisioner,
provisioned agents) when agent.voice.provider == "whisper".
*/}}
{{- define "shipwright.whisper.serviceUrl" -}}
{{- printf "http://%s:%v" (include "shipwright.whisper.fullname" .) .Values.agent.voice.whisper.service.port }}
{{- end }}

{{/*
Name of the chart-managed voice Secret holding the STT/TTS API keys
(ELEVENLABS_API_KEY, and GROQ_API_KEY when provider=groq).
*/}}
{{- define "shipwright.voice.secretName" -}}
{{- printf "%s-voice" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Metrics component fullname: "<fullname>-metrics".
*/}}
{{- define "shipwright.metrics.fullname" -}}
{{- printf "%s-metrics" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Metrics selector labels — fullname selector labels plus the component label.
*/}}
{{- define "shipwright.metrics.selectorLabels" -}}
{{ include "shipwright.selectorLabels" . }}
app.kubernetes.io/component: metrics
{{- end }}

{{/*
Metrics labels — common labels plus the component label.
*/}}
{{- define "shipwright.metrics.labels" -}}
{{ include "shipwright.labels" . }}
app.kubernetes.io/component: metrics
{{- end }}

{{/*
Name of the ServiceAccount the metrics workload uses.
*/}}
{{- define "shipwright.metrics.serviceAccountName" -}}
{{- if .Values.metrics.serviceAccount.create }}
{{- default (include "shipwright.metrics.fullname" .) .Values.metrics.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.metrics.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the chart-managed metrics Secret (assembled METRICS_DATABASE_URL when
the bundled PostgreSQL subchart is used, keeping the password out of plaintext
Deployment env).
*/}}
{{- define "shipwright.metrics.secretName" -}}
{{- printf "%s-metrics" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Metrics database name: a SEPARATE database from the admin service (default
"shipwright_metrics"). The metrics provider creates its own `events` table on
boot; sharing the admin database would leave the admin schema non-empty and
break the admin service's `prisma migrate deploy` baseline (Prisma P3005). When
the bundled PostgreSQL subchart is enabled, this database is provisioned via
the parent-chart ConfigMap in postgres-initdb-configmap.yaml, which
renders the CREATE DATABASE SQL with this helper. The ConfigMap name tracks the
release (values.yaml sets postgresql.primary.initdb.scriptsConfigMap to a
tpl-evaluable string the Bitnami subchart resolves at render time). Overriding
metrics.database.name updates BOTH the database created at initdb time and the
METRICS_DATABASE_URL assembled in metrics-secret.yaml — they use the same helper.
*/}}
{{- define "shipwright.metrics.databaseName" -}}
{{- default "shipwright_metrics" .Values.metrics.database.name }}
{{- end }}

{{/*
Name of the PostgreSQL subchart Service / Secret ("<release>-postgresql").
The Bitnami subchart derives these from its own fullname (release name +
"postgresql"); with no postgresql.fullnameOverride this is the standard form.
*/}}
{{- define "shipwright.postgresql.fullname" -}}
{{- printf "%s-postgresql" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Name of the ConfigMap holding the PostgreSQL first-boot initdb scripts.

LEGACY NAME — DO NOT CHANGE. This renders "<release>-metrics-initdb" even though
the ConfigMap now creates the metrics, task-store AND chat databases. values.yaml
statically references this name via
`postgresql.primary.initdb.scriptsConfigMap: '{{ printf "%s-metrics-initdb" .Release.Name }}'`,
and any operator who pinned that key in their own values would get a dangling
volume reference and a PostgreSQL pod that never starts if the name changed.
tests/metrics_initdb_configmap_test.yaml asserts this name as a regression guard.
*/}}
{{- define "shipwright.postgresql.initdbConfigMapName" -}}
{{- printf "%s-metrics-initdb" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Resolve the bundled PostgreSQL APPLICATION user's password (the account named by
postgresql.auth.username — NOT the postgres superuser). Resolution order:

  1. .Values.postgresql.auth.password when set explicitly, else
  2. postgresql.auth.existingSecret's "password" key, else
  3. the live "<release>-postgresql" Secret's "password" key (Bitnami
     auto-generated on first install), else
  4. "" — the case on `helm template` / helm-unittest, which do NOT execute
     `lookup`. A live install/upgrade resolves the real value.

KEY NAME: Bitnami postgresql 16.7.27 templates/secrets.yaml emits exactly
`postgres-password` (superuser), `password` (application user),
`replication-password` and `ldap-password`. It has NEVER emitted
`postgresql-password` — the key this chart previously looked up, which meant
branch 3 could never fire and a bundled-Postgres install rendered an
empty-password DSN unless postgresql.auth.password was set by hand.

CAVEAT (branch 3 on first install): the "<release>-postgresql" Secret does not
exist yet during `helm install`, so an auto-generated password still resolves to
"" on the very first render. Set postgresql.auth.password (or
auth.existingSecret) for a single-shot install — examples/values-minikube.yaml
does exactly that.
*/}}
{{- define "shipwright.postgresql.password" -}}
{{- $password := .Values.postgresql.auth.password }}
{{- if not $password }}
{{- if .Values.postgresql.auth.existingSecret }}
{{- $secret := (lookup "v1" "Secret" .Release.Namespace .Values.postgresql.auth.existingSecret) }}
{{- if and $secret $secret.data (index $secret.data "password") }}
{{- $password = (index $secret.data "password" | b64dec) }}
{{- end }}
{{- else }}
{{- $secret := (lookup "v1" "Secret" .Release.Namespace (include "shipwright.postgresql.fullname" .)) }}
{{- if and $secret $secret.data (index $secret.data "password") }}
{{- $password = (index $secret.data "password" | b64dec) }}
{{- end }}
{{- end }}
{{- end }}
{{- $password }}
{{- end }}

{{/*
Assemble a bundled-PostgreSQL connection string for one database.

Usage: include "shipwright.postgresql.dsn" (dict "context" . "database" "shipwright_chat")

Always rendered into a chart-managed Secret — never into plaintext Deployment
env — so the password does not appear in `kubectl get deploy -o yaml`.
*/}}
{{- define "shipwright.postgresql.dsn" -}}
{{- $ctx := .context }}
{{- printf "postgresql://%s:%s@%s:5432/%s"
      $ctx.Values.postgresql.auth.username
      (include "shipwright.postgresql.password" $ctx)
      (include "shipwright.postgresql.fullname" $ctx)
      .database }}
{{- end }}

{{/*
Task-store component fullname: "<fullname>-task-store".
*/}}
{{- define "shipwright.taskStore.fullname" -}}
{{- printf "%s-task-store" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Task-store selector labels — fullname selector labels plus the component label.
*/}}
{{- define "shipwright.taskStore.selectorLabels" -}}
{{ include "shipwright.selectorLabels" . }}
app.kubernetes.io/component: task-store
{{- end }}

{{/*
Task-store labels — common labels plus the component label.
*/}}
{{- define "shipwright.taskStore.labels" -}}
{{ include "shipwright.labels" . }}
app.kubernetes.io/component: task-store
{{- end }}
{{/*
Task-store ServiceAccount name.
*/}}
{{- define "shipwright.taskStore.serviceAccountName" -}}
{{- if .Values.taskStore.serviceAccount.create }}
{{- default (include "shipwright.taskStore.fullname" .) .Values.taskStore.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.taskStore.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the chart-managed task-store Secret (holds the assembled
DATABASE_URL_SHIPWRIGHT_TASK_STORE on the bundled-PostgreSQL path).
*/}}
{{- define "shipwright.taskStore.secretName" -}}
{{- printf "%s-task-store" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Task-store database name: a SEPARATE database from admin, metrics and chat
(default "shipwright_task_store"). Each Prisma service owns its own database —
sharing one would leave a non-empty schema and break `prisma migrate deploy`
with Prisma P3005. Provisioned by the initdb ConfigMap + bootstrap Job, both of
which render the CREATE DATABASE SQL from THIS helper, so overriding
taskStore.database.name keeps the created database and the connection string in
sync automatically.
*/}}
{{- define "shipwright.taskStore.databaseName" -}}
{{- default "shipwright_task_store" .Values.taskStore.database.name }}
{{- end }}

{{/*
Whether the task-store uses the chart-managed bundled-PostgreSQL database.

True only when taskStore.database.existingSecret is EMPTY and the bundled
subchart is enabled. The value defaults to the non-empty "shipwright-secrets",
so every existing install keeps its caller-managed external Secret untouched —
opting in is an explicit `existingSecret: ""`.
*/}}
{{- define "shipwright.taskStore.useBundledDatabase" -}}
{{- if and (not .Values.taskStore.database.existingSecret) .Values.postgresql.enabled }}true{{- end }}
{{- end }}

{{/*
MCP server component fullname: "<fullname>-mcp-server".
*/}}
{{- define "shipwright.mcpServer.fullname" -}}
{{- printf "%s-mcp-server" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
MCP server selector labels — fullname selector labels plus the component label.
*/}}
{{- define "shipwright.mcpServer.selectorLabels" -}}
{{ include "shipwright.selectorLabels" . }}
app.kubernetes.io/component: mcp-server
{{- end }}

{{/*
MCP server labels — common labels plus the component label.
*/}}
{{- define "shipwright.mcpServer.labels" -}}
{{ include "shipwright.labels" . }}
app.kubernetes.io/component: mcp-server
{{- end }}

{{/*
MCP server ServiceAccount name.
*/}}
{{- define "shipwright.mcpServer.serviceAccountName" -}}
{{- if .Values.mcpServer.serviceAccount.create }}
{{- default (include "shipwright.mcpServer.fullname" .) .Values.mcpServer.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.mcpServer.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Chat component fullname: "<fullname>-chat".
*/}}
{{- define "shipwright.chat.fullname" -}}
{{- printf "%s-chat" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Chat selector labels — fullname selector labels plus the component label.
*/}}
{{- define "shipwright.chat.selectorLabels" -}}
{{ include "shipwright.selectorLabels" . }}
app.kubernetes.io/component: chat
{{- end }}

{{/*
Chat labels — common labels plus the component label.
*/}}
{{- define "shipwright.chat.labels" -}}
{{ include "shipwright.labels" . }}
app.kubernetes.io/component: chat
{{- end }}

{{/*
Chat ServiceAccount name.
*/}}
{{- define "shipwright.chat.serviceAccountName" -}}
{{- if .Values.chat.serviceAccount.create }}
{{- default (include "shipwright.chat.fullname" .) .Values.chat.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.chat.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the chart-managed chat Secret (holds the assembled
DATABASE_URL_SHIPWRIGHT_CHAT on the bundled-PostgreSQL path).
*/}}
{{- define "shipwright.chat.secretName" -}}
{{- printf "%s-chat" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Name of the Secret holding the raw chat admin token, or "" when chat is
disabled. Prefers a caller-supplied chat.adminToken.existingSecret; otherwise
the chart manages the token itself in its own chat Secret (see
chat-secret.yaml). Both the chat container (CHAT_SEED_ADMIN_TOKEN) and the
admin container (SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN) resolve through this so
the two always read the same value — that shared value is what makes the admin
console's Chat tab work without a hand-created Secret.
*/}}
{{- define "shipwright.chat.adminTokenSecretName" -}}
{{- if .Values.chat.enabled }}{{- .Values.chat.adminToken.existingSecret | default (include "shipwright.chat.secretName" .) }}{{- end }}
{{- end }}

{{/*
Key within the chat admin-token Secret. One expression shared by the chart-managed
Secret and both consumers, so a custom chat.adminToken.key stays consistent.
*/}}
{{- define "shipwright.chat.adminTokenSecretKey" -}}
{{- .Values.chat.adminToken.key | default "SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN" }}
{{- end }}

{{/*
Chat database name: a SEPARATE database from admin, metrics and task-store
(default "shipwright_chat"). See shipwright.taskStore.databaseName for why each
Prisma service must own its own database.
*/}}
{{- define "shipwright.chat.databaseName" -}}
{{- default "shipwright_chat" .Values.chat.database.name }}
{{- end }}

{{/*
Whether chat uses the chart-managed bundled-PostgreSQL database. Mirrors
shipwright.taskStore.useBundledDatabase — see there for the opt-in rationale.
*/}}
{{- define "shipwright.chat.useBundledDatabase" -}}
{{- if and (not .Values.chat.database.existingSecret) .Values.postgresql.enabled }}true{{- end }}
{{- end }}

{{/*
CNH-2.1 GROUNDWORK: Ingress TLS / cert-manager helpers below. None of these are
called from a rendered manifest yet (templates/ingress.yaml is untouched, and
templates/certificate.yaml's guard is unchanged behaviorally) — they exist so a
follow-up task can wire the corresponding render logic without re-deriving
these lookups. See templates/_validation.tpl (shipwright.validate) for the
cross-field guards that pair with these.
*/}}

{{/*
shipwright.bundled.nginx — true when networking.ingress.controller=nginx (the
long-standing default and only controller flavor this chart has ever
special-cased before CNH-2.1). "Bundled" here does NOT mean a subchart (this
chart bundles no ingress controller, unlike postgresql) — it means "one of the
controller flavors this chart understands and renders controller-specific
config for." See shipwright.validate for how nginx vs traefik selection is
cross-checked against className/entrypoints for contradictions.
*/}}
{{- define "shipwright.bundled.nginx" -}}
{{- if eq .Values.networking.ingress.controller "nginx" }}true{{- end }}
{{- end }}

{{/*
shipwright.bundled.traefik — true when networking.ingress.controller=traefik.
See shipwright.bundled.nginx above for what "bundled" means in this chart.
*/}}
{{- define "shipwright.bundled.traefik" -}}
{{- if eq .Values.networking.ingress.controller "traefik" }}true{{- end }}
{{- end }}

{{/*
shipwright.bundledIngressClass — the conventional IngressClass name for the
DECLARED networking.ingress.controller ("nginx" -> "nginx", "traefik" ->
"traefik"). Used by shipwright.validate to detect a className that names the
OTHER known controller's class while a different controller is selected. This
is intentionally NOT the same as shipwright.ingress.className (which resolves
what actually gets used, defaulting to this value) — this helper always
reflects the controller-implied default, ignoring any explicit override, so it
can serve as the "what would we expect className to be" baseline for the
contradiction check.
*/}}
{{- define "shipwright.bundledIngressClass" -}}
{{- .Values.networking.ingress.controller -}}
{{- end }}

{{/*
shipwright.ingress.className — the IngressClass actually used on the rendered
Ingress. An explicit networking.ingress.className always wins (preserves every
existing deployment's override, e.g. "alb"); when unset, falls back to the
bundled class implied by networking.ingress.controller.
*/}}
{{- define "shipwright.ingress.className" -}}
{{- .Values.networking.ingress.className | default (include "shipwright.bundledIngressClass" .) -}}
{{- end }}

{{/*
shipwright.ingress.controller — the effective ingress controller flavor
("nginx" or "traefik"), read straight from networking.ingress.controller. A
thin named wrapper (rather than reaching into .Values directly everywhere) so
future controller-specific template logic has one place to read this from.
*/}}
{{- define "shipwright.ingress.controller" -}}
{{- .Values.networking.ingress.controller -}}
{{- end }}

{{/*
shipwright.ingress.tlsEnabled — true when the Ingress should terminate TLS:
either networking.ingress.tls.enabled=true directly, OR
tls.certManager.enabled=true (enabling cert-manager on the ingress path
implies wanting TLS — that's the entire point of the ingress-shim annotations
templates/ingress.yaml renders). Gates the `tls:` stanza on
templates/ingress.yaml (CNH-3.1).
*/}}
{{- define "shipwright.ingress.tlsEnabled" -}}
{{- if or .Values.networking.ingress.tls.enabled .Values.tls.certManager.enabled }}true{{- end }}
{{- end }}

{{/*
shipwright.ingress.tlsSecretName — Secret name the Ingress TLS stanza would
reference. An explicit networking.ingress.tls.secretName always wins;
otherwise falls back to "<fullname>-tls" — the SAME naming convention
templates/certificate.yaml already uses for the Gateway path (see
shipwright.certManager.certificateManifest), so an Ingress deployment using
cert-manager can share one Secret name with the Certificate resource by
default without any extra wiring.
*/}}
{{- define "shipwright.ingress.tlsSecretName" -}}
{{- .Values.networking.ingress.tls.secretName | default (printf "%s-tls" (include "shipwright.fullname" .)) -}}
{{- end }}

{{/*
shipwright.publicHost — the externally-reachable hostname for whichever
networking path is active: networking.ingress.host when networking.type=
ingress, networking.gateway.host when networking.type=gateway, and "" for any
other networking.type (ClusterIP/NodePort/LoadBalancer have no single public
hostname the chart can name). GROUNDWORK: a follow-up task can use this to
assemble admin.appBaseUrl-style values automatically instead of requiring a
manual override.
*/}}
{{- define "shipwright.publicHost" -}}
{{- if eq .Values.networking.type "ingress" -}}
{{- .Values.networking.ingress.host -}}
{{- else if eq .Values.networking.type "gateway" -}}
{{- .Values.networking.gateway.host -}}
{{- end -}}
{{- end }}

{{/*
shipwright.publicScheme — "https" when TLS terminates on the active networking
path (networking.type=ingress with networking.ingress.tls.enabled, OR
networking.type=gateway with tls.certManager.enabled), else "http". Pairs with
shipwright.publicHost for a follow-up task to assemble a full public base URL.
*/}}
{{- define "shipwright.publicScheme" -}}
{{- $https := false -}}
{{- if eq .Values.networking.type "ingress" -}}
{{- $https = .Values.networking.ingress.tls.enabled -}}
{{- else if eq .Values.networking.type "gateway" -}}
{{- $https = .Values.tls.certManager.enabled -}}
{{- end -}}
{{- if $https }}https{{- else }}http{{- end -}}
{{- end }}

{{/*
shipwright.certManager.issuerName — the (Cluster)Issuer name a rendered
Certificate/Ingress should reference. An explicit tls.certManager.issuerRef.
name always wins (bring-your-own Issuer, today's only working path); when
empty and tls.certManager.issuer.create=true, falls back to the chart-managed
Issuer name shipwright.certManager.issuerManifest would create
("<fullname>-issuer"). Empty when neither is set (schema validation —see
values.schema.json's tls.certManager anyOf guard — prevents that combination
from reaching render time whenever tls.certManager.enabled=true).
*/}}
{{- define "shipwright.certManager.issuerName" -}}
{{- if .Values.tls.certManager.issuerRef.name -}}
{{- .Values.tls.certManager.issuerRef.name -}}
{{- else if .Values.tls.certManager.issuer.create -}}
{{- printf "%s-issuer" (include "shipwright.fullname" .) -}}
{{- end -}}
{{- end }}

{{/*
shipwright.certManager.issuerKind — the Issuer kind a rendered
Certificate/Ingress should reference. An explicit tls.certManager.issuerRef.
name wins issuerRef.kind (bring-your-own Issuer's own kind); otherwise, when
chart-managed (issuer.create=true), uses issuer.kind (the kind the chart WILL
create — see shipwright.certManager.issuerManifest).
*/}}
{{- define "shipwright.certManager.issuerKind" -}}
{{- if .Values.tls.certManager.issuerRef.name -}}
{{- .Values.tls.certManager.issuerRef.kind -}}
{{- else -}}
{{- .Values.tls.certManager.issuer.kind -}}
{{- end -}}
{{- end }}

{{/*
shipwright.certManager.createIssuer — true when the chart should render its
own (Cluster)Issuer: tls.certManager.issuer.create=true AND no explicit
tls.certManager.issuerRef.name is set. An explicit issuerRef.name always means
bring-your-own-Issuer and suppresses chart-managed creation even if
issuer.create is also (redundantly) true — keeps the two paths mutually
exclusive at render time, matching the values.yaml comment describing this
intent. Guards templates/cert-manager-issuer.yaml (CNH-5.1).
*/}}
{{- define "shipwright.certManager.createIssuer" -}}
{{- if and .Values.tls.certManager.issuer.create (not .Values.tls.certManager.issuerRef.name) }}true{{- end }}
{{- end }}

{{/*
shipwright.certManager.viaHook — reserved for a FUTURE hook-based-issuance path
(e.g. a pre-install/pre-upgrade Job that requests a cert out-of-band instead of
a live cert-manager.io/v1 Certificate resource). No values key backs this
today — it always renders "" (falsy) — so
shipwright.certManager.certificateManifest's render guard
(`tls.certManager.enabled && networking.type == "gateway" && !viaHook`) is
UNCONDITIONALLY equivalent to today's `tls.certManager.enabled &&
networking.type == "gateway"` guard. Kept as its own helper (rather than
inlining `false`) so a follow-up task only has to change this one definition
to light up the hook path everywhere it is checked.
*/}}
{{- define "shipwright.certManager.viaHook" -}}
{{- end }}

{{/*
shipwright.certManager.issuerManifest — the cert-manager.io/v1 (Cluster)Issuer
body, included from templates/cert-manager-issuer.yaml (CNH-5.1) when
shipwright.certManager.createIssuer is true. Two issuer.type shapes:
  - "selfsigned" -> spec.selfSigned: {} (no ACME account, no dependency on an
    external CA — good for internal/dev clusters).
  - "letsencrypt" (default) -> spec.acme.{email,server,privateKeySecretRef,
    solvers}. email is validated as required by shipwright.validate. server
    defaults to the Let's Encrypt production endpoint when unset. The HTTP-01
    solver targets the effective ingress class (shipwright.ingress.className)
    via the modern `ingressClassName` field (not the deprecated `class`).
kind is namespace-scoped ("Issuer") or cluster-scoped ("ClusterIssuer") per
tls.certManager.issuer.kind — only "Issuer" gets an explicit metadata.
namespace (ClusterIssuer has no namespace). This helper is only ever invoked
from behind the createIssuer guard, so issuerName always resolves to the
chart-managed "<fullname>-issuer" name here (issuerRef.name, which would
override it, is guaranteed empty whenever createIssuer is true).
*/}}
{{- define "shipwright.certManager.issuerManifest" -}}
apiVersion: cert-manager.io/v1
kind: {{ .Values.tls.certManager.issuer.kind }}
metadata:
  name: {{ include "shipwright.certManager.issuerName" . }}
  {{- if eq .Values.tls.certManager.issuer.kind "Issuer" }}
  namespace: {{ .Release.Namespace }}
  {{- end }}
  labels:
    {{- include "shipwright.labels" . | nindent 4 }}
spec:
  {{- if eq .Values.tls.certManager.issuer.type "selfsigned" }}
  selfSigned: {}
  {{- else }}
  acme:
    email: {{ .Values.tls.certManager.issuer.email | quote }}
    server: {{ .Values.tls.certManager.issuer.server | default "https://acme-v02.api.letsencrypt.org/directory" | quote }}
    privateKeySecretRef:
      name: {{ include "shipwright.certManager.issuerName" . }}-acme-account
    solvers:
      - http01:
          ingress:
            ingressClassName: {{ include "shipwright.ingress.className" . }}
  {{- end }}
{{- end }}

{{/*
shipwright.certManager.certificateManifest — the cert-manager.io/v1 Certificate
body, moved out of templates/certificate.yaml verbatim (CNH-2.1) so the
guard-vs-body split matches the rest of the chart's "thin template, shared
helper body" pattern. templates/certificate.yaml now does only:
`{{- if <guard> }}{{ include "shipwright.certManager.certificateManifest" . }}{{- end }}`.
Body/output is IDENTICAL to before this task for every input that already
reached this code (still keys off networking.gateway.host and
tls.certManager.issuerRef.{name,kind} exactly as before) — this helper does
NOT yet read shipwright.certManager.issuerName/issuerKind, so a chart-managed
Issuer (tls.certManager.issuer.create=true) is not yet wired into the actual
Certificate output. That's left for a follow-up task alongside the render-guard
wiring, keeping this task's diff behavior-preserving as required.
*/}}
{{- define "shipwright.certManager.certificateManifest" -}}
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: {{ include "shipwright.fullname" . }}-tls
  labels:
    {{- include "shipwright.labels" . | nindent 4 }}
spec:
  # Secret cert-manager populates with the issued certificate + key.
  secretName: {{ include "shipwright.fullname" . }}-tls
  dnsNames:
    - {{ .Values.networking.gateway.host | quote }}
  issuerRef:
    name: {{ .Values.tls.certManager.issuerRef.name | quote }}
    kind: {{ .Values.tls.certManager.issuerRef.kind }}
    group: cert-manager.io
{{- end }}
