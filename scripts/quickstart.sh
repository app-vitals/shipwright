#!/bin/sh
# scripts/quickstart.sh
#
# Idempotent quickstart script for Shipwright Harness.
# Checks prerequisites (bun, go-task) and runs `task setup`.
#
# Usage:
#   ./scripts/quickstart.sh           # check prereqs and run task setup
#   ./scripts/quickstart.sh --check   # check prereqs only, exit 0 if all met
#   ./scripts/quickstart.sh --help    # show usage
#
# Prerequisites:
#   bun      — https://bun.sh
#   go-task  — https://taskfile.dev

set -e

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

print_ok()  { printf '  [ok] %s\n' "$1"; }
print_err() { printf '  [!!] %s\n' "$1" >&2; }
print_info(){ printf '  [..] %s\n' "$1"; }

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
quickstart.sh — Shipwright Harness setup

Usage:
  ./scripts/quickstart.sh           Check prerequisites and run task setup
  ./scripts/quickstart.sh --check   Check prerequisites only (no side effects)
  ./scripts/quickstart.sh --help    Show this help

Prerequisites:
  bun      JavaScript runtime and package manager — https://bun.sh
  task     go-task task runner — https://taskfile.dev

What it does (no-flag mode):
  1. Verifies bun and task are available
  2. Runs: task setup  (installs all dependencies via bun install)
  3. Exits 0; safe to re-run (idempotent)
EOF
}

# ---------------------------------------------------------------------------
# Prerequisite check
# ---------------------------------------------------------------------------

check_prereqs() {
  local missing=0

  # Check bun
  if command -v bun >/dev/null 2>&1; then
    print_ok "bun found: $(bun --version)"
  else
    print_err "bun not found. Install from: https://bun.sh"
    missing=1
  fi

  # Check task (go-task)
  if command -v task >/dev/null 2>&1; then
    print_ok "task (go-task) found: $(task --version 2>&1 | head -1)"
  else
    print_err "task (go-task) not found. Install from: https://taskfile.dev"
    missing=1
  fi

  return $missing
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  --check)
    printf 'Checking prerequisites...\n'
    if check_prereqs; then
      printf '\nAll prerequisites met.\n'
      exit 0
    else
      printf '\nOne or more prerequisites are missing. See above.\n' >&2
      exit 1
    fi
    ;;
  "")
    printf 'Checking prerequisites...\n'
    if ! check_prereqs; then
      printf '\nOne or more prerequisites are missing. See above.\n' >&2
      exit 1
    fi
    printf '\nAll prerequisites met. Running task setup...\n'
    task setup
    printf '\nSetup complete. Start the dashboard with: task api\n'
    exit 0
    ;;
  *)
    printf 'Unknown option: %s\n' "$1" >&2
    usage >&2
    exit 1
    ;;
esac
