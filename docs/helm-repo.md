# Installing from the published Helm repo

The `shipwright` chart (`charts/shipwright`) is published to a
[GitHub Pages](https://pages.github.com/) Helm repository on every chart
**version bump** that lands on `main`. The
[`chart-release.yml`](../.github/workflows/chart-release.yml) workflow runs
[chart-releaser](https://github.com/helm/chart-releaser-action), which packages
the chart, attaches the `.tgz` to a GitHub Release, and updates the
`index.yaml` on the `gh-pages` branch. After publishing, the workflow optionally
emits a `repository_dispatch` event to notify a configured downstream repository.

> Publishing is keyed off `Chart.yaml`'s `version` (the
> [versioning discipline](../charts/shipwright/CHANGELOG.md)). chart-releaser is
> idempotent — it only releases versions it hasn't published before — so a
> chart is published exactly when its version is bumped, never on a plain PR.

## Downstream dispatch configuration (optional)

The `chart-release.yml` workflow can emit a `repository_dispatch` event to a
downstream repository when a chart is published. This is optional — if not
configured, the publish succeeds without the dispatch notification.

To enable downstream notifications, configure these GitHub Actions secrets and
variables in the current repository (**Settings → Secrets and variables → Actions**):

1. **`SHIPWRIGHT_DISPATCH_TOKEN`** (secret) — a GitHub Personal Access Token (PAT)
   with `repo` scope on the target downstream repository. Used to emit the
   dispatch event. The workflow step is `continue-on-error: true`, so a missing
   or invalid token does not block chart publishing.

2. **`CHART_DISPATCH_REPO`** (repository variable) — the `owner/repo` of the
   downstream repository that receives the dispatch event (e.g.
   `app-vitals/my-platform`).

If either is unset, the notify step silently skips; chart publishing proceeds
normally.

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
