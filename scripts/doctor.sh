#!/usr/bin/env bash
#
# scripts/doctor.sh — check the prerequisites Shipwright needs before a first run
#
# Usage:
#   ./scripts/doctor.sh                    # run from the repo you want Shipwright to work in
#   ./scripts/doctor.sh --skip-task-store  # skip the task-store env check (no store exists yet)
#   ./scripts/doctor.sh --help
#
# Checks:
#   1. bun is on PATH
#   2. gh is signed in (gh auth status)
#   3. the current directory is a git repo whose origin remote is on github.com
#   4. git user.name and user.email resolve in this repo (git config, any scope)
#   5. SHIPWRIGHT_TASK_STORE_URL and SHIPWRIGHT_TASK_STORE_TOKEN are set
#
# Prints one fix line per failure on stderr and exits 1 if any check fails. When
# every check passes it prints nothing and exits 0. Read-only: it never sets a git
# identity and never signs in to gh.

set -uo pipefail

usage() {
  sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'
}

SKIP_TASK_STORE=0
for arg in "$@"; do
  case "$arg" in
    --skip-task-store) SKIP_TASK_STORE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

FAILED=0
fail() {
  echo "FAIL: $*" >&2
  FAILED=1
}

# 1. bun
command -v bun >/dev/null 2>&1 \
  || fail "bun is not on PATH. Install it from https://bun.sh, then open a new terminal."

# 2. gh auth
if ! command -v gh >/dev/null 2>&1; then
  fail "gh is not installed. Install it from https://cli.github.com, then run: gh auth login"
elif ! gh auth status >/dev/null 2>&1; then
  fail "gh is not signed in. Run: gh auth login"
fi

# 3-4. git repo, GitHub remote, identity
if ! command -v git >/dev/null 2>&1; then
  fail "git is not installed. Install it from https://git-scm.com/downloads"
elif ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "This directory is not a git repo. cd into the repo Shipwright should work in (or: gh repo create <name> --private --clone)."
else
  origin_url="$(git remote get-url origin 2>/dev/null || true)"
  case "$origin_url" in
    *github.com*) ;;
    "") fail "This repo has no origin remote. Add one with: git remote add origin <github-url>" ;;
    *) fail "The origin remote is not on github.com ($origin_url). Point it at a GitHub repo with: git remote set-url origin <github-url>" ;;
  esac
  [ -n "$(git config user.name 2>/dev/null)" ] \
    || fail "git user.name is not set for this repo. Run: git config --global user.name \"Your Name\""
  [ -n "$(git config user.email 2>/dev/null)" ] \
    || fail "git user.email is not set for this repo. Run: git config --global user.email you@example.com"
fi

# 5. task-store env
if [ "$SKIP_TASK_STORE" = 0 ]; then
  if [ -z "${SHIPWRIGHT_TASK_STORE_URL:-}" ] || [ -z "${SHIPWRIGHT_TASK_STORE_TOKEN:-}" ]; then
    fail "SHIPWRIGHT_TASK_STORE_URL and SHIPWRIGHT_TASK_STORE_TOKEN must both be set. Run scripts/local-store.sh from a Shipwright clone, then source the env file it prints."
  fi
fi

exit "$FAILED"
