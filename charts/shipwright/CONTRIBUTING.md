# Contributing to the shipwright Helm chart

This note covers the rules specific to the chart under `charts/shipwright/`. For
repo-wide conventions (Conventional Commits, tests-with-code, license), see the
[root `CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Versioning discipline (enforced by CI)

Every change under `charts/shipwright/**` **must bump the chart `version`** in
`Chart.yaml`. This is a hard CI gate, not a convention:

- The Helm workflow (`.github/workflows/helm.yml`) runs
  `ct lint --check-version-increment`, which diffs the chart against `main` and
  **fails the PR** if the chart changed but `version` did not increase.
- `ct.yaml` sets `check-version-increment: true`.

When you change the chart:

1. **Bump `version`** in `Chart.yaml` (SemVer — patch/minor/major as
   appropriate). `appVersion` only changes when the deployed Shipwright app
   release changes.
2. **Add a `CHANGELOG.md` entry** for the new version (keep-a-changelog style:
   `Added` / `Changed` / `Fixed` / `Removed`).
3. **Mirror it in `artifacthub.io/changes`** in `Chart.yaml` (Artifact Hub
   list-of-changes format: `- kind: added|changed|fixed|removed` +
   `description:`). Keep the annotation and the CHANGELOG in sync.

## Validate locally before pushing

```bash
helm lint charts/shipwright
task helm:unittest                                # helm-unittest specs
# Detection mode — no --charts, so ct diffs against main and runs the
# version-bump check (passing --charts bypasses detection and the bump check):
ct lint --config ct.yaml --check-version-increment --target-branch main
```

`ct lint` also runs `yamllint` and `yamale` schema validation; install them with
`brew install yamllint yamale` (or `pip install yamllint yamale`) if missing.

## Editing platform templates (library chart)

Platform templates (admin, chat, whisper, agent provisioning and the shared
networking and database templates) are named templates in the `agent-platform`
library chart from `app-vitals/agent`; the files in `templates/` are one-line
includes. To change platform behaviour, change the library and release it —
the dispatch to this repo re-pins `Chart.yaml` / `Chart.lock`, bumps the chart
version and publishes (see
[`docs/helm-repo.md`](../../docs/helm-repo.md#how-a-library-release-reaches-a-chart-bump)).
Shipwright-specific entries for the shared templates go in
`shipwright.platformExtensions`; task-store, metrics and mcp-server templates
are edited here directly.

The chart name, release name, `values.yaml` keys and rendered resource names are
a **compatibility contract** with downstream wrappers (Argo CD prunes anything
that renders under a new name). Don't change them in a refactor.

## Render-parity check

`scripts/chart-render-parity.ts` renders the chart at a base and at HEAD with
the same values and fails on any object, name, namespace or field difference
(only the `helm.sh/chart` label is normalized). CI runs it for every `ci/` and
`examples/` values file on PRs titled `refactor…`; run it locally before
opening one:

```bash
args=(); for f in charts/shipwright/ci/*.yaml charts/shipwright/examples/*.yaml; do args+=(--values "$f"); done
bun run scripts/chart-render-parity.ts --base origin/main --head charts/shipwright \
  --chart charts/shipwright "${args[@]}"
```

Run it from the repo root. See
[`docs/helm-repo.md`](../../docs/helm-repo.md#render-parity-check) for details.

## Bumping a vendored subchart pin

This chart vendors four subcharts as `Chart.yaml` dependencies —
`postgresql`, `ingress-nginx`, `traefik`, and `cert-manager` — each pinned to
an **exact** `version:` (never a range like `^4.0.0` or `4.x`) and committed
as a `.tgz` under `charts/shipwright/charts/`, alongside `Chart.lock`. To bump
one:

1. **Re-verify the target version is real and current**:
   ```bash
   helm repo add <repo> <url>   # e.g. helm repo add traefik https://traefik.github.io/charts
   helm repo update
   helm search repo <repo>/<chart> --versions
   ```
2. **Edit `Chart.yaml`** — update that dependency's `version:` field only
   (leave `repository:`/`condition:` unchanged unless the bump also changes
   those).
3. **Bump the chart `version`** (see "Versioning discipline" above) and add
   the `CHANGELOG.md` + `artifacthub.io/changes` entries.
4. **Run `helm dependency update charts/shipwright`** — this regenerates
   `Chart.lock` and re-downloads every dependency's `.tgz` (not just the one
   you bumped) into `charts/shipwright/charts/`.
5. **Commit `Chart.lock` and all `.tgz` files in one commit**, alongside the
   `Chart.yaml`/`CHANGELOG.md`/version-bump changes. It's normal and expected
   for unrelated dependencies' `.tgz` files to be re-written with identical
   content — commit them anyway so the lock file and the vendored artifacts
   never drift apart.
6. **Re-run the local gate** to confirm nothing broke:
   ```bash
   helm lint charts/shipwright
   task helm:unittest
   helm lint charts/shipwright -f charts/shipwright/examples/values-cloud-native.yaml
   helm lint charts/shipwright -f charts/shipwright/examples/values-cloud-native-traefik.yaml
   ```
   A subchart's own `values.schema.json` can change between versions
   (particularly `traefik`/`cert-manager`, which both use strict
   `additionalProperties: false` root schemas) — if `helm lint` starts
   rejecting a previously-valid key in `values.yaml`, check that subchart's
   new schema (inside the updated `.tgz`, or the upstream chart repo) rather
   than disabling the schema check.
