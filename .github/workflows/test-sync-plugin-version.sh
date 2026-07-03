#!/usr/bin/env bash
#
# .github/workflows/test-sync-plugin-version.sh
#
# Unit-tests the tag-parsing and idempotency logic extracted from
# sync-plugin-version.yml. Tests pure bash string manipulation — no GitHub
# Actions, no network, no bun required.
#
# Run: bash .github/workflows/test-sync-plugin-version.sh
#
set -euo pipefail

PASS=0
FAIL=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass() { echo "  PASS: $1"; PASS=$(( PASS + 1 )); }
fail() { echo "  FAIL: $1 — expected '$2', got '$3'"; FAIL=$(( FAIL + 1 )); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label" "$expected" "$actual"
  fi
}

# ---------------------------------------------------------------------------
# Tag-parsing logic (mirrors what the workflow does inline)
# ---------------------------------------------------------------------------

# Parse the bare semver off an agent-v* tag name (same as the workflow's
# "Parse version from tag" step): TAG="${GITHUB_REF_NAME}"; VERSION="${TAG#agent-v}"
parse_version() {
  local tag="$1"
  echo "${tag#agent-v}"
}

# Compute the sync branch name from a version (same as the workflow).
branch_name() {
  local version="$1"
  echo "chore/plugin-version-v${version}"
}

# ---------------------------------------------------------------------------
# Tests: parse_version
# ---------------------------------------------------------------------------

echo ""
echo "=== parse_version tests ==="

assert_eq "agent-v0.116.0 → 0.116.0"   "0.116.0"   "$(parse_version 'agent-v0.116.0')"
assert_eq "agent-v1.0.0 → 1.0.0"       "1.0.0"     "$(parse_version 'agent-v1.0.0')"
assert_eq "agent-v0.0.1 → 0.0.1"       "0.0.1"     "$(parse_version 'agent-v0.0.1')"
assert_eq "agent-v10.20.30 → 10.20.30" "10.20.30"  "$(parse_version 'agent-v10.20.30')"

# ---------------------------------------------------------------------------
# Tests: branch_name
# ---------------------------------------------------------------------------

echo ""
echo "=== branch_name tests ==="

assert_eq "branch for 0.116.0" "chore/plugin-version-v0.116.0" "$(branch_name '0.116.0')"
assert_eq "branch for 1.0.0"   "chore/plugin-version-v1.0.0"   "$(branch_name '1.0.0')"

# ---------------------------------------------------------------------------
# Tests: idempotency guard (git ls-remote --heads matching, no network)
# ---------------------------------------------------------------------------

echo ""
echo "=== idempotency guard tests ==="

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# Set up a bare "remote" repo with one existing branch to check against.
REMOTE="$TMPDIR_TEST/remote.git"
git init --bare -q "$REMOTE"

CLONE="$TMPDIR_TEST/clone"
git clone -q "$REMOTE" "$CLONE"
(
  cd "$CLONE"
  git config user.email "test@example.com"
  git config user.name "Test"
  git commit -q --allow-empty -m "init"
  git push -q origin main 2>/dev/null || git push -q origin HEAD:main
  git checkout -q -b "chore/plugin-version-v0.116.0"
  git commit -q --allow-empty -m "chore: existing sync branch"
  git push -q origin "chore/plugin-version-v0.116.0"
)

branch_exists_on_remote() {
  local remote="$1" branch="$2"
  if git ls-remote --heads "$remote" "$branch" | grep -q .; then
    echo "true"
  else
    echo "false"
  fi
}

assert_eq "existing branch detected" "true"  "$(branch_exists_on_remote "$REMOTE" 'chore/plugin-version-v0.116.0')"
assert_eq "new branch not detected"  "false" "$(branch_exists_on_remote "$REMOTE" 'chore/plugin-version-v0.117.0')"

# ---------------------------------------------------------------------------
# Tests: full pipeline (tag → version → branch)
# ---------------------------------------------------------------------------

echo ""
echo "=== full pipeline test ==="

TAG="agent-v2.3.7"
VERSION=$(parse_version "$TAG")
BRANCH=$(branch_name "$VERSION")

assert_eq "pipeline: version" "2.3.7" "$VERSION"
assert_eq "pipeline: branch"  "chore/plugin-version-v2.3.7" "$BRANCH"

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

echo ""
echo "================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "================================"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
