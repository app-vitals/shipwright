#!/usr/bin/env bash
# git-credential-shipwright — git credential helper that reads a token from
# the file path in $GH_TOKEN_FILE and answers `get` requests for
# https://github.com/. `store` and `erase` are no-ops.

set -euo pipefail

cmd=${1:-}

case "$cmd" in
  get)
    if [[ -z "${GH_TOKEN_FILE:-}" ]]; then
      echo "git-credential-shipwright: GH_TOKEN_FILE is not set" >&2
      exit 0
    fi
    if [[ ! -f "$GH_TOKEN_FILE" ]]; then
      echo "git-credential-shipwright: token file not found: $GH_TOKEN_FILE" >&2
      exit 0
    fi
    token=$(cat "$GH_TOKEN_FILE")
    echo "protocol=https"
    echo "host=github.com"
    echo "username=x-access-token"
    echo "password=$token"
    ;;
  store|erase)
    : # no-op
    ;;
  *)
    : # unknown subcommand — no-op
    ;;
esac
