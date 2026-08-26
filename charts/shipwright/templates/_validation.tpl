{{/*
shipwright.validate — cross-field guards for the Ingress/TLS/cert-manager
groundwork values (CNH-2.1). GROUNDWORK ONLY: as of this task, NOTHING calls
this helper from a rendered manifest (templates/ingress.yaml is untouched, and
templates/certificate.yaml's guard is unchanged behaviorally) — it exists so a
follow-up task can `{{ include "shipwright.validate" . }}` from
templates/ingress.yaml (or a dedicated validation template) once the new
values actually drive rendering. Calling it is a no-op today in every template
that doesn't invoke it.

This chart does NOT bundle an ingress controller as a subchart (unlike
postgresql) — "bundled ingress controller" throughout this helper means the
two controller flavors this chart understands and special-cases via
networking.ingress.controller: "nginx" (the long-standing default,
nginx.ingress.kubernetes.io/* annotations) and "traefik" (Traefik
entrypoints). shipwright.bundledIngressClass maps each flavor to its
conventional IngressClass name ("nginx" / "traefik" respectively) — the same
strings operators commonly use for networking.ingress.className, which is how
className and controller can end up contradicting each other below.

Checks (each `fail`s independently — first failing check wins):

  1. Both bundled ingress controllers "on" at once. `controller` is a
     single-value enum, so this can't happen via `controller` directly; the
     actual failure mode is Traefik-only config (a non-default
     networking.ingress.traefik.entrypoints) present while
     controller=nginx — a strong signal of a copy-paste/half-migrated values
     file rather than an intentional nginx deployment.
  2. `networking.ingress.controller` contradicts a `networking.ingress.
     className` that unambiguously names the OTHER bundled controller (i.e.
     className="nginx" with controller=traefik, or className="traefik" with
     controller=nginx). A className this chart doesn't recognize (e.g. "alb")
     is never a contradiction — operators are free to pair any IngressClass
     name with either controller selector.
  3. `tls.certManager.issuer.create=true` with `type=letsencrypt` (the only
     supported type today) and no `email` — Let's Encrypt's ACME protocol
     requires a contact email on every account; a chart-managed Issuer with
     none would fail at the cert-manager layer with a much less actionable
     error than failing the Helm render up front.
  4. An explicit, non-empty `networking.ingress.className` contradicts the
     bundled class implied by the DECLARED controller (shipwright.
     bundledIngressClass), covering the same className/controller mismatch as
     check 2 from the opposite direction: className differs from what
     `controller` would default to, AND className unambiguously names the
     OTHER known controller (same "no false positive on unrecognized
     className" rule as check 2 — this is intentionally the same underlying
     contradiction stated as a second, explicit acceptance-criteria-mandated
     check: "an explicit className contradicts a bundled class").
  5. `tls.certManager.enabled=true` with `tls.certManager.issuer.create=true`
     and `type=letsencrypt` (CNH-5.1's chart-managed Issuer) while
     `networking.type=gateway`. The letsencrypt branch of shipwright.
     certManager.issuerManifest always targets an HTTP-01 solver via an
     Ingress (shipwright.ingress.className), but templates/ingress.yaml only
     renders when networking.type=ingress — in gateway mode there is no
     Ingress for the solver to ever satisfy, so the chart-managed Issuer
     would render schema-valid but permanently unable to complete its ACME
     challenge. selfsigned (no ACME/no solver) and bring-your-own via
     issuerRef.name are both unaffected. The `enabled` guard mirrors
     templates/cert-manager-issuer.yaml's render guard: with
     tls.certManager.enabled=false (the default) the whole cert-manager
     integration is off and nothing would render, so this check must not
     hard-fail the render on that schema-valid-but-inert combination —
     `values.schema.json`'s issuerRef/issuer.create `anyOf` constraint itself
     only activates when `enabled=true`.
*/}}
{{- define "shipwright.validate" -}}
{{- $ingress := .Values.networking.ingress -}}
{{- $controller := $ingress.controller -}}
{{- $className := $ingress.className -}}
{{- $traefikCustomized := or (ne $ingress.traefik.entrypoints.web "web") (ne $ingress.traefik.entrypoints.websecure "websecure") -}}
{{- if and (eq $controller "nginx") $traefikCustomized -}}
{{- fail "networking.ingress.controller=nginx but networking.ingress.traefik.entrypoints is customized — both bundled ingress controllers appear to be configured at once. Set networking.ingress.controller=traefik to use the Traefik entrypoints, or reset traefik.entrypoints to defaults if you meant to stay on nginx." -}}
{{- end -}}
{{- if and (eq $className "nginx") (eq $controller "traefik") -}}
{{- fail "networking.ingress.className=nginx contradicts networking.ingress.controller=traefik. Set controller=nginx, or change className to a Traefik IngressClass." -}}
{{- end -}}
{{- if and (eq $className "traefik") (eq $controller "nginx") -}}
{{- fail "networking.ingress.className=traefik contradicts networking.ingress.controller=nginx. Set controller=traefik, or change className to an NGINX IngressClass." -}}
{{- end -}}
{{- if and .Values.tls.certManager.issuer.create (eq .Values.tls.certManager.issuer.type "letsencrypt") (not .Values.tls.certManager.issuer.email) -}}
{{- fail "tls.certManager.issuer.email is required when tls.certManager.issuer.create=true and tls.certManager.issuer.type=letsencrypt (Let's Encrypt requires a contact email on every ACME account)." -}}
{{- end -}}
{{- if and .Values.tls.certManager.enabled .Values.tls.certManager.issuer.create (eq .Values.tls.certManager.issuer.type "letsencrypt") (eq .Values.networking.type "gateway") -}}
{{- fail "tls.certManager.issuer.create=true with tls.certManager.issuer.type=letsencrypt is not supported when networking.type=gateway — the chart-managed Issuer's HTTP-01 solver targets an Ingress, which never renders in gateway mode (templates/ingress.yaml only renders for networking.type=ingress), so the ACME challenge could never complete. Use tls.certManager.issuer.type=selfsigned, switch networking.type to ingress, or bring your own Issuer via tls.certManager.issuerRef.name instead." -}}
{{- end -}}
{{- $bundledClass := include "shipwright.bundledIngressClass" . -}}
{{- if and $className (ne $className $bundledClass) (or (eq $className "nginx") (eq $className "traefik")) -}}
{{- fail (printf "networking.ingress.className=%s contradicts the class implied by networking.ingress.controller=%s (%s). Align className with controller, or use an IngressClass name this chart does not special-case (e.g. \"alb\")." $className $controller $bundledClass) -}}
{{- end -}}
{{- end -}}
