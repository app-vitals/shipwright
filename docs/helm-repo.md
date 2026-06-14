# Installing from the published Helm repo

The `shipwright` chart (`charts/shipwright`) is published to a
[GitHub Pages](https://pages.github.com/) Helm repository on every chart
**version bump** that lands on `main`. The
[`chart-release.yml`](../.github/workflows/chart-release.yml) workflow runs
[chart-releaser](https://github.com/helm/chart-releaser-action), which packages
the chart, attaches the `.tgz` to a GitHub Release, and updates the
`index.yaml` on the `gh-pages` branch.

> Publishing is keyed off `Chart.yaml`'s `version` (the
> [versioning discipline](../charts/shipwright/CHANGELOG.md)). chart-releaser is
> idempotent — it only releases versions it hasn't published before — so a
> chart is published exactly when its version is bumped, never on a plain PR.

## Add the repo and install

```bash
# Add the published Shipwright chart repository.
helm repo add shipwright https://app-vitals.github.io/shipwright
helm repo update

# See the available chart versions.
helm search repo shipwright --versions

# Install into a dedicated namespace.
helm install my-release shipwright/shipwright \
  --namespace shipwright --create-namespace
```

To pin a specific chart version, pass `--version`:

```bash
helm install my-release shipwright/shipwright --version 0.2.0 \
  --namespace shipwright --create-namespace
```

For values, the Bitnami PostgreSQL subchart caveat, and the image-override /
mirror fallback, see the chart's own
[README](../charts/shipwright/README.md).
