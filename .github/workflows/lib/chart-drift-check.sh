#!/usr/bin/env bash
#
# .github/workflows/lib/chart-drift-check.sh
#
# Drift-comparison logic for check-chart-drift.yml: reading the currently
# pinned tag at a values.yaml dot-path, and computing mismatches between the
# highest-semver git release tag per service and what's actually pinned.
#
# Depends on chart-tag-utils.sh (service_for_tag / values_paths_for_service)
# being sourced first for values_paths_for_service; source both together:
#   source .github/workflows/lib/chart-tag-utils.sh
#   source .github/workflows/lib/chart-drift-check.sh
#
# Read-only — unlike auto-bump-chart.yml's update_values_tag (which WRITES a
# new tag into values.yaml and needs python3 for safe indentation-scoped
# editing), these functions only ever read, so a simple awk state-machine
# scoped by indentation is sufficient and keeps this dependency-free (no
# python3, no yq).
#
# This file is sourced only — running it directly does nothing useful.
#
set -uo pipefail

# Reads the value pinned at `dot_path` (e.g. "agent.provisioning.image.tag")
# inside `values_yaml`. Walks the key chain top-down using 2-space-indent
# scoping — identical structural assumption to auto-bump-chart.yml's
# update_values_tag() — so agent.image.tag and agent.provisioning.image.tag
# resolve independently even though both lines read "tag: agent-v...".
# Prints nothing (empty string) if the path isn't found.
read_pinned_tag() {
  local values_yaml="$1"
  local dot_path="$2"
  awk -v dot_path="$dot_path" '
    BEGIN {
      n = split(dot_path, keys, ".")
      depth = 0
      target_indent = 0
      in_scope = 1
    }
    {
      line = $0
      # Compute leading-space indentation.
      indent = 0
      while (substr(line, indent + 1, 1) == " ") indent++
      stripped = line
      sub(/^ +/, "", stripped)

      if (in_scope == 0) next

      # Once we have matched all keys but the last, we are inside the final
      # blocks scope; look for the last key at target_indent.
      if (depth == n - 1) {
        if (indent < target_indent) { in_scope = 0; next }
        if (indent != target_indent) next
        key = keys[depth + 1]
        if (stripped == key ":" || index(stripped, key ":") == 1) {
          val = stripped
          sub("^" key ":[ ]*", "", val)
          print val
          exit
        }
        next
      }

      # Still matching an intermediate key: must appear at target_indent.
      if (indent < target_indent) { in_scope = 0; next }
      if (indent != target_indent) next
      key = keys[depth + 1]
      if (stripped == key ":" || index(stripped, key ":") == 1) {
        depth++
        target_indent += 2
      }
    }
  ' "$values_yaml"
}

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
