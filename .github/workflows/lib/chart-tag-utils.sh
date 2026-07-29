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
    chat-v*) echo "chat" ;;
    *) echo "" ;;
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
