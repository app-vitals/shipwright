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
postgresql.primary.initdb.scripts.
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
