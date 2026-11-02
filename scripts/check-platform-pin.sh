#!/usr/bin/env bash
#
# scripts/check-platform-pin.sh <package> <minVersion>
#
# The pin-check behind a RELEASE GATE task (docs/release-gate.md). Exits 0 when
# app-vitals/shipwright main pins <package> at >= <minVersion>; otherwise exits
# 1 and prints which stage of the release chain the change is stuck in:
#
#   STAGE: no-agent-release       agent has not cut v<minVersion>
#   STAGE: no-bump-pr             release published, no chore/platform-release PR
#   STAGE: bump-pr-conflicting    bump PR open but CONFLICTING
#   STAGE: bump-pr-red            bump PR open and a check failed
#   STAGE: bump-pr-pending        bump PR open, checks still running / merging
#
# Exit 2 means bad usage, an unreadable pin, or a gh failure other than a
# missing release (not a stage). Read-only: only
# `gh api` / `gh pr list` reads, no task-store calls. Needs gh authenticated.
# Overrides: SHIPWRIGHT_REPO (app-vitals/shipwright), AGENT_REPO
# (app-vitals/agent), BUMP_BRANCH (chore/platform-release).
# Tests: scripts/check-platform-pin.unit.test.ts (fake gh on PATH).
#
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: check-platform-pin.sh <package> <minVersion>" >&2
  exit 2
fi
PACKAGE="$1"
MIN="$2"
MIN="${MIN#v}"
SHIPWRIGHT_REPO="${SHIPWRIGHT_REPO:-app-vitals/shipwright}"
AGENT_REPO="${AGENT_REPO:-app-vitals/agent}"
BUMP_BRANCH="${BUMP_BRANCH:-chore/platform-release}"

# Succeeds when $1 >= $2 (semver; a prerelease sorts below its release).
version_gte() {
  local a="${1#[\^~=v]}" b="${2#[\^~=v]}"
  local a_core="${a%%-*}" b_core="${b%%-*}"
  local a_pre="" b_pre=""
  [[ "$a" == *-* ]] && a_pre="${a#*-}"
  [[ "$b" == *-* ]] && b_pre="${b#*-}"
  if [[ "$a_core" != "$b_core" ]]; then
    [[ "$(printf '%s\n%s\n' "$a_core" "$b_core" | sort -V | tail -n1)" == "$a_core" ]]
    return
  fi
  [[ -z "$a_pre" ]] && return 0
  [[ -z "$b_pre" ]] && return 1
  [[ "$(printf '%s\n%s\n' "$a_pre" "$b_pre" | sort -V | tail -n1)" == "$a_pre" ]]
}

pkg_json="$(gh api -H 'Accept: application/vnd.github.raw' \
  "repos/${SHIPWRIGHT_REPO}/contents/package.json?ref=main")" || {
  echo "cannot read package.json from ${SHIPWRIGHT_REPO}@main" >&2
  exit 2
}
pinned="$(echo "$pkg_json" | jq -r --arg p "$PACKAGE" \
  '(.dependencies[$p] // .devDependencies[$p] // empty)')"
if [[ -z "$pinned" ]]; then
  echo "${PACKAGE} is not pinned in ${SHIPWRIGHT_REPO}@main package.json" >&2
  exit 2
fi

if version_gte "$pinned" "$MIN"; then
  echo "OK: ${SHIPWRIGHT_REPO} main pins ${PACKAGE}@${pinned} (>= ${MIN})"
  exit 0
fi

echo "NOT YET: ${SHIPWRIGHT_REPO} main pins ${PACKAGE}@${pinned}, need >= ${MIN}"

if ! release_err="$(gh api "repos/${AGENT_REPO}/releases/tags/v${MIN}" 2>&1 >/dev/null)"; then
  if [[ "$release_err" != *"404"* && "$release_err" != *"Not Found"* ]]; then
    echo "cannot look up ${AGENT_REPO} release v${MIN}: ${release_err}" >&2
    exit 2
  fi
  echo "STAGE: no-agent-release (${AGENT_REPO} has no v${MIN} release — check the Release workflow; a release is only cut for a feat:/fix:/perf: commit)"
  exit 1
fi

prs="$(gh pr list -R "$SHIPWRIGHT_REPO" --head "$BUMP_BRANCH" --state open \
  --json number,url,mergeable,statusCheckRollup)" || {
  echo "cannot list ${BUMP_BRANCH} PRs in ${SHIPWRIGHT_REPO}" >&2
  exit 2
}
if [[ "$(echo "$prs" | jq 'length')" == "0" ]]; then
  echo "STAGE: no-bump-pr (v${MIN} is published but no open ${BUMP_BRANCH} PR — check the platform-release run in ${SHIPWRIGHT_REPO})"
  exit 1
fi
url="$(echo "$prs" | jq -r '.[0].url')"
if [[ "$(echo "$prs" | jq -r '.[0].mergeable')" == "CONFLICTING" ]]; then
  echo "STAGE: bump-pr-conflicting (${url})"
  exit 1
fi
if [[ "$(echo "$prs" | jq '[.[0].statusCheckRollup[]? | select((.conclusion // .state) | IN("FAILURE","ERROR","TIMED_OUT","CANCELLED"))] | length')" != "0" ]]; then
  echo "STAGE: bump-pr-red (${url})"
  exit 1
fi
echo "STAGE: bump-pr-pending (${url} — checks running or awaiting admin-merge)"
exit 1
