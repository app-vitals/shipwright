# Contributing to Shipwright

Thanks for your interest. This document covers the conventions, workflow, and release process for contributors.

## Code of conduct

Be respectful and constructive. This project follows our [Code of Conduct](./CODE_OF_CONDUCT.md) — by participating, you agree to uphold it.

## Conventions

### Commit style — Conventional Commits

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) spec:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

Breaking changes: append `!` after the type/scope or add a `BREAKING CHANGE:` footer.

### Tests land with the code

Tests are required in the same PR as the feature or fix — no "add tests later" tasks. Land the code and its tests together, at the correct layer:

- **unit** — pure logic, no I/O.
- **integration** — real dependency behavior via recorded fixtures / injected doubles.
- **smoke** — HTTP endpoints exercised in-process (no real socket).
- **e2e** — full browser flows via Playwright.

See [`CLAUDE.md`](./CLAUDE.md) for the full conventions, test isolation rules, and layer boundaries.

### Code conventions

Follow the guidance in [`CLAUDE.md`](./CLAUDE.md): no new platform coupling, local-first by default, MIT license across all artifacts.

## Development workflow

1. Find a `status:pending` issue with all dependencies marked `status:done`.
2. Branch from the `branch` field in the issue's YAML block (pattern: `feat/sw-x-y-slug`). Never work directly on `main`.
3. Build, test, and open a PR — all in one go.
4. Request review; address findings via follow-up commits on the same branch.

## Release process

Releases are on-demand and driven by **semantic-release** via the `release.yml` workflow. There is no bot watching `main` — a maintainer triggers the release manually.

**To cut a release:**

1. Go to **Actions → Release** and click **Run workflow**.
2. Set `dry_run` to `true` first to preview what version and changelog would be generated — no tags or packages are published.
3. When the preview looks right, re-run with `dry_run` unchecked (`false`).
4. semantic-release reads the commit history since the last tag, computes the next semver, generates the changelog, and writes back a `chore(release): <version> [skip ci]` commit that updates `CHANGELOG.md` and the version files. CI is skipped on that writeback commit automatically.

**Never hand-edit `CHANGELOG.md` or any version file** (`version.txt`, `package.json` version fields). Let semantic-release own those — manual edits will be overwritten or will break the automation.

## Downstream-compatibility checking (Helm chart)

The `shipwright` Helm chart (`charts/shipwright`) is published to a `gh-pages`
Helm repository on every version bump (see [`docs/helm-repo.md`](./docs/helm-repo.md)).
Downstream consumers ("wrappers") depend on it as a chart dependency inside
their own umbrella chart. `scripts/check-downstream-compat.sh` catches
compatibility breaks between what's published and what's about to be merged,
**before** a chart change lands and surprises a wrapper.

The script renders THREE variants of the SAME wrapper chart and diffs them:

- **Render A** — the wrapper as-is: whatever `shipwright` version/source it
  currently has pinned in its own `Chart.lock` / vendored `charts/`,
  unmodified.
- **Render B** — the same wrapper, with its `shipwright` dependency swapped to
  a specific **published baseline version** pulled fresh from the `gh-pages`
  Helm repository (`--baseline <version>`; defaults to the wrapper's own
  currently-pinned version).
- **Render C** — the same wrapper, with its `shipwright` dependency swapped to
  a chart packaged **from this repo's current working tree**
  (`helm package charts/shipwright`).

Diff logic:

1. **A vs B** — normalized (the `helm.sh/chart:` label and any Secret
   `data`/`stringData` values are blanked, since both legitimately vary
   across renders) and image-tag-only diff lines are allowlisted. Any other
   remaining diff fails the script.
2. **B vs C** — same normalization, but **no allowlist**. This diff must be
   completely empty; any diff here means the working-tree chart changed the
   wrapper's render relative to the published baseline — a compatibility
   break.
3. The wrapper's own `helm lint` and `helm template` are run against its own
   `values.yaml` (or `--values <file>`, resolved relative to the wrapper
   dir) and must not error.

Usage:

```bash
WRAPPER=/path/to/downstream-wrapper-chart task helm:downstream-compat

# equivalent direct invocation, with extra flags:
./scripts/check-downstream-compat.sh /path/to/downstream-wrapper-chart \
  --baseline 1.16.0 \
  --values values-prod.yaml
```

`WRAPPER` should point at a downstream chart directory that has a `Chart.yaml`
dependency entry named `shipwright` (see `--dep-name` to use a different
dependency name). The published Helm repository URL is never hardcoded — it's
derived from `--repo-url`, from the wrapper's own dependency `repository:`
field, or (as a last resort) from this repo's own `git remote get-url origin`
applied to the GitHub Pages convention. See the script's `--help` output and
header comment for the full flag reference.

### Self-test smoke run

There's no real downstream wrapper repo inside this repo, so the script's
own self-test uses **this repo's `charts/shipwright` as the stand-in
wrapper**. `charts/shipwright` has no `shipwright`-named dependency to swap
(it *is* the shipwright chart), so the script automatically falls back to a
degenerate, self-referential mode: Render A is reused as Render B (there's no
separate "published baseline" to swap to), and the meaningful check becomes
Render A/B (templated straight from the working tree) vs Render C (templated
from the working-tree-packaged `.tgz` of the *same* chart) — which must come
out diff-identical. This is the same general mechanism as the real
wrapper case, not a separate code path — see the comments in
`scripts/check-downstream-compat.sh` for exactly how the fallback works.

Run it yourself:

```bash
./scripts/check-downstream-compat.sh charts/shipwright
# or: WRAPPER=charts/shipwright task helm:downstream-compat
```

Expect `A vs B: identical.` and `B vs C: identical.` in the output, followed
by `PASSED`. A nonzero exit / `FAILED` means either the working tree
introduced a real render change, or the script itself has a bug — investigate
before trusting the script's verdict on a real wrapper.

## Submitting a pull request

- Keep PRs focused — one concern per PR.
- Squash noisy fixup commits before asking for review.
- Confirm CI is green before requesting a review.
- This repository is destined to be public and MIT-licensed — do not include proprietary or confidential material.
