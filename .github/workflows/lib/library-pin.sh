#!/usr/bin/env bash
#
# .github/workflows/lib/library-pin.sh
#
# Pin logic for the agent-platform library chart dependency (CHM-3.5).
# Shared by library-chart-release.yml (bumps the pin when app-vitals/agent
# dispatches `chart-release`), check-chart-drift.yml (fails when the pin
# trails the latest published version) and the two test scripts:
# test-auto-bump-chart.sh (bump) and test-check-chart-drift.sh (drift).
#
# Pure awk/sed/sort: no python3, yq or helm needed, so it runs the same in
# the workflows and the local test scripts. Refreshing the Chart.lock digest
# and the vendored charts/agent-platform-*.tgz needs helm and the network, so
# that happens in the workflow, not here.
#
# This file is sourced only — running it directly does nothing useful.
#
set -uo pipefail

LIBRARY_NAME="agent-platform"

# Prints the agent-platform version pinned in a Chart.yaml's dependencies
# (quotes stripped). Prints nothing when the dependency is absent.
library_pin_from_chart() {
  awk -v lib="$LIBRARY_NAME" '
    /^  - name: / { dep = ($0 == "  - name: " lib) }
    dep && /^    version:/ {
      v = $0; sub(/^    version:[ ]*/, "", v); gsub(/"/, "", v); print v; exit
    }
  ' "$1"
}

# Prints the agent-platform version recorded in a Chart.lock.
library_pin_from_lock() {
  awk -v lib="$LIBRARY_NAME" '
    /^- name: / { dep = ($0 == "- name: " lib) }
    dep && /^  version:/ {
      v = $0; sub(/^  version:[ ]*/, "", v); gsub(/"/, "", v); print v; exit
    }
  ' "$1"
}

# Prints the highest semver listed under entries.agent-platform in a Helm repo
# index.yaml. Prints nothing when the file is missing or has no such entries.
latest_library_version() {
  [ -f "$1" ] || return 0
  awk -v lib="$LIBRARY_NAME" '
    /^  [^ -]/ { in_lib = ($0 == "  " lib ":") ; next }
    in_lib && /^    version:/ {
      v = $0; sub(/^    version:[ ]*/, "", v); gsub(/"/, "", v); print v
    }
  ' "$1" | sort -V | tail -n1
}

# Reports every pin (Chart.yaml, Chart.lock) that is behind the latest version
# in the published index, one line each:
#   MISMATCH: library=agent-platform path={Chart.yaml|Chart.lock} expected={latest} actual={pin}
# Prints nothing when both pins are current (a pin AHEAD of the index is index
# propagation lag, not drift). Returns 1 with an ::error:: on stderr when the
# latest version cannot be determined — an unreadable index must never look
# like "no drift".
compute_library_drift() {
  local chart_yaml="$1" chart_lock="$2" index_yaml="$3"
  local latest pin path
  latest=$(latest_library_version "$index_yaml")
  if [ -z "$latest" ]; then
    echo "::error::no ${LIBRARY_NAME} versions found in ${index_yaml}; cannot check the library pin." >&2
    return 1
  fi
  for path in Chart.yaml Chart.lock; do
    if [ "$path" = "Chart.yaml" ]; then
      pin=$(library_pin_from_chart "$chart_yaml")
    else
      pin=$(library_pin_from_lock "$chart_lock")
    fi
    if [ "$pin" != "$latest" ] && { [ -z "$pin" ] || [ "$(printf '%s\n%s\n' "$pin" "$latest" | sort -V | tail -n1)" = "$latest" ]; }; then
      echo "MISMATCH: library=${LIBRARY_NAME} path=${path} expected=${latest} actual=${pin}"
    fi
  done
  return 0
}

# bump_library_pin <chart-dir> <version> <date>
#
# Re-pins agent-platform to <version> in <chart-dir>/Chart.yaml and
# Chart.lock, patch-bumps the chart version, replaces the artifacthub.io/changes
# annotation and prepends a matching CHANGELOG.md entry. <version> comes from
# an external event, so it must be strict X.Y.Z (returns 1 otherwise, before
# touching anything). A no-op (return 0) when the pin already equals, or is
# newer than, <version> — a re-delivered or out-of-order dispatch.
bump_library_pin() {
  local dir="$1" version="$2" date="$3"
  local chart_yaml="$dir/Chart.yaml" chart_lock="$dir/Chart.lock" changelog="$dir/CHANGELOG.md"
  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: library version '${version}' is not strict X.Y.Z" >&2
    return 1
  fi
  local current
  current=$(library_pin_from_chart "$chart_yaml")
  if [ -z "$current" ]; then
    echo "ERROR: no ${LIBRARY_NAME} dependency found in ${chart_yaml}" >&2
    return 1
  fi
  if [ "$current" = "$version" ]; then
    echo "::notice::${LIBRARY_NAME} already pinned to ${version}; nothing to bump."
    return 0
  fi
  if [ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -n1)" = "$current" ]; then
    echo "::warning::${LIBRARY_NAME} pinned at ${current} is newer than ${version}; not downgrading." >&2
    return 0
  fi

  local old_chart_version major minor patch new_chart_version
  old_chart_version=$(sed -n 's/^version: //p' "$chart_yaml" | head -n1)
  IFS='.' read -r major minor patch <<< "$old_chart_version"
  new_chart_version="${major}.${minor}.$(( patch + 1 ))"
  local description="bump the ${LIBRARY_NAME} library chart to ${version}"
  local tmp="$dir/.bump.tmp"

  awk -v lib="$LIBRARY_NAME" -v ver="$version" -v chartver="$new_chart_version" -v desc="$description" '
    /^version:/ { print "version: " chartver; next }
    /^  artifacthub\.io\/changes:/ {
      print
      print "    - kind: changed"
      print "      description: \"" desc "\""
      skip = 1
      next
    }
    skip && /^    / { next }
    { skip = 0 }
    /^  - name: / { dep = ($0 == "  - name: " lib) }
    dep && /^    version:/ { print "    version: \"" ver "\""; dep = 0; next }
    { print }
  ' "$chart_yaml" > "$tmp" && mv "$tmp" "$chart_yaml"

  if [ -f "$chart_lock" ]; then
    awk -v lib="$LIBRARY_NAME" -v ver="$version" '
      /^- name: / { dep = ($0 == "- name: " lib) }
      dep && /^  version:/ { print "  version: " ver; dep = 0; next }
      { print }
    ' "$chart_lock" > "$tmp" && mv "$tmp" "$chart_lock"
  fi

  if [ -f "$changelog" ]; then
    ENTRY="## [${new_chart_version}] - ${date}

### Changed

- ${description}
" awk '
      !done && /^## \[/ { print ENVIRON["ENTRY"]; done = 1 }
      { print }
      END { if (!done) print "\n" ENVIRON["ENTRY"] }
    ' "$changelog" > "$tmp" && mv "$tmp" "$changelog"
  fi
  echo "Bumped ${LIBRARY_NAME} ${current} -> ${version}; chart ${old_chart_version} -> ${new_chart_version}"
}
