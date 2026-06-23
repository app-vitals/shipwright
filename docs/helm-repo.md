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

## How chart versions are bumped

Chart version bumps are **automated** by the
[`auto-bump-chart.yml`](../.github/workflows/auto-bump-chart.yml) workflow.
Whenever a release tag is pushed matching `agent-v*`, `admin-v*`, or `metrics-v*`
(created by the service build workflows on successful image push), the automation
detects the tag, increments the chart patch version in `Chart.yaml`, opens a PR
(targeting `main`), and enables auto-merge. Once the PR merges, `chart-release.yml`
fires and publishes the new chart version. No manual version bump is required.

## First-time setup (one-time)

Before the **first** chart release, the `gh-pages` branch must exist and GitHub
Pages must be serving from it. The `chart-release.yml` workflow appends to an
existing `gh-pages` branch — if it doesn't exist, the first publish silently
no-ops and the `helm repo add` URL below 404s. Do this once:

1. Create an orphan `gh-pages` branch:

   ```bash
   git checkout --orphan gh-pages
   git rm -rf .
   git commit --allow-empty -m "init gh-pages"
   git push origin gh-pages
   git checkout main
   ```

2. Enable GitHub Pages: **Settings → Pages → Source: "Deploy from a branch"**,
   branch `gh-pages`, folder `/ (root)`.

This is a one-time setup. After the first chart release, the
`chart-release.yml` workflow maintains `index.yaml` on `gh-pages`
automatically — no further manual steps.

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
