# Installing from the published Helm repo

The `shipwright` chart (`charts/shipwright`) is published to a
[GitHub Pages](https://pages.github.com/) Helm repository on every chart
**version bump** that lands on `main`. The
[`chart-release.yml`](../.github/workflows/chart-release.yml) workflow packages
the chart and commits the artifact **directly to the `gh-pages` branch** — it
creates **no GitHub Releases**.

> **Note:** The marketing site (`site/`) also deploys to the same `gh-pages`
> branch via the [`deploy-site.yml`](../.github/workflows/deploy-site.yml)
> workflow. Both the Helm repository and the site coexist on `gh-pages` — the
> site deploy uses `clean-exclude` to preserve Helm artifacts (`index.yaml` and
> `*.tgz` files) when clearing stale content.

On a push to `main` the publish job:

1. Checks out `main` and the `gh-pages` branch (side by side).
2. Builds chart dependencies and runs `helm package charts/shipwright` into the
   `gh-pages` working tree.
3. Regenerates the repo index with
   `helm repo index gh-pages/ --merge gh-pages/index.yaml --url https://app-vitals.github.io/shipwright`.
   `--merge` preserves every existing `index.yaml` entry; only the newly packaged
   version gains a `https://app-vitals.github.io/shipwright/<name>-<version>.tgz`
   URL, served straight from the `gh-pages` root.
4. Commits the `.tgz` and the regenerated `index.yaml` to `gh-pages` (only when
   `git diff --cached` shows a change).

> Publishing is keyed off `Chart.yaml`'s `version` (the
> [versioning discipline](../charts/shipwright/CHANGELOG.md)). Repackaging an
> unchanged version produces an identical `.tgz` and no committable diff, so a
> chart is published exactly when its version is bumped, never on a plain PR.

The publish job declares a `concurrency: { group: chart-release }` guard with
`cancel-in-progress: false`. Two chart releases can therefore never run at once
— this serializes the `--merge` + push against the shared `index.yaml` and
closes the index-corruption race — while an in-flight release that has already
packaged a `.tgz` is allowed to finish rather than being cancelled mid-publish.

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
Pages must be serving from it. The `chart-release.yml` workflow checks out and
commits to an existing `gh-pages` branch — if it doesn't exist, the publish
job's `gh-pages` checkout fails and the `helm repo add` URL below 404s. Do this
once:

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
