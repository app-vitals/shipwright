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
Name of the chart-managed internal Secret holding the tokens that wire the
Shipwright services to each other (task-store admin token, chat admin token,
internal API key, and the composed SHIPWRIGHT_ADMIN_API_KEYS).

Generation happens in exactly ONE template (internal-secret.yaml) and every
consumer references these keys by secretKeyRef. That is forced, not a
preference: Helm evaluates templates independently, so calling randAlphaNum in
a producer template and again in a consumer template would yield two DIFFERENT
values and the services would never authenticate to each other.
*/}}
{{- define "shipwright.internal.secretName" -}}
{{- printf "%s-internal" (include "shipwright.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Secret name consumers should reference for the mesh tokens: the caller-managed
internal.existingSecret when set, otherwise the chart-managed Secret.
*/}}
{{- define "shipwright.internal.effectiveSecretName" -}}
{{- if .Values.internal.existingSecret }}
{{- .Values.internal.existingSecret }}
{{- else }}
{{- include "shipwright.internal.secretName" . }}
{{- end }}
{{- end }}

{{/*
Whether the chart-managed token mesh is available to wire into Deployments.
False when internal.enabled=false, in which case no mesh env is injected at all
and the operator is expected to hand-wire via extraEnv (the pre-1.8 behaviour).
*/}}
{{- define "shipwright.internal.wired" -}}
{{- if .Values.internal.enabled }}true{{- end }}
{{- end }}

{{/*
In-cluster base URL of the admin Service ("http://<fullname>-admin:<port>").
*/}}
{{- define "shipwright.admin.serviceUrl" -}}
{{- printf "http://%s:%v" (include "shipwright.admin.fullname" .) .Values.admin.service.port }}
{{- end }}

{{/*
In-cluster base URL of the task-store Service.
*/}}
{{- define "shipwright.taskStore.serviceUrl" -}}
{{- printf "http://%s:%v" (include "shipwright.taskStore.fullname" .) .Values.taskStore.service.port }}
{{- end }}

{{/*
In-cluster base URL of the chat Service.
*/}}
{{- define "shipwright.chat.serviceUrl" -}}
{{- printf "http://%s:%v" (include "shipwright.chat.fullname" .) .Values.chat.service.port }}
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
