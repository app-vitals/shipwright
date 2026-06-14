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
Name of the PostgreSQL subchart Service / Secret ("<release>-postgresql").
The Bitnami subchart derives these from its own fullname (release name +
"postgresql"); with no postgresql.fullnameOverride this is the standard form.
*/}}
{{- define "shipwright.postgresql.fullname" -}}
{{- printf "%s-postgresql" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
