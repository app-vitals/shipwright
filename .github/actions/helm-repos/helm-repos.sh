#!/usr/bin/env bash
#
# .github/actions/helm-repos/helm-repos.sh
#
# Adds Helm chart repos and runs `helm repo update`, retrying each network
# call (every `helm repo add`, then the update) with a short bounded backoff
# so a transient 5xx from a chart host does not fail the job.
#
# Input (env):
#   HELM_REPOS            newline-separated "<name> <url>" pairs, added in order
#   HELM_REPOS_ATTEMPTS   attempts per call (default 4)
#   HELM_REPOS_SLEEP_SCALE multiplier on the 5s/10s/15s backoff (default 1;
#                         0 disables sleeping, for tests)
#
# Backoff between attempts is 5s, 10s, 15s (30s total at scale 1). If every
# attempt fails, the last helm error is already in the log and the script
# exits non-zero with the failing command's status.
#
# Tests: bash .github/workflows/test-helm-repos.sh
set -euo pipefail

ATTEMPTS="${HELM_REPOS_ATTEMPTS:-4}"
SCALE="${HELM_REPOS_SLEEP_SCALE:-1}"

# retry <cmd...>: run cmd up to ATTEMPTS times; return last status on failure.
retry() {
  local n=1 rc=0
  while true; do
    rc=0
    "$@" || rc=$?
    if [[ $rc -eq 0 ]]; then
      return 0
    fi
    if [[ $n -ge $ATTEMPTS ]]; then
      echo "::error::'$*' failed after ${n} attempts (exit ${rc})" >&2
      return "$rc"
    fi
    local delay=$(( 5 * n ))
    echo "'$*' failed (exit ${rc}, attempt ${n}/${ATTEMPTS}); retrying in $(( delay * SCALE ))s" >&2
    if [[ "$SCALE" != "0" ]]; then
      sleep $(( delay * SCALE ))
    fi
    n=$(( n + 1 ))
  done
}

main() {
  local name url
  while read -r name url; do
    [[ -z "${name:-}" ]] && continue
    if [[ -z "${url:-}" ]]; then
      echo "::error::helm-repos: missing URL for repo '${name}'" >&2
      return 2
    fi
    retry helm repo add "$name" "$url"
  done <<< "${HELM_REPOS:-}"
  retry helm repo update
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
