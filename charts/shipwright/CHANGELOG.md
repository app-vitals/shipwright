# Changelog

All notable changes to the **shipwright** Helm chart are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this chart adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The chart `version` (in `Chart.yaml`) is bumped on **every** chart change,
independent of `appVersion`. CI enforces this with
`ct lint --check-version-increment`. Each release here must mirror the
`artifacthub.io/changes` annotation in `Chart.yaml`.

## [0.2.0]

### Added

- `CHANGELOG.md` (keep-a-changelog) documenting chart versions.
- `artifacthub.io/changes` annotation in `Chart.yaml` mirroring this changelog.
- `ct` version-increment CI gate (`ct lint --check-version-increment`) wired into
  the Helm workflow — any PR touching `charts/shipwright/**` that does not bump
  the chart `version` now fails CI.

### Changed

- Documented the chart versioning discipline in the chart `README.md`
  ("Versioning" section) and `CONTRIBUTING.md`.

## [0.1.0]

### Added

- Initial chart scaffold: values surface, helpers, NOTES, `values.schema.json`,
  and the pinned Bitnami PostgreSQL dependency (HD-2.1).
- Helm test harness: `task helm:*` targets, helm-unittest specs, and the
  kind-based `ct install` CI workflow (HD-2.2).
