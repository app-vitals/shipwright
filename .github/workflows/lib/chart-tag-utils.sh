#!/usr/bin/env bash
#
# .github/workflows/lib/chart-tag-utils.sh
#
# Shared tag-parsing logic used by both auto-bump-chart.yml (writes release
# tags into charts/shipwright/values.yaml on tag push) and
# check-chart-drift.yml (reads them back and compares against the latest git
# tags on a schedule). Extracted here — rather than having check-chart-drift.yml
# source test-auto-bump-chart.sh directly — because that test file has no
# `if [[ "${BASH_SOURCE[0]}" == "$0" ]]` main-guard: it runs its entire
# assertion suite unconditionally top-to-bottom and calls `exit 1` on failure
# at the very bottom. Sourcing it from a production workflow step would (a)
# run the whole existing test suite as an unwanted side effect, and (b) the
# trailing `exit` would kill the parent shell even on success. This file
# contains ONLY function definitions — sourcing it has no side effects.
#
# Function bodies here are verbatim copies of the ones inlined in
# auto-bump-chart.yml's "Pin released tags into values.yaml" step (and
# mirrored in test-auto-bump-chart.sh). Keep all three copies in sync.
#
# This file is sourced only — running it directly does nothing useful.
#
set -uo pipefail

# Maps a release tag prefix to its service key.
service_for_tag() {
  local tag="$1"
  case "$tag" in
    admin-v*) echo "admin" ;;
    metrics-v*) echo "metrics" ;;
    agent-v*) echo "agent" ;;
    task-store-v*) echo "task-store" ;;
    agent-chat-v*) echo "chat" ;;
    *) echo "" ;;
  esac
}

# The chat service is the exception to the git-tag model: its image is
# ghcr.io/app-vitals/agent-chat, published by app-vitals/agent at the same
# X.Y.Z as the platform release that this repo pins in agent/Dockerfile
# (PLATFORM_VERSION, rewritten by platform-release.yml on the platform-release
# dispatch). So its "release tag" is synthesized as agent-chat-vX.Y.Z from
# that pin, and the value written to chat.image.tag is the bare X.Y.Z (the
# image tag, with no prefix). Run from the repo root.
platform_chat_tag() {
  local version
  version=$(sed -n 's/^ARG PLATFORM_VERSION=//p' agent/Dockerfile 2>/dev/null | head -n1)
  [ -n "$version" ] && printf 'agent-chat-v%s\n' "$version"
  return 0
}

# Prints the latest release tag for a service: the highest-semver
# "{service}-v*" git tag, except chat (see platform_chat_tag). Prints nothing
# when the service has no release tag yet.
latest_tag_for_service() {
  local service="$1" tags
  if [ "$service" = "chat" ]; then
    platform_chat_tag
    return 0
  fi
  tags=$(git tag -l "${service}-v*")
  [ -z "$tags" ] && return 0
  highest_semver_tag $tags
}

# Maps a release tag to the value written into values.yaml: the tag itself,
# except agent-chat-vX.Y.Z whose image tag is the bare X.Y.Z.
pin_value_for_tag() {
  local tag="$1"
  case "$tag" in
    agent-chat-v*) echo "${tag#agent-chat-v}" ;;
    *) echo "$tag" ;;
  esac
}

# Maps a service key to the values.yaml dot-paths that must be pinned to its
# released tag, one path per line. The agent service pins two paths from the
# same agent-v* tag: the top-level agent image and the admin-provisioned
# agent image nested under agent.provisioning.
values_paths_for_service() {
  local service="$1"
  case "$service" in
    admin) printf '%s\n' "admin.image.tag" ;;
    metrics) printf '%s\n' "metrics.image.tag" ;;
    agent) printf '%s\n' "agent.image.tag" "agent.provisioning.image.tag" ;;
    task-store) printf '%s\n' "taskStore.image.tag" ;;
    chat) printf '%s\n' "chat.image.tag" ;;
    *) return 1 ;;
  esac
}

# Returns the highest-semver tag among the given tags (space-separated, all
# sharing the same prefix). Strips the non-numeric prefix so `sort -V`
# compares the bare X.Y.Z portion, then re-attaches the winning original tag.
# A single-tag input is a no-op — the sole tag always "wins".
highest_semver_tag() {
  local tag
  for tag in "$@"; do
    printf '%s %s\n' "${tag##*-v}" "$tag"
  done | sort -V | tail -n1 | cut -d' ' -f2-
}

# Reads the value pinned at `dot_path` (e.g. "agent.provisioning.image.tag")
# inside `values_yaml`. Walks the key chain top-down using 2-space-indent
# scoping — identical structural assumption to auto-bump-chart.yml's
# update_values_tag() — so agent.image.tag and agent.provisioning.image.tag
# resolve independently even though both lines read "tag: agent-v...".
# Prints nothing (empty string) if the path isn't found.
#
# Generic values.yaml dot-path reader — no drift-specific meaning of its own.
# Used by both auto-bump-chart.yml (compute_batch_from_drift(), below) and
# check-chart-drift.yml (via lib/chart-drift-check.sh's compute_drift()).
# Originally lived in chart-drift-check.sh; moved here since it's no longer
# drift-check-exclusive.
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

# Computes the batch of release tags to credit in a chart-bump run by diffing
# LIVE git tag state against what is currently pinned in `values_yaml`,
# rather than a timestamp heuristic anchored to a prior chart-bump commit
# (see auto-bump-chart.yml's header comment for why that heuristic was wrong
# — it silently dropped tags whenever an earlier, unrelated chart-bump PR was
# still open when a new batch of release tags landed).
#
# For each of the five Shipwright services this repo's release workflows tag
# (agent, admin, metrics, task-store, chat): finds the highest-semver
# "{service}-v*" git tag (chat: the platform pin, see platform_chat_tag) and compares it against read_pinned_tag()'s current
# value at that service's PRIMARY values.yaml path (the first path returned
# by values_paths_for_service() — for a service with more than one path,
# e.g. agent's top-level + provisioning-nested paths, both are always pinned
# together from the same tag by update_values_tag(), so checking one path is
# sufficient to detect drift for the whole service). A service is included
# in the batch ONLY when the two differ. A service with no matching git tags
# at all is skipped — nothing to compare against, same as
# check-chart-drift.yml's MISSING_SERVICES handling.
#
# Emits the drifted tags as a sorted, de-duplicated, comma-separated list —
# empty when nothing has drifted (e.g. a concurrent run already pinned
# everything this run's trigger tag would have credited).
#
# Must be run with the current working directory set to the checkout whose
# tags should be compared (relies on plain `git tag -l`, no `-C` flag) — same
# calling convention as auto-bump-chart.yml's / test-auto-bump-chart.sh's
# compute_batch_and_version().
compute_batch_from_drift() {
  local values_yaml="$1"
  local services=("agent" "admin" "metrics" "task-store" "chat")
  local service latest_tag primary_path pinned_tag
  local batch=()

  for service in "${services[@]}"; do
    latest_tag=$(latest_tag_for_service "$service")
    [ -z "$latest_tag" ] && continue

    primary_path=$(values_paths_for_service "$service" | head -n1)
    pinned_tag=$(read_pinned_tag "$values_yaml" "$primary_path")

    if [ "$(pin_value_for_tag "$latest_tag")" != "$pinned_tag" ]; then
      batch+=("$latest_tag")
    fi
  done

  printf '%s\n' "${batch[@]:-}" | sed '/^$/d' | sort -u | paste -sd, -
}
