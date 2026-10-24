#!/usr/bin/env bash
# git-credential-shipwright — git credential helper that reads a token from
# the file path in $GH_TOKEN_FILE and answers `get` requests for
# https://github.com/. `store` and `erase` are no-ops.
#
# GitHub App auth: the owner comes from $SHIPWRIGHT_GH_OWNER (not the request
# path) and that owner's token is read from gh-token.d next to $GH_TOKEN_FILE.
# An unset hint or an owner with no token file gets no credentials and a
# stderr message, never another owner's or the default token.
# PAT auth (no gh-token.d): the single token file is used and the hint ignored.

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
      if [[ -z "${SHIPWRIGHT_GH_OWNER:-}" ]]; then
        cat >&2 <<'MSG'
git-credential-shipwright: SHIPWRIGHT_GH_OWNER is not set.
This agent serves several GitHub orgs and each org has its own token, so every
git command must say which org it targets via SHIPWRIGHT_GH_OWNER (the org that
owns the repo, e.g. app-vitals).
Retry with: SHIPWRIGHT_GH_OWNER=<org> git ...
Prefix each command with it, because shell state does not persist between
commands.
MSG
        exit 0
      fi
      owner=${SHIPWRIGHT_GH_OWNER,,}
      if [[ ! "$owner" =~ ^[a-z0-9][a-z0-9-]*$ || ! -f "$owner_dir/$owner" ]]; then
        echo "git-credential-shipwright: no GitHub App installation token for org '$owner': the installation is missing, broken or not in this agent's scope. Check the GitHub Installations card in the admin UI." >&2
        exit 0
      fi
      token_file="$owner_dir/$owner"
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
