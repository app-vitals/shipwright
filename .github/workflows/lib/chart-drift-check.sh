#!/usr/bin/env bash
#
# .github/workflows/lib/chart-drift-check.sh
#
# Drift-comparison logic for check-chart-drift.yml: computing mismatches
# between the highest-semver git release tag per service and what's actually
# pinned in values.yaml.
#
# Depends on chart-tag-utils.sh being sourced first — both for
# values_paths_for_service() (used directly below) and for read_pinned_tag()
# (used by compute_drift() below; it moved to chart-tag-utils.sh because it's
# a generic values.yaml dot-path reader with no drift-specific meaning of its
# own — auto-bump-chart.yml's compute_batch_from_drift() also needs it).
# Source both together:
#   source .github/workflows/lib/chart-tag-utils.sh
#   source .github/workflows/lib/chart-drift-check.sh
#
# Read-only — unlike auto-bump-chart.yml's update_values_tag (which WRITES a
# new tag into values.yaml and needs python3 for safe indentation-scoped
# editing), read_pinned_tag() only ever reads, so a simple awk state-machine
# scoped by indentation is sufficient and keeps this dependency-free (no
# python3, no yq).
#
# This file is sourced only — running it directly does nothing useful.
#
set -uo pipefail

# Given the path to a values.yaml and a newline-separated list of
# "service=latest-tag" pairs (e.g. the output of highest_semver_tag applied
# per service against live git tags), computes every path where the
# currently-pinned tag differs from the latest tag. Emits one line per
# mismatch in the form:
#   MISMATCH: service={service} path={path} expected={tag-from-git} actual={tag-in-values-yaml}
# Emits nothing (empty string) when everything is in sync. Never fails fast —
# every service/path combination is checked and all mismatches are collected.
compute_drift() {
  local values_yaml="$1"
  local latest_by_service="$2"
  local service latest_tag path pinned_tag

  while IFS='=' read -r service latest_tag; do
    [ -z "$service" ] && continue
    while IFS= read -r path; do
      [ -z "$path" ] && continue
      pinned_tag=$(read_pinned_tag "$values_yaml" "$path")
      if [ "$pinned_tag" != "$latest_tag" ]; then
        echo "MISMATCH: service=${service} path=${path} expected=${latest_tag} actual=${pinned_tag}"
      fi
    done < <(values_paths_for_service "$service")
  done <<< "$latest_by_service"
}
