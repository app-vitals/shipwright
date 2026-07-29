#!/usr/bin/env bash
#
# .github/workflows/test-check-chart-drift.sh
#
# Unit-tests the logic behind check-chart-drift.yml: the shared
# service_for_tag / values_paths_for_service / highest_semver_tag functions
# (sourced from .github/workflows/lib/chart-tag-utils.sh) plus the
# drift-specific "read pinned tag from values.yaml" and "compute mismatches"
# logic (sourced from .github/workflows/lib/chart-drift-check.sh).
#
# Tests pure bash logic — no GitHub Actions, no network, no yq/python3
# required.
#
# Run: bash .github/workflows/test-check-chart-drift.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
# Source the shared libs under test. Sourcing must be side-effect free (no
# assertions run, no top-level `exit`) — that's the whole point of extracting
# these into lib/ instead of sourcing test-auto-bump-chart.sh directly (see
# check-chart-drift.yml's header comment for why sourcing that test file
# would be unsafe: no main-guard, runs its whole suite, and calls `exit`
# unconditionally at the bottom which would kill this script too).
# ---------------------------------------------------------------------------

# shellcheck source=lib/chart-tag-utils.sh
source "$SCRIPT_DIR/lib/chart-tag-utils.sh"
# shellcheck source=lib/chart-drift-check.sh
source "$SCRIPT_DIR/lib/chart-drift-check.sh"

# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# Fixture mirroring the shape of charts/shipwright/values.yaml's five
# image-tag-bearing service blocks (admin, metrics, agent + nested
# provisioning.image, taskStore, chat). Same shape as test-auto-bump-chart.sh's
# make_values_yaml fixture, with tags overridable per-block so drift/no-drift
# scenarios are easy to construct.
make_values_yaml() {
  local admin_tag="${1:-admin-v1.50.0}"
  local metrics_tag="${2:-metrics-v1.21.0}"
  local agent_tag="${3:-agent-v1.107.0}"
  local agent_prov_tag="${4:-agent-v1.107.0}"
  local task_store_tag="${5:-task-store-v1.28.0}"
  local chat_tag="${6:-chat-v1.19.0}"
  local path="$TMPDIR_TEST/values-$$-${RANDOM}.yaml"
  cat > "$path" <<EOF
admin:
  enabled: true
  image:
    repository: ghcr.io/app-vitals/shipwright-admin
    tag: ${admin_tag}
    pullPolicy: ""
  replicas: 1
metrics:
  enabled: true
  image:
    repository: ghcr.io/app-vitals/shipwright-metrics
    tag: ${metrics_tag}
    pullPolicy: ""
agent:
  enabled: true
  image:
    repository: ghcr.io/app-vitals/shipwright-agent
    tag: ${agent_tag}
    pullPolicy: ""
  provisioning:
    enabled: false
    namespace: ""
    image:
      repository: ghcr.io/app-vitals/shipwright-agent
      tag: ${agent_prov_tag}
    replicas: 1
taskStore:
  enabled: false
  image:
    repository: ghcr.io/app-vitals/shipwright-task-store
    tag: ${task_store_tag}
    pullPolicy: ""
chat:
  enabled: false
  image:
    repository: ghcr.io/app-vitals/shipwright-chat
    tag: ${chat_tag}
    pullPolicy: ""
EOF
  echo "$path"
}

# ---------------------------------------------------------------------------
# Tests: shared lib (chart-tag-utils.sh) sourced standalone
# ---------------------------------------------------------------------------

echo ""
echo "=== chart-tag-utils.sh: service_for_tag tests ==="

assert_eq "admin-v0.188.0 → admin" "admin" "$(service_for_tag 'admin-v0.188.0')"
assert_eq "metrics-v0.150.0 → metrics" "metrics" "$(service_for_tag 'metrics-v0.150.0')"
assert_eq "agent-v0.172.0 → agent" "agent" "$(service_for_tag 'agent-v0.172.0')"
assert_eq "task-store-v0.86.0 → task-store" "task-store" "$(service_for_tag 'task-store-v0.86.0')"
assert_eq "chat-v0.38.0 → chat" "chat" "$(service_for_tag 'chat-v0.38.0')"
assert_eq "unrecognized prefix → empty" "" "$(service_for_tag 'unknown-v1.0.0')"

echo ""
echo "=== chart-tag-utils.sh: values_paths_for_service tests ==="

assert_eq "admin → single path" "admin.image.tag" "$(values_paths_for_service 'admin' | paste -sd, -)"
assert_eq "metrics → single path" "metrics.image.tag" "$(values_paths_for_service 'metrics' | paste -sd, -)"
assert_eq "task-store → taskStore.image.tag" "taskStore.image.tag" "$(values_paths_for_service 'task-store' | paste -sd, -)"
assert_eq "chat → single path" "chat.image.tag" "$(values_paths_for_service 'chat' | paste -sd, -)"
assert_eq "agent → dual path (image.tag AND provisioning.image.tag)" \
  "agent.image.tag,agent.provisioning.image.tag" \
  "$(values_paths_for_service 'agent' | paste -sd, -)"

echo ""
echo "=== chart-tag-utils.sh: highest_semver_tag tests ==="

assert_eq "single tag is a no-op" "agent-v1.107.0" "$(highest_semver_tag 'agent-v1.107.0')"
assert_eq "picks higher patch" "admin-v1.50.1" "$(highest_semver_tag 'admin-v1.50.0' 'admin-v1.50.1')"
assert_eq "picks higher patch regardless of arg order" "admin-v1.50.1" "$(highest_semver_tag 'admin-v1.50.1' 'admin-v1.50.0')"
assert_eq "picks higher minor" "metrics-v1.22.0" "$(highest_semver_tag 'metrics-v1.21.9' 'metrics-v1.22.0')"
assert_eq "picks higher major" "chat-v2.0.0" "$(highest_semver_tag 'chat-v1.19.9' 'chat-v2.0.0')"
assert_eq "double-digit patch beats single-digit (not lexicographic)" "agent-v1.107.10" "$(highest_semver_tag 'agent-v1.107.2' 'agent-v1.107.10')"
assert_eq "three-way batch picks the max" "task-store-v1.28.2" "$(highest_semver_tag 'task-store-v1.28.0' 'task-store-v1.28.2' 'task-store-v1.28.1')"

# ---------------------------------------------------------------------------
# Tests: read_pinned_tag (chart-drift-check.sh)
# ---------------------------------------------------------------------------

echo ""
echo "=== read_pinned_tag tests ==="

v1=$(make_values_yaml)
assert_eq "reads admin.image.tag" "admin-v1.50.0" "$(read_pinned_tag "$v1" "admin.image.tag")"
assert_eq "reads metrics.image.tag" "metrics-v1.21.0" "$(read_pinned_tag "$v1" "metrics.image.tag")"
assert_eq "reads agent.image.tag (top-level, not the nested one)" "agent-v1.107.0" "$(read_pinned_tag "$v1" "agent.image.tag")"
assert_eq "reads agent.provisioning.image.tag (nested case)" "agent-v1.107.0" "$(read_pinned_tag "$v1" "agent.provisioning.image.tag")"
assert_eq "reads taskStore.image.tag" "task-store-v1.28.0" "$(read_pinned_tag "$v1" "taskStore.image.tag")"
assert_eq "reads chat.image.tag" "chat-v1.19.0" "$(read_pinned_tag "$v1" "chat.image.tag")"

# Distinct values at agent.image.tag vs agent.provisioning.image.tag — proves
# the reader is indentation/path-scoped, not a blind grep for the first "tag:"
# match under an "agent:" heading.
v2=$(make_values_yaml "admin-v1.50.0" "metrics-v1.21.0" "agent-v1.107.0" "agent-v1.99.0")
assert_eq "agent.image.tag independent of provisioning nested tag" "agent-v1.107.0" "$(read_pinned_tag "$v2" "agent.image.tag")"
assert_eq "agent.provisioning.image.tag independent of top-level tag" "agent-v1.99.0" "$(read_pinned_tag "$v2" "agent.provisioning.image.tag")"

# ---------------------------------------------------------------------------
# Tests: compute_drift (chart-drift-check.sh)
# ---------------------------------------------------------------------------

echo ""
echo "=== compute_drift tests: no mismatches ==="

v3=$(make_values_yaml)
LATEST_IN_SYNC="admin=admin-v1.50.0
metrics=metrics-v1.21.0
agent=agent-v1.107.0
task-store=task-store-v1.28.0
chat=chat-v1.19.0"

MISMATCHES_NONE=$(compute_drift "$v3" "$LATEST_IN_SYNC")
assert_eq "fully in sync → no mismatches" "" "$MISMATCHES_NONE"

echo ""
echo "=== compute_drift tests: single mismatch ==="

v4=$(make_values_yaml "admin-v1.49.0")
LATEST_ADMIN_AHEAD="admin=admin-v1.50.0
metrics=metrics-v1.21.0
agent=agent-v1.107.0
task-store=task-store-v1.28.0
chat=chat-v1.19.0"

MISMATCHES_ONE=$(compute_drift "$v4" "$LATEST_ADMIN_AHEAD")
assert_eq "one line reported for one mismatch" "1" "$(echo "$MISMATCHES_ONE" | grep -c '^MISMATCH:')"
if echo "$MISMATCHES_ONE" | grep -qF "MISMATCH: service=admin path=admin.image.tag expected=admin-v1.50.0 actual=admin-v1.49.0"; then
  pass "mismatch line has expected format and values"
else
  fail "mismatch line has expected format and values" "MISMATCH: service=admin path=admin.image.tag expected=admin-v1.50.0 actual=admin-v1.49.0" "$MISMATCHES_ONE"
fi

echo ""
echo "=== compute_drift tests: multiple mismatches across multiple services (no fail-fast) ==="

v5=$(make_values_yaml "admin-v1.49.0" "metrics-v1.21.0" "agent-v1.106.0" "agent-v1.106.0" "task-store-v1.27.0")
LATEST_MULTI="admin=admin-v1.50.0
metrics=metrics-v1.21.0
agent=agent-v1.107.0
task-store=task-store-v1.28.0
chat=chat-v1.19.0"

MISMATCHES_MULTI=$(compute_drift "$v5" "$LATEST_MULTI")
# admin (1) + agent (2 paths) + task-store (1) = 4 mismatch lines; metrics and
# chat stay in sync and must NOT appear.
assert_eq "collects all mismatches, not just the first" "4" "$(echo "$MISMATCHES_MULTI" | grep -c '^MISMATCH:')"

if echo "$MISMATCHES_MULTI" | grep -qF "service=admin path=admin.image.tag expected=admin-v1.50.0 actual=admin-v1.49.0"; then
  pass "multi: admin mismatch present"
else
  fail "multi: admin mismatch present" "admin mismatch line" "$MISMATCHES_MULTI"
fi

if echo "$MISMATCHES_MULTI" | grep -qF "service=agent path=agent.image.tag expected=agent-v1.107.0 actual=agent-v1.106.0"; then
  pass "multi: agent top-level mismatch present"
else
  fail "multi: agent top-level mismatch present" "agent.image.tag mismatch line" "$MISMATCHES_MULTI"
fi

if echo "$MISMATCHES_MULTI" | grep -qF "service=agent path=agent.provisioning.image.tag expected=agent-v1.107.0 actual=agent-v1.106.0"; then
  pass "multi: agent provisioning-nested mismatch present"
else
  fail "multi: agent provisioning-nested mismatch present" "agent.provisioning.image.tag mismatch line" "$MISMATCHES_MULTI"
fi

if echo "$MISMATCHES_MULTI" | grep -qF "service=task-store path=taskStore.image.tag expected=task-store-v1.28.0 actual=task-store-v1.27.0"; then
  pass "multi: task-store mismatch present"
else
  fail "multi: task-store mismatch present" "taskStore.image.tag mismatch line" "$MISMATCHES_MULTI"
fi

if echo "$MISMATCHES_MULTI" | grep -q 'service=metrics'; then
  fail "multi: metrics (in sync) must NOT be reported" "no metrics line" "$MISMATCHES_MULTI"
else
  pass "multi: metrics (in sync) not reported"
fi

if echo "$MISMATCHES_MULTI" | grep -q 'service=chat'; then
  fail "multi: chat (in sync) must NOT be reported" "no chat line" "$MISMATCHES_MULTI"
else
  pass "multi: chat (in sync) not reported"
fi

echo ""
echo "=== compute_drift tests: agent's two paths can drift independently ==="

# Top-level agent.image.tag matches latest but the nested provisioning tag
# lags — must report exactly the provisioning path, not the top-level one.
v6=$(make_values_yaml "admin-v1.50.0" "metrics-v1.21.0" "agent-v1.107.0" "agent-v1.106.0")
LATEST_AGENT_ONLY="admin=admin-v1.50.0
metrics=metrics-v1.21.0
agent=agent-v1.107.0
task-store=task-store-v1.28.0
chat=chat-v1.19.0"

MISMATCHES_AGENT=$(compute_drift "$v6" "$LATEST_AGENT_ONLY")
assert_eq "only the nested provisioning path is reported" "1" "$(echo "$MISMATCHES_AGENT" | grep -c '^MISMATCH:')"
if echo "$MISMATCHES_AGENT" | grep -qF "service=agent path=agent.provisioning.image.tag expected=agent-v1.107.0 actual=agent-v1.106.0"; then
  pass "nested provisioning mismatch correctly isolated from top-level"
else
  fail "nested provisioning mismatch correctly isolated from top-level" "provisioning-only mismatch" "$MISMATCHES_AGENT"
fi

# ---------------------------------------------------------------------------
# Tests: highest_semver_tag drives "latest tag" selection from a git-tag list
# (mirrors how the workflow step will pick the winner among `git tag -l`
# output for a given service prefix before calling compute_drift).
# ---------------------------------------------------------------------------

echo ""
echo "=== git-tag-derived latest tag tests ==="

GIT_TEST_DIR="$TMPDIR_TEST/git-tags-test"
mkdir -p "$GIT_TEST_DIR"
(
  cd "$GIT_TEST_DIR"
  git init -q
  git config user.email "test@test.com"
  git config user.name "test"
  echo hi > README.md
  git add -A
  git commit -q -m "init"
  git tag admin-v1.50.0
  git tag admin-v1.50.2
  git tag admin-v1.50.1
  git tag metrics-v1.21.0
)

ADMIN_TAGS=$(cd "$GIT_TEST_DIR" && git tag -l 'admin-v*')
LATEST_ADMIN=$(highest_semver_tag $ADMIN_TAGS)
assert_eq "highest_semver_tag picks v1.50.2 among 3 git tags" "admin-v1.50.2" "$LATEST_ADMIN"

METRICS_TAGS=$(cd "$GIT_TEST_DIR" && git tag -l 'metrics-v*')
LATEST_METRICS=$(highest_semver_tag $METRICS_TAGS)
assert_eq "highest_semver_tag single-tag case from git" "metrics-v1.21.0" "$LATEST_METRICS"

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
