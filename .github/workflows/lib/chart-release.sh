#!/usr/bin/env bash
#
# .github/workflows/lib/chart-release.sh
#
# Publish-time logic for chart-release.yml (ADR 0001): derive the chart
# version, stamp the per-service image pins into a scratch copy of the chart,
# skip no-op publishes, build the release record and create the idempotent
# annotated chart-<version> tag. Sourced only; function definitions, no side
# effects. Needs lib/chart-tag-utils.sh sourced first (latest_tag_for_service,
# values_paths_for_service, pin_value_for_tag, update_values_tag,
# service_for_tag) and lib/library-pin.sh (library_pin_from_chart) for the
# release record.
#
# Pure awk/sed/sort/tar/git: runs the same in the workflow and the tests.
#
set -uo pipefail

# max_patch_from_index <index.yaml> <MAJOR.MINOR>
# Prints the highest patch published for MAJOR.MINOR under entries.shipwright
# (nothing when none). Returns 1 when the index is missing or has no
# `entries:` key: an unreadable index must never fall back to the floor.
max_patch_from_index() {
  local index="$1" mm="$2"
  if [ ! -f "$index" ] || ! grep -q '^entries:' "$index"; then
    echo "::error::chart index ${index} is missing or unreadable; refusing to derive a version." >&2
    return 1
  fi
  awk '
    /^  [^ -]/ { in_chart = ($0 == "  shipwright:"); next }
    in_chart && /^    version:/ {
      v = $0; sub(/^    version:[ ]*/, "", v); gsub(/"/, "", v); print v
    }
  ' "$index" | awk -F. -v mm="$mm" '$1 "." $2 == mm { print $3 }' | sort -n | tail -n1
}

# max_patch_from_tags <MAJOR.MINOR>: highest patch among local chart-* tags.
max_patch_from_tags() {
  local mm="$1"
  git tag -l "chart-${mm}.*" | sed 's/^chart-//' | awk -F. 'NF == 3 { print $3 }' | sort -n | tail -n1
}

# derive_chart_version <Chart.yaml> <index.yaml>
# MAJOR.MINOR comes from the Chart.yaml floor; the result is
# MAJOR.MINOR.(P+1), P = highest patch of that line in the index or in the
# chart-* tags, or MAJOR.MINOR.0 when the line is unpublished. Run from the
# repo checkout (reads git tags).
derive_chart_version() {
  local chart_yaml="$1" index="$2"
  local floor mm from_index from_tags max
  floor=$(sed -n 's/^version:[ ]*//p' "$chart_yaml" | head -n1 | tr -d '"')
  if ! [[ "$floor" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "::error::cannot parse a strict X.Y.Z version from ${chart_yaml} ('${floor}')" >&2
    return 1
  fi
  mm="${floor%.*}"
  from_index=$(max_patch_from_index "$index" "$mm") || return 1
  from_tags=$(max_patch_from_tags "$mm")
  max=$(printf '%s\n%s\n' "$from_index" "$from_tags" | sed '/^$/d' | sort -n | tail -n1)
  if [ -z "$max" ]; then
    echo "${mm}.0"
  else
    echo "${mm}.$(( max + 1 ))"
  fi
}

# stamp_pins <values.yaml>
# Writes the latest release tag of every service into its values.yaml image
# path(s) and prints one "service=tag" line per stamped service (sorted by
# service). A service without a release tag is skipped with a warning on
# stderr. Run from the repo root (latest_tag_for_service reads git tags and
# agent/Dockerfile).
stamp_pins() {
  local values="$1" service tag path
  for service in admin metrics agent task-store chat; do
    tag=$(latest_tag_for_service "$service")
    if [ -z "$tag" ]; then
      echo "::warning::no release tag for ${service}; leaving its default pin unchanged" >&2
      continue
    fi
    while IFS= read -r path; do
      update_values_tag "$values" "$path" "$(pin_value_for_tag "$tag")" || return 1
    done < <(values_paths_for_service "$service")
    printf '%s=%s\n' "$service" "$tag"
  done | sort
}

# stamp_chart_yaml <Chart.yaml> <version> <pins_csv>
# Sets `version:` and replaces the artifacthub.io/changes annotation with one
# entry describing the stamped pins. Only ever applied to the scratch copy.
stamp_chart_yaml() {
  local chart_yaml="$1" version="$2" pins="$3" tmp
  tmp=$(mktemp)
  awk -v ver="$version" -v pins="$pins" '
    /^version:/ { print "version: " ver; next }
    /^  artifacthub\.io\/changes:/ {
      print
      print "    - kind: changed"
      print "      description: \"chart " ver " pins: " pins "\""
      skip = 1
      next
    }
    skip && /^    / { next }
    { skip = 0 }
    { print }
  ' "$chart_yaml" > "$tmp" && mv "$tmp" "$chart_yaml"
}

# _normalized_extract <tgz> <dir>: unpack and drop the per-publish fields
# (Chart.yaml version and the artifacthub changes annotation).
_normalized_extract() {
  mkdir -p "$2" && tar -xzf "$1" -C "$2" || return 1
  local f="$2/shipwright/Chart.yaml"
  [ -f "$f" ] && awk '
    /^version:/ { next }
    /^  artifacthub\.io\/changes:/ { skip = 1; next }
    skip && /^    / { next }
    { skip = 0; print }
  ' "$f" > "$f.n" && mv "$f.n" "$f"
  return 0
}

# chart_packages_equivalent <a.tgz> <b.tgz>
# True (0) when two packages differ only in the Chart.yaml version and
# artifacthub changes annotation: the no-empty-versions guard.
chart_packages_equivalent() {
  local d
  d=$(mktemp -d)
  _normalized_extract "$1" "$d/a" && _normalized_extract "$2" "$d/b" \
    && diff -r "$d/a" "$d/b" >/dev/null
  local rc=$?
  rm -rf "$d"
  return $rc
}

# release_record <version> <source_sha> <pins_csv> <library_version> <run_url>
# The annotated tag message.
release_record() {
  local version="$1" sha="$2" pins="$3" library="$4" run="$5" pin
  printf 'Release shipwright chart %s\n\n' "$version"
  printf 'Chart: %s\n' "$version"
  printf 'Source-Commit: %s\n' "$sha"
  local IFS=','
  for pin in $pins; do
    printf 'Pin: %s\n' "$pin"
  done
  printf 'Library: agent-platform %s\n' "$library"
  printf 'Run: %s\n' "$run"
}

# publish_chart_tag <version> <sha> <message_file> [remote=origin]
# Creates and pushes the annotated tag chart-<version> at <sha>. Idempotent:
# an existing tag (local or remote) at the same commit exits 0 untouched; at a
# different commit it fails (a tag is never moved). Call it last, after the
# gh-pages push succeeded.
publish_chart_tag() {
  local version="$1" sha="$2" msg="$3" remote="${4:-origin}"
  local tag="chart-${version}" remote_sha local_sha full
  full=$(git rev-parse "${sha}^{commit}") || return 1

  remote_sha=$(git ls-remote --tags "$remote" "refs/tags/${tag}^{}" | awk '{print $1}' | head -n1)
  [ -z "$remote_sha" ] && remote_sha=$(git ls-remote --tags "$remote" "refs/tags/${tag}" | awk '{print $1}' | head -n1)
  if [ -n "$remote_sha" ]; then
    if [ "$remote_sha" = "$full" ]; then
      echo "Tag ${tag} already exists at ${full}; nothing to do."
      return 0
    fi
    echo "::error::tag ${tag} already exists at ${remote_sha}, not ${full}; refusing to move it." >&2
    return 1
  fi

  local_sha=$(git rev-parse -q --verify "refs/tags/${tag}^{commit}" 2>/dev/null || true)
  if [ -n "$local_sha" ] && [ "$local_sha" != "$full" ]; then
    echo "::error::local tag ${tag} points at ${local_sha}, not ${full}; refusing to reuse it." >&2
    return 1
  fi
  if [ -z "$local_sha" ]; then
    git tag -a "$tag" "$full" -F "$msg" || return 1
  fi
  git push "$remote" "refs/tags/${tag}"
}

# recorded_release <gh-pages-dir> <version>
# Prints the release record stored in the body of the gh-pages commit that
# published <version> (nothing for versions published before records existed).
# Lets a re-run create a tag a failed run never got to.
recorded_release() {
  local dir="$1" version="$2" sha
  sha=$(git -C "$dir" log -n1 --format=%H \
    --grep="^chart: publish shipwright ${version//./\\.}\$" 2>/dev/null) || return 0
  [ -n "$sha" ] || return 0
  git -C "$dir" log -n1 --format=%b "$sha" | sed '/^$/d'
}

# record_field <record> <Key>: prints the value of a "Key: value" line.
record_field() {
  printf '%s\n' "$1" | sed -n "s/^$2: //p" | head -n1
}

# tag_missing_chart_versions <gh-pages-dir> <floor> [remote=origin]
# Creates chart-<version> for EVERY published version above <floor> that has
# no tag yet and has a release record, not only the current run's version: a
# run that published N but failed before tagging is recovered by any later run,
# even one that publishes N+1. Versions without a record are skipped. Tries
# every version, then returns 1 if any tag failed (e.g. would move a tag).
# Needs lib/chart-drift-check.sh sourced (versions_missing_chart_tag).
tag_missing_chart_versions() {
  local dir="$1" floor="$2" remote="${3:-origin}" missing v record msg rc=0
  missing=$(versions_missing_chart_tag "$dir/index.yaml" "$floor") || return 1
  if [ -z "$missing" ]; then
    echo "Every published chart version above ${floor} has a chart-<version> tag."
    return 0
  fi
  msg=$(mktemp)
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    record=$(recorded_release "$dir" "$v")
    if [ -z "$record" ]; then
      echo "No release record for ${v}; nothing to tag."
      continue
    fi
    printf '%s\n' "$record" > "$msg"
    publish_chart_tag "$v" "$(record_field "$record" Source-Commit)" "$msg" "$remote" || rc=1
  done <<< "$missing"
  rm -f "$msg"
  return $rc
}
