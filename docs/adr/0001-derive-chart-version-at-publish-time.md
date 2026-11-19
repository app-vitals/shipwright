# ADR 0001: Derive the chart version at publish time

- **Status:** Accepted
- **Task:** RCN-9.9 (implemented by RCN-9.10)
- **Date:** 2026-11-19

## Context

Every `*-v*` release tag currently triggers `auto-bump-chart.yml`, which
debounces for 90s, patch-bumps `charts/shipwright/Chart.yaml`, pins the tag
into `values.yaml`, updates `CHANGELOG.md` and the `artifacthub.io/changes`
annotation, opens a `chore/chart-v<version>` PR and admin-merges it.
`chart-release.yml` then fires on the merge to `main` and publishes the
package to `gh-pages`. Each release therefore costs a PR, a CI run, a merge
and a bump commit ("chore(chart): bump chart version to X (#N)"), and the
branch-collision retry logic exists only to keep two bursts from computing
the same version.

Proposal: compute the version when packaging (`helm package --version`) from
the release event, with no commit and no PR.

## Evidence

### Are the chart's default image pins still used?

**Yes, for the five service images. The question cannot be closed by removing
them.**

- `app-vitals/gitops` `apps/shipwright.yaml` pins `targetRevision` (the chart
  version) and, in `valuesObject`, only `agent.provisioning.image` and
  `agent.provisioning.images.coding`. It does not pin `admin`, `metrics`,
  `taskStore`, `agent` or `chat`.
- Those five resolve from `charts/shipwright/values.yaml` defaults (or from
  the environment-specific values file in the private deployment repo, which is referenced
  as `valueFiles` and which I could not inspect from this workspace; **verify
  before RCN-9.10 lands**).
- Templates fall back to `.Chart.AppVersion` (a static `"0.1.0"`) when a tag is
  empty, so an unpinned default install would deploy a non-existent image.
- `charts/shipwright/README.md` documents that a default install runs the
  exact per-service tags pinned at that chart version.

Consequence: the pins must still be baked into the published package, but they
do not need to be *committed*. They are stamped at package time (below).

### Dependencies of the three named workflows

| Workflow | Depends on the bump commit / committed pins? |
|---|---|
| `check-chart-drift.yml` | **Yes.** Compares committed `values.yaml` pins to the latest git tags (`lib/chart-tag-utils.sh`), and the committed library pin to the Pages `index.yaml`. If pins are no longer committed, the first half is meaningless and must change (see Decision 4). The library-pin half is unaffected. |
| `library-chart-release.yml` | **Partly.** `bump_library_pin` (`lib/library-pin.sh`) re-pins `agent-platform` in `Chart.yaml`/`Chart.lock`, **patch-bumps the chart version**, rewrites the changelog and annotation, and opens `chore/library-chart-release`. The dependency re-pin stays a committed change (Chart.lock is real source); the version bump, changelog entry and annotation rewrite go away. |
| `sync-plugin-version.yml` | **No.** Triggered by `agent-v*`, edits plugin/package version files only, never `charts/`. No change. (`ci.yml`'s skip-CI allowlist names `Chart.yaml`/`CHANGELOG.md`; trim it once those are no longer auto-committed.) |

Also coupled: `helm.yml` runs `ct lint --check-version-increment`, and
`test-auto-bump-chart.sh` mirrors the inline bump logic.

## Decision

1. **Stop committing chart bumps.** Retire the `auto-bump-chart.yml` bump
   PR. `Chart.yaml` `version` becomes a **floor** (`MAJOR.MINOR.0`), edited by
   hand only for a deliberate minor/major.

2. **Derive the version at package time** in `chart-release.yml`:
   `version = MAJOR.MINOR.(P+1)` where `MAJOR.MINOR` comes from `Chart.yaml`
   and `P` is the highest patch for that `MAJOR.MINOR` in the published
   `gh-pages/index.yaml` (also cross-checked against existing `chart-*` tags).
   If the floor's `MAJOR.MINOR` is above anything published, start at
   `MAJOR.MINOR.0`. Package with `helm package --version "$VERSION"`.
   Releases are serialized by the existing `concurrency: chart-release` group
   with `cancel-in-progress: false`, and the final `git push` to `gh-pages` is
   rejected if another publish landed first, so two runs cannot publish the
   same version.

3. **Stamp image pins at package time** into a scratch copy of the chart
   (not committed), using the latest release tag per service
   (`latest_tag_for_service` from `lib/chart-tag-utils.sh`, including the
   synthesized `agent-chat-v` pin from `agent/Dockerfile`). Package that copy.
   Default installs keep working exactly as today.

4. **Replace the committed-pin drift check.** `check-chart-drift.yml`'s first
   step compares the **published** chart's pins (from the newest `.tgz`/index
   on Pages) to the latest release tags. The library-pin step is unchanged.

5. **`index.yaml` format is unchanged.** Same `helm repo index --merge
   gh-pages/index.yaml --url https://app-vitals.github.io/shipwright`, same
   `.tgz` naming, same entry fields. The conductor's `chart-` detector keeps
   reading it as it does today. Versions stay strictly increasing patch
   versions of the existing line (current: 1.32.304), so semver ordering and
   Argo's `targetRevision` pin are unaffected.

6. **Source-commit mapping: every publish creates an annotated git tag
   `chart-<version>` at the source commit, created last.** The bump commit was
   the only link from a published version to its source; removing it requires
   this tag. The tag message is the release record (version, source SHA, the
   per-service pins stamped, the library pin, run URL). It is created only
   after the gh-pages push succeeds (the release standard's "tag last" rule),
   so a tag implies a published version. Re-runs are idempotent: if
   `chart-<version>` exists, verify it points at the same SHA and exit 0. RCN-11.2
   finds a deployed chart's commit range from these tags, and RCN-11.5 then
   deletes the conductor's bump-commit fallback.

7. **Trigger changes.** `chart-release.yml` publishes on: release tags
   (`admin-v*`, `metrics-v*`, `agent-v*`, `task-store-v*`) after the existing
   90s debounce, an `agent/Dockerfile` `PLATFORM_VERSION` change, pushes to
   `main` touching `charts/shipwright/**`, and `workflow_dispatch`. A run
   whose stamped pins and chart content equal the latest published chart
   publishes nothing (no empty versions).

## Failure modes

| Failure | Handling |
|---|---|
| Two publishes race for the same version | `concurrency` serialization plus non-fast-forward rejection of the gh-pages push; the loser re-derives and retries (bounded, as in today's collision loop). |
| gh-pages push succeeds, tagging fails | Version is published but unmapped. The job fails loudly; re-run is idempotent and only creates the missing tag. A scheduled check flags `index.yaml` versions with no `chart-*` tag. |
| Tag exists at a different SHA | Fail; never move a tag. |
| `index.yaml` unreadable | Fail; never fall back to the floor (would republish an old version). |
| Latest release tag missing for a service | Same as today: skip that service's pin, warn. |
| Source edited with no version bump | Not a failure any more; the publish derives the next version. |

## Implementation steps for RCN-9.10

1. Confirm the private deployment repo's environment-specific values file does not override the five service
   image tags; if it does not, no gitops change is required (stamping keeps
   defaults); note the result in the PR.
2. In `chart-release.yml`: add a `derive version` step (floor from
   `Chart.yaml`, max patch from `gh-pages/index.yaml` and `git tag -l
   'chart-*'`), emit `version`.
3. Add a `stamp pins` step on a scratch copy of `charts/shipwright`: write
   `latest_tag_for_service` results into the `values.yaml` image paths (reuse
   the `values_paths_for_service` mapping; move it to `lib/chart-tag-utils.sh`
   if not already shared) and generate the `artifacthub.io/changes` text.
4. Replace `helm package charts/shipwright` with `helm package <scratch>
   --version "$VERSION" -d gh-pages/`; keep `helm repo index --merge`
   unchanged. Add a no-op guard when nothing differs from the latest
   published chart.
5. Add `workflow_dispatch`, the release-tag triggers, the `agent/Dockerfile`
   path trigger and the debounce to `chart-release.yml`; keep the PR dry-run
   job and make it exercise derive + stamp.
6. After the gh-pages push succeeds, **create the annotated tag**
   `chart-$VERSION` at `$GITHUB_SHA` with the release record as the message,
   and push it (idempotent per Decision 6). Add `contents: write` already
   present; ensure the checkout allows tag push.
7. Delete the bump path from `auto-bump-chart.yml` (the whole workflow, once
   triggers move) and update or retire `test-auto-bump-chart.sh` and the
   `ci.yml` step that runs it; keep `lib/chart-tag-utils.sh` (still used).
8. Update `library-chart-release.yml` / `bump_library_pin` to drop the chart
   version bump, changelog entry and annotation rewrite; keep the
   `Chart.yaml`/`Chart.lock` re-pin and PR.
9. Update `check-chart-drift.yml` per Decision 4, adding the check that every
   published version has a `chart-*` tag.
10. Update `helm.yml` (drop `--check-version-increment`) and trim the
    `ci.yml` skip allowlist; update `charts/shipwright/README.md` Versioning
    and `docs/helm-repo.md`.
11. Verify on a dry run that the generated `index.yaml` diff is additive only,
    and that a stamped package installs with no overrides.

## Consequences

- No bump commit/PR/admin-merge per release; fewer CI runs on `main`.
- `Chart.yaml` and `values.yaml` in git no longer reflect the published pins;
  the source of truth for "what shipped" is the `chart-<version>` tag message
  and the published package.
- Anything that parsed the bump commit subject must move to the tags (RCN-11.2,
  RCN-11.5).
