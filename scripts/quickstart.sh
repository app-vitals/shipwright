#!/usr/bin/env bash
#
# scripts/quickstart.sh — one-command local onboarding for Shipwright Harness.
#
# Run this AFTER you have cloned the repo and cd'd into it. The clone step lives
# in the copy-paste prompt (see docs/quickstart.md / the README Quickstart
# section), not inside this script, so this script is safe to run repeatedly
# from inside a checkout.
#
# What it does (deterministic, idempotent):
#   1. Verifies prerequisites: git, bun, and the `task` (go-task) binary.
#   2. Runs `task setup` (idempotent `bun install` across all workspaces).
#   3. Starts the metrics dashboard via `task dev` (offline by default —
#      fixtures-backed, no accounts, no database needed) → http://localhost:3460/dashboard
#
# Offline by default: `task dev` bakes in METRICS_OFFLINE=true, so the dashboard
# serves from fixtures with no external accounts or secrets.
#
# CI / testing guard:
#   Set QUICKSTART_SKIP_SERVE to a non-empty value (e.g. QUICKSTART_SKIP_SERVE=1)
#   to run every deterministic step (prereq checks + `task setup` + the
#   next-steps message) and then exit 0 WITHOUT starting the long-running
#   `task dev` server. This is what the smoke test uses so CI never blocks on a
#   server. Unset (the default), the script execs `task dev` as its final step.
#
set -euo pipefail

DASHBOARD_URL="http://localhost:3460/dashboard"

# --- prerequisite checks (read-only; safe to re-run) ------------------------

require() {
  local bin="$1"
  local hint="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: required tool '$bin' was not found on your PATH." >&2
    echo "       $hint" >&2
    exit 1
  fi
}

echo "[quickstart] checking prerequisites (git, bun, task)..."
require git "Install git: https://git-scm.com/downloads"
require bun "Install Bun: https://bun.sh"
require task "Install go-task: https://taskfile.dev/installation/"

# Note: Claude Code itself is a prerequisite for the /plugin install step of the
# onboarding prompt, but it is NOT needed by this script — so we do not check
# for it here. See docs/quickstart.md for the full prompt.

# --- dependency install (idempotent) ----------------------------------------

echo "[quickstart] installing dependencies (task setup)..."
task setup

# --- next steps -------------------------------------------------------------

echo ""
echo "[quickstart] setup complete."
echo "[quickstart] The metrics dashboard runs offline by default — fixtures-"
echo "[quickstart] backed, with no accounts and no database required."
echo ""
echo "[quickstart] Open the dashboard at: ${DASHBOARD_URL}"
echo "[quickstart] Starting the dev supervisor (task dev) — press Ctrl-C to stop."
echo ""

# --- serve (guarded for CI) -------------------------------------------------

if [ -n "${QUICKSTART_SKIP_SERVE:-}" ]; then
  echo "[quickstart] QUICKSTART_SKIP_SERVE is set — skipping 'task dev' (CI/testing mode)."
  exit 0
fi

exec task dev
