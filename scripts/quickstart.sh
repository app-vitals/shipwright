#!/usr/bin/env bash
# scripts/quickstart.sh — Shipwright Harness system-level setup
#
# Idempotent: safe to run multiple times on the same repo.
# What it does:
#   1. Checks that bun and task (go-task) are available.
#   2. Runs bun install (installs / refreshes all workspace packages).
#   3. Prints next steps for the Claude Code session.
#
# Usage:
#   ./scripts/quickstart.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

bold() { printf '\033[1m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
red() { printf '\033[31m%s\033[0m' "$*"; }

check_dep() {
  local cmd="$1"
  local install_url="$2"
  if ! command -v "$cmd" &>/dev/null; then
    printf '%s  %s not found.\n' "$(red '✗')" "$(bold "$cmd")"
    printf '    Install: %s\n' "$install_url"
    return 1
  fi
  printf '%s  %s\n' "$(green '✓')" "$(bold "$cmd")"
  return 0
}

# ---------------------------------------------------------------------------
# Check dependencies
# ---------------------------------------------------------------------------

printf '\n%s\n' "$(bold 'Checking dependencies...')"

missing=0
check_dep bun  "https://bun.sh" || missing=1
check_dep task "https://taskfile.dev/installation/" || missing=1

if [ "$missing" -ne 0 ]; then
  printf '\n%s  One or more required tools are missing. Install them and re-run this script.\n\n' "$(red 'Error:')"
  exit 1
fi

# ---------------------------------------------------------------------------
# bun install
# ---------------------------------------------------------------------------

printf '\n%s\n' "$(bold 'Running bun install...')"
bun install
printf '%s  Dependencies installed.\n' "$(green '✓')"

# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------

printf '\n%s\n' "$(bold 'Setup complete. Next steps:')"
printf '\n'
printf '  1. Open Claude Code in this directory:\n'
printf '       %s\n' "$(bold 'claude')"
printf '\n'
printf '  2. Inside Claude Code, install the Shipwright plugin:\n'
printf '       %s\n' "$(bold '/plugin install shipwright@app-vitals/shipwright')"
printf '\n'
printf '  3. Start the dev server:\n'
printf '       %s\n' "$(bold 'task dev')"
printf '\n'
printf '     Dashboard opens at %s\n' "$(bold 'http://localhost:3460/dashboard')"
printf '\n'
