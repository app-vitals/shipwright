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
