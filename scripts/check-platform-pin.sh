#!/usr/bin/env bash
#
# scripts/check-platform-pin.sh <package> <minVersion>
# scripts/check-platform-pin.sh --task <PRODUCER-TASK-ID> <package>
#
# The pin-check behind a RELEASE GATE task (docs/release-gate.md). Exits 0 when
# app-vitals/shipwright main pins <package> at >= <minVersion>; otherwise exits
# 1 and prints which stage of the release chain the change is stuck in.
#
# With --task, <minVersion> is not hardcoded: it is the first agent release
# (vX.Y.Z tag) containing the merge commit of the producer task's PR, read from
# the task store (repo + pr) and GitHub.
#
#   STAGE: producer-not-merged    --task only: producer PR not merged yet
#   STAGE: no-agent-release       agent has not cut v<minVersion> (with --task:
#                                 no release contains the producer's merge commit)
#   STAGE: no-bump-pr             release published, no chore/platform-release PR
#   STAGE: bump-pr-conflicting    bump PR open but CONFLICTING
#   STAGE: bump-pr-red            bump PR open and a check failed
#   STAGE: bump-pr-pending        bump PR open, checks still running / merging
#
# Exit 2 means bad usage, an unreadable pin, a task with no repo/pr, a
# task-store failure, or a gh failure other than a missing release (not a
# stage). Read-only: only `gh api` / `gh pr list` reads, plus one task-store
# GET in --task mode (SHIPWRIGHT_TASK_STORE_URL / SHIPWRIGHT_TASK_STORE_TOKEN).
# Needs gh authenticated.
# Overrides: SHIPWRIGHT_REPO (app-vitals/shipwright), AGENT_REPO
# (app-vitals/agent), BUMP_BRANCH (chore/platform-release).
# Tests: scripts/check-platform-pin.unit.test.ts (fake gh on PATH).
#
set -euo pipefail

TASK_ID=""
if [[ "${1:-}" == "--task" ]]; then
  if [[ $# -ne 3 ]]; then
    echo "usage: check-platform-pin.sh --task <PRODUCER-TASK-ID> <package>" >&2
    exit 2
  fi
  TASK_ID="$2"
  PACKAGE="$3"
  MIN=""
elif [[ $# -ne 2 ]]; then
  echo "usage: check-platform-pin.sh <package> <minVersion> | --task <PRODUCER-TASK-ID> <package>" >&2
  exit 2
else
  PACKAGE="$1"
  MIN="${2#v}"
fi
SHIPWRIGHT_REPO="${SHIPWRIGHT_REPO:-app-vitals/shipwright}"
AGENT_REPO="${AGENT_REPO:-app-vitals/agent}"
BUMP_BRANCH="${BUMP_BRANCH:-chore/platform-release}"

# --task: resolve MIN from the producer task's merge commit. Exits 1 with a
# STAGE line when the producer is unmerged or no release contains it.
resolve_min_from_task() {
  if [[ -z "${SHIPWRIGHT_TASK_STORE_URL:-}" || -z "${SHIPWRIGHT_TASK_STORE_TOKEN:-}" ]]; then
    echo "SHIPWRIGHT_TASK_STORE_URL and SHIPWRIGHT_TASK_STORE_TOKEN are required for --task" >&2
    exit 2
  fi
  local task repo pr pull merge_sha tags tag status
  task="$(curl -sf -H "Authorization: Bearer ${SHIPWRIGHT_TASK_STORE_TOKEN}" \
    "${SHIPWRIGHT_TASK_STORE_URL}/tasks/${TASK_ID}")" || {
    echo "cannot read task ${TASK_ID} from the task store" >&2
    exit 2
  }
  repo="$(echo "$task" | jq -r '.repo // empty')" || exit 2
  pr="$(echo "$task" | jq -r '.pr // empty')" || exit 2
  if [[ -z "$repo" || -z "$pr" ]]; then
    echo "task ${TASK_ID} has no repo/pr — the producer task has no PR yet" >&2
    exit 2
  fi
  pull="$(gh api "repos/${repo}/pulls/${pr}")" || {
    echo "cannot read ${repo}#${pr}" >&2
    exit 2
  }
  merge_sha="$(echo "$pull" | jq -r 'if .merged_at then (.merge_commit_sha // empty) else empty end')"
  if [[ -z "$merge_sha" ]]; then
    echo "STAGE: producer-not-merged (${repo}#${pr} for task ${TASK_ID} is not merged yet)"
    exit 1
  fi
  tags="$(gh api "repos/${AGENT_REPO}/releases?per_page=100")" || {
    echo "cannot list ${AGENT_REPO} releases" >&2
    exit 2
  }
  tags="$(echo "$tags" | jq -r '.[] | select(.draft == false and .prerelease == false) | .tag_name' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V || true)"
  for tag in $tags; do
    # tag contains merge_sha when the tag is ahead of (or identical to) it.
    status="$(gh api "repos/${repo}/compare/${merge_sha}...${tag}" | jq -r '.status')" || {
      echo "cannot compare ${merge_sha} with ${tag} in ${repo}" >&2
      exit 2
    }
    if [[ "$status" == "ahead" || "$status" == "identical" ]]; then
      MIN="${tag#v}"
      echo "producer ${TASK_ID} (${repo}#${pr}, ${merge_sha:0:7}) first shipped in ${tag}"
      return
    fi
  done
  echo "STAGE: no-agent-release (no ${AGENT_REPO} release contains ${repo}#${pr} @ ${merge_sha:0:7} — check the Release workflow; a release is only cut for a feat:/fix:/perf: commit)"
  exit 1
}

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

if [[ -n "$TASK_ID" ]]; then
  resolve_min_from_task
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
