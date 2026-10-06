#!/usr/bin/env bash
# git-credential-shipwright — git credential helper that reads a token from
# the file path in $GH_TOKEN_FILE and answers `get` requests for
# https://github.com/. `store` and `erase` are no-ops.
#
# Multi-installation: when the gh-token.d directory next to $GH_TOKEN_FILE
# exists, the owner is taken from the `path=` git sends (credential.useHttpPath,
# with or without a trailing .git) and that owner's token file is used. An
# owner with no token file gets no credentials rather than another owner's.
# Without gh-token.d the behavior is unchanged.

set -euo pipefail

cmd=${1:-}

case "$cmd" in
  get)
    if [[ -z "${GH_TOKEN_FILE:-}" ]]; then
      echo "git-credential-shipwright: GH_TOKEN_FILE is not set" >&2
      exit 0
    fi
    token_file=$GH_TOKEN_FILE
    owner_dir="$(dirname "$GH_TOKEN_FILE")/gh-token.d"
    if [[ -d "$owner_dir" ]]; then
      path=""
      while IFS= read -r line && [[ -n "$line" ]]; do
        [[ "$line" == path=* ]] && path=${line#path=}
      done
      owner=${path%%/*}
      owner=${owner,,}
      if [[ -n "$path" && "$path" == */* && "$owner" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
        if [[ -f "$owner_dir/$owner" ]]; then
          token_file="$owner_dir/$owner"
        else
          echo "git-credential-shipwright: no token for GitHub owner: $owner" >&2
          exit 0
        fi
      fi
    fi
    if [[ ! -f "$token_file" ]]; then
      echo "git-credential-shipwright: token file not found: $token_file" >&2
      exit 0
    fi
    token=$(cat "$token_file")
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
