{{- define "observability.validate" -}}
{{- if ne .Release.Namespace "govbiz-observability" }}{{ fail "Use govbiz-observability namespace" }}{{ end -}}
{{- if not (regexMatch "^[a-z0-9][a-z0-9.-]*[a-z0-9]$" .Values.node) }}{{ fail "An explicit storage node is required" }}{{ end -}}
{{- range $name := list "postgres" "clickhouse" "redis" "minio" "langfuse-web" "langfuse-worker" -}}
{{- if not (regexMatch "^[^[:space:]@]+@sha256:[a-f0-9]{64}$" (index $.Values.images $name)) }}{{ fail "Use immutable source images" }}{{ end -}}
{{- $replica := toString (index $.Values.replicas $name) -}}
{{- if not (has $replica (list "0" "1")) }}{{ fail "Only zero or one replica is supported" }}{{ end -}}
{{- end -}}
{{- if not (regexMatch "^[^[:space:]@]+@sha256:[a-f0-9]{64}$" .Values.restoreHelperImage) }}{{ fail "Use an immutable restore helper" }}{{ end -}}
{{- range $name := list "postgres" "clickhouse" "redis" "minio" -}}
{{- if not (regexMatch "^[a-z0-9][a-z0-9-]*$" (index $.Values.claims $name)) }}{{ fail "Use separately restored claims" }}{{ end -}}
{{- end -}}
{{- if ne (len (uniq (values .Values.claims))) 4 }}{{ fail "Four separate restored claims are required" }}{{ end -}}
{{- if or (not .Values.existingAppSecret) (not .Values.existingStorageSecret) }}{{ fail "Existing runtime Secrets are required" }}{{ end -}}
{{- if not (regexMatch "^https?://[^[:space:]]+$" .Values.publicUrl) }}{{ fail "Use an explicit public URL" }}{{ end -}}
{{- end -}}
