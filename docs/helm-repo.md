# Installing from the published Helm repo

The `shipwright` chart (`charts/shipwright`) vendors four optional subcharts
(PostgreSQL, ingress-nginx, Traefik, cert-manager — see the chart
[README](../charts/shipwright/README.md#dependencies) for versions and
conditions) and is published to a
[GitHub Pages](https://pages.github.com/) Helm repository on every service
release. The [`chart-release.yml`](../.github/workflows/chart-release.yml)
workflow derives the chart version, packages the chart and commits the artifact
**directly to the `gh-pages` branch**; it creates **no GitHub Releases** and
opens **no bump PR** (ADR
[0001](adr/0001-derive-chart-version-at-publish-time.md)).

> **Note:** The marketing site (`site/`) also deploys to the same `gh-pages`
> branch via the [`deploy-site.yml`](../.github/workflows/deploy-site.yml)
> workflow. Both the Helm repository and the site coexist on `gh-pages` — the
> site deploy uses `clean-exclude` to preserve Helm artifacts (`index.yaml` and
> `*.tgz` files) when clearing stale content.

## When the chart is published

The publish job runs on:

- a release tag `admin-v*`, `metrics-v*`, `agent-v*` or `task-store-v*` (created
  by the service build workflows on successful image push), after a 90-second
  debounce that collapses a burst of tags into one publish (a newer tag cancels
  the older debounce);
- a change to `PLATFORM_VERSION` in `agent/Dockerfile` on `main` (the
  platform bump that the release conductor dispatches as `bump-agent.yml`
  (the legacy `platform-release` dispatch from app-vitals/agent is pending
  removal), which publishes the
  `ghcr.io/app-vitals/agent-chat` image; the pin is credited as
  `agent-chat-vX.Y.Z` and `chat.image.tag` holds the bare `X.Y.Z`);
- a push to `main` touching `charts/shipwright/**`;
- a manual `workflow_dispatch` on `main` (a dispatch from any other branch
  skips the publish job, so an unmerged branch can never publish or be tagged).

A run whose stamped chart equals the latest published chart publishes nothing,
so there are no empty versions.

## What a publish does

1. Checks out `main` (for tag triggers) and the `gh-pages` branch side by side,
   with full history and tags.
2. Builds chart dependencies.
3. **Derives the version**: `MAJOR.MINOR` from the `Chart.yaml` floor, patch =
   highest published patch of that line in `gh-pages/index.yaml` and the
   `chart-*` tags, plus one (`MAJOR.MINOR.0` when the line is unpublished). An
   unreadable index fails the run; it never falls back to the floor.
4. **Stamps the image pins** into a scratch copy of the chart (never committed):
   the latest release tag of each service (`admin`, `metrics`, `agent`,
   `task-store`, `chat`) goes into its `values.yaml` image path(s), and the
   `artifacthub.io/changes` annotation lists them. A service without a release
   tag keeps its default pin and a warning is logged.
5. Runs `helm package <scratch> --version <derived>`.
6. Regenerates the repo index with
   `helm repo index gh-pages/ --merge gh-pages/index.yaml --url https://app-vitals.github.io/shipwright`.
   `--merge` preserves every existing `index.yaml` entry; only the new version
   gains a `https://app-vitals.github.io/shipwright/<name>-<version>.tgz` URL.
   The index format is unchanged.
7. Commits the `.tgz` and `index.yaml` to `gh-pages`; the commit body is the
   release record (version, source SHA, stamped pins, library pin, run URL).
8. **Last**, creates and pushes the annotated tag `chart-<version>` on the
   source commit with that release record as its message. A tag implies a
   published version. A re-run is idempotent: an existing tag at the same SHA
   exits 0, at a different SHA the run fails, and a tag is never moved. Every
   run tags **every** published version above the tag floor that is still
   missing its `chart-<version>` tag and has a release record, not only its own
   version. So if the push to `gh-pages` succeeded but tagging failed, the next
   run (a re-run, or a later run that publishes a newer version) creates the
   missing tag from the record in the gh-pages commit.

The publish job declares a `concurrency: { group: chart-release }` guard with
`cancel-in-progress: false`. Two chart releases can therefore never run at once,
which serializes the `--merge` + push against the shared `index.yaml`, while an
in-flight release is allowed to finish. If the `gh-pages` push is still
rejected (another writer landed first) the run fails and a re-run re-derives.

On pull requests, a dry-run job exercises derive + stamp + package + the index
merge and checks the merged index differs from the published one only by added
lines.

## How chart versions are derived

There is no bump commit and no bump PR. `Chart.yaml` `version` is a **floor**
(`MAJOR.MINOR.0`), edited by hand only for a deliberate minor or major bump.
The `values.yaml` and `Chart.yaml` in git therefore do not show what was
published; the source of truth for "what shipped" is the `chart-<version>` tag
message and the published package. For example `admin-v0.156.2` is stamped into
`admin.image.tag`, and `agent-v1.5.0` into both `agent.image.tag` and
`agent.provisioning.image.tag`.

The `mcpServer` block has the same shape, but `service_for_tag` and
`values_paths_for_service` (`lib/chart-tag-utils.sh`) have no `mcp-server-v*`
entry, so its tag is not stamped. This is not a live-cluster risk, since
`mcpServer` is disabled by default (`mcpServer.enabled=false`).

[`check-chart-drift.yml`](../.github/workflows/check-chart-drift.yml) runs daily
and fails when the newest **published** chart's pins trail the latest release
tags, when the library pin trails the library index, or when a published
version (newer than the last pre-tag version, 1.32.313) has no `chart-*` tag.

## Automating library chart releases

When the **agent-platform library chart** (`app-vitals/agent`'s published
`shipwright` chart dependency) publishes a new version, the Shipwright repo
**automatically** picks it up via the
[`library-chart-release.yml`](../.github/workflows/library-chart-release.yml)
workflow.

The app-vitals/agent `chart-release` workflow dispatches to Shipwright with the
new version (CHM-2.7 design):

```bash
gh api POST repos/app-vitals/shipwright/dispatches \
  -f event_type=chart-release -f client_payload[version]=$VERSION
```

On receipt, `library-chart-release.yml`:

1. Validates the version is strict `X.Y.Z` format.
2. Waits for the version to appear in the agent-platform's published Helm index.
3. Runs `lib/library-pin.sh` to re-pin the dependency in `charts/shipwright/Chart.yaml` and `Chart.lock` (no chart version bump: that is derived at publish time).
4. Swaps the vendored agent-platform chart tarballs in `charts/shipwright/charts/`.
5. Opens (or updates) a PR on the fixed branch `chore/library-chart-release`.

The PR runs the full CI suite, but skips the `helm.yml` render-parity check
(refactor-only gate — library-chart-release PRs have `chore(deps):` titles and
do not run this check). Intentional library chart changes affect the renders and
are expected. Once checks pass, the workflow auto-merges the PR using the
platform release merge gate (`scripts/platform-bump-gate.sh`). When the PR
merges, `chart-release.yml` publishes a new chart version to the
`gh-pages` branch as usual.

**Drift detection:** [`check-chart-drift.yml`](../.github/workflows/check-chart-drift.yml)
runs daily to verify the agent-platform pin in `charts/shipwright` is not
stale relative to the published index. It fails loudly if a newer version is
available, signaling either a missed dispatch or a Renovate fallback that needs
attention.

**Manual runs:** Developers can trigger `library-chart-release.yml` manually
via **Actions → Library Chart Release Bump → Run workflow**, entering the
library version to pin.

## Library-backed chart

The platform half of the chart (admin, chat, whisper, agent provisioning and
the shared networking and database templates) lives in the **`agent-platform`
library chart**, published from `app-vitals/agent` to
`https://app-vitals.github.io/agent`. `charts/shipwright` declares it as a
dependency in `Chart.yaml` (pinned to an exact version, with `Chart.lock` and
the vendored `.tgz` committed) and stays the one **deployable** chart.

- **Where templates live.** The platform templates are named templates in the
  library. The matching files under `charts/shipwright/templates/` are
  one-line includes, e.g. `{{ include "agent-platform.admin.service" . }}`.
  Shared templates (httproute, ingress, health checks, tenant network policy,
  PostgreSQL initdb and db-bootstrap) take an *extension list* from
  `shipwright.platformExtensions`, which is how Shipwright adds its own
  task-store, metrics and mcp-server entries. Templates for Shipwright-only
  services (task-store, metrics, mcp-server) stay in this repo.
- **Why a library.** A library chart shares the parent's values context and
  renders nothing on its own, so no values nest under a subchart key and
  resource names are still derived from the `shipwright` chart and release.
- **Compatibility contract.** The chart name (`shipwright`), the release name
  and the `values.yaml` keys do not change. Downstream consumers (for example
  the private wrapper deployed with Argo CD `prune: true`) depend on every
  rendered resource name staying identical; anything that renders under a
  different name is pruned. Treat a change to any of these as a breaking
  change.

### How a library release reaches a chart publish

1. `app-vitals/agent` publishes a new `agent-platform` version to its Pages
   Helm repo and dispatches `chart-release` to this repo (see
   [Automating library chart releases](#automating-library-chart-releases)).
2. `library-chart-release.yml` re-pins `Chart.yaml` / `Chart.lock` and opens
   the `chore/library-chart-release` PR, which auto-merges once checks pass.
3. The merge touches `charts/shipwright/**`, so `chart-release.yml` derives the
   next version and publishes the new `shipwright` chart to `gh-pages` as
   described above.
4. `check-chart-drift.yml` runs daily and fails if the pin is behind the
   published index, catching a missed dispatch.

### Render-parity check

`scripts/chart-render-parity.ts` is the gate that proves a template move did
not change what the chart renders. It renders the chart at a base (a git ref or
a directory) and at head with the same values, normalizes only the
`helm.sh/chart` label (it embeds the chart name and version), and exits
non-zero on any object, name, namespace or field change. Fields that differ
between two renders of the same base (generated secrets and certs) are ignored.

In CI, the `render-parity` job in
[`helm.yml`](../.github/workflows/helm.yml) runs it against `origin/<base>` for
every `ci/` and `examples/` values file, but **only on PRs whose title starts
with `refactor`**: `feat`, `fix`, `chore` and `docs` PRs, and library-pin
bumps, may change output and skip it.

To run it locally from the repo root (needs `helm` and `bun`):

```bash
args=()
for f in charts/shipwright/ci/*.yaml charts/shipwright/examples/*.yaml; do
  args+=(--values "$f")
done
bun run scripts/chart-render-parity.ts \
  --base origin/main --head charts/shipwright \
  --chart charts/shipwright "${args[@]}"
```

Pass `--names-file <path>` (one `Kind/namespace/name` per line) to also assert
that a list of expected objects, such as a private production inventory, still
renders at head. The full flag reference is in the script's header comment.

## How downstream consumers pick up new versions

Consumption is **pull-based**, not push. `chart-release.yml` does not notify
anyone when it publishes — it only packages the chart and updates
`gh-pages/index.yaml`. A downstream consumer is expected to run its own
node-cron poller that watches this published `index.yaml` for new chart
versions and, when it finds one, triggers a `workflow_dispatch`-only
chart-bump workflow on its own side. There is no Renovate integration and no
repository-to-repository dispatch from this repo — the consumer is solely
responsible for noticing and acting on new versions, on its own poll
schedule.

## Verifying compatibility before a chart change lands

A **wrapper** is a downstream consumer repo that depends on this repo's
`shipwright` chart (`charts/shipwright`) as a chart dependency inside its own
umbrella chart — i.e. anyone consuming the published chart via
[`helm repo add`](#add-the-repo-and-install) above. Before a chart change
merges to `main`, `scripts/check-downstream-compat.sh <wrapper-dir>` renders a
given wrapper chart three ways and diffs the output, to catch a compatibility
break before it reaches a real consumer:

- **Render A** — the wrapper as-is, using whatever `shipwright` version/source
  it currently has pinned in its own `Chart.lock` / vendored `charts/`.
- **Render B** — the same wrapper, with its `shipwright` dependency swapped to
  a specific **published** baseline version pulled from this `gh-pages` Helm
  repository (defaults to the wrapper's own currently-pinned version).
- **Render C** — the same wrapper, with its `shipwright` dependency swapped to
  a chart packaged from **this repo's current working tree**.

A vs B (allowing only image-tag-only differences) and B vs C (must be
completely empty) together isolate "did swapping a pinned source for the
same-version published artifact change anything" from "does the working tree
change what a real wrapper renders" — the latter is the actual compatibility
break this script exists to catch.

Key flags: `--baseline <version>` (published version to diff against),
`--values <file>` (wrapper values file), `--repo-url <url>` (published Helm
repo, only needed to override the derivation described above), `--dep-name
<name>` (the wrapper's dependency name for the shipwright chart, default
`shipwright`). Run `./scripts/check-downstream-compat.sh --help` for the full
reference.

This script is **not wired into any CI workflow in this repo** — by design.
It takes a wrapper chart path as a required argument, and no real downstream
wrapper lives inside this repo to check automatically, so there's nothing for
this repo's own CI to run it against. It's intended to be run **manually by a
downstream consumer**, from their own wrapper chart repo (or its CI), before
picking up a new published chart version. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md#downstream-compatibility-checking-helm-chart)
for full usage, flag reference, and a copy-pasteable self-test smoke run.

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
