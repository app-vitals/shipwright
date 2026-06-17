#!/usr/bin/env bash
#
# .github/workflows/test-auto-bump-chart.sh
#
# Unit-tests the version-bump logic extracted from auto-bump-chart.yml.
# Tests pure bash arithmetic — no GitHub Actions, no network, no yq required.
#
# Run: bash .github/workflows/test-auto-bump-chart.sh
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
# Version bump logic (mirrors what the workflow does inline)
# ---------------------------------------------------------------------------

bump_patch() {
  local version="$1"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$version"
  patch=$(( patch + 1 ))
  echo "${major}.${minor}.${patch}"
}

# Read version from a Chart.yaml (uses grep + sed — same as the workflow).
# The workflow does: grep '^version:' Chart.yaml | sed 's/^version: //'
read_chart_version() {
  local chart_yaml="$1"
  grep '^version:' "$chart_yaml" | sed 's/^version: //'
}

# Update Chart.yaml version field (uses python3 — same as the workflow).
update_chart_version() {
  local chart_yaml="$1"
  local new_version="$2"
  python3 - "$chart_yaml" "$new_version" <<'PYEOF'
import sys, re

path = sys.argv[1]
new_ver = sys.argv[2]

with open(path, 'r') as f:
    content = f.read()

content = re.sub(r'^version:.*$', f'version: {new_ver}', content, flags=re.MULTILINE)

with open(path, 'w') as f:
    f.write(content)
PYEOF
}

# Update the artifacthub.io/changes annotation (uses python3 — same as the workflow).
update_artifact_hub_changes() {
  local chart_yaml="$1"
  local tag="$2"
  python3 - "$chart_yaml" "$tag" <<'PYEOF'
import sys, re

path = sys.argv[1]
tag  = sys.argv[2]

with open(path, 'r') as f:
    content = f.read()

# Replace the multiline artifacthub.io/changes block
new_block = (
    "  artifacthub.io/changes: |\n"
    f"    - kind: changed\n"
    f'      description: "auto-bump triggered by {tag}"\n'
)

content = re.sub(
    r'  artifacthub\.io/changes:.*?(?=\n\S|\Z)',
    new_block.rstrip('\n'),
    content,
    flags=re.DOTALL,
)

with open(path, 'w') as f:
    f.write(content)
PYEOF
}

# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

make_chart_yaml() {
  local version="$1"
  local path="$TMPDIR_TEST/Chart-${version//\./-}.yaml"
  cat > "$path" <<EOF
apiVersion: v2
name: shipwright
description: Test chart
type: application
version: ${version}
appVersion: "0.1.0"
annotations:
  licenses: MIT
  artifacthub.io/changes: |
    - kind: changed
      description: "previous change"
EOF
  echo "$path"
}

# ---------------------------------------------------------------------------
# Tests: bump_patch
# ---------------------------------------------------------------------------

echo ""
echo "=== bump_patch tests ==="

assert_eq "1.0.0 → 1.0.1"  "1.0.1"  "$(bump_patch '1.0.0')"
assert_eq "1.5.1 → 1.5.2"  "1.5.2"  "$(bump_patch '1.5.1')"
assert_eq "0.0.0 → 0.0.1"  "0.0.1"  "$(bump_patch '0.0.0')"
assert_eq "2.9.9 → 2.9.10" "2.9.10" "$(bump_patch '2.9.9')"
assert_eq "10.20.30 → 10.20.31" "10.20.31" "$(bump_patch '10.20.30')"

# ---------------------------------------------------------------------------
# Tests: read_chart_version
# ---------------------------------------------------------------------------

echo ""
echo "=== read_chart_version tests ==="

f=$(make_chart_yaml "1.5.1")
assert_eq "reads 1.5.1 from Chart.yaml" "1.5.1" "$(read_chart_version "$f")"

f2=$(make_chart_yaml "2.3.7")
assert_eq "reads 2.3.7 from Chart.yaml" "2.3.7" "$(read_chart_version "$f2")"

# ---------------------------------------------------------------------------
# Tests: update_chart_version
# ---------------------------------------------------------------------------

echo ""
echo "=== update_chart_version tests ==="

f3=$(make_chart_yaml "1.5.1")
update_chart_version "$f3" "1.5.2"
assert_eq "version updated to 1.5.2" "1.5.2" "$(read_chart_version "$f3")"

f4=$(make_chart_yaml "0.9.9")
update_chart_version "$f4" "0.9.10"
assert_eq "version updated to 0.9.10" "0.9.10" "$(read_chart_version "$f4")"

# ---------------------------------------------------------------------------
# Tests: update_artifact_hub_changes
# ---------------------------------------------------------------------------

echo ""
echo "=== update_artifact_hub_changes tests ==="

f5=$(make_chart_yaml "1.5.1")
update_artifact_hub_changes "$f5" "agent-v1.2.3"

CHANGES_CONTENT=$(grep -A3 'artifacthub.io/changes' "$f5" || true)
if echo "$CHANGES_CONTENT" | grep -q 'agent-v1.2.3'; then
  pass "changes annotation updated with triggering tag"
else
  fail "changes annotation updated with triggering tag" "contains agent-v1.2.3" "$CHANGES_CONTENT"
fi

if echo "$CHANGES_CONTENT" | grep -q 'kind: changed'; then
  pass "changes annotation has kind: changed"
else
  fail "changes annotation has kind: changed" "kind: changed" "$CHANGES_CONTENT"
fi

# ---------------------------------------------------------------------------
# Tests: full pipeline (read → bump → update → verify)
# ---------------------------------------------------------------------------

echo ""
echo "=== full pipeline test ==="

f6=$(make_chart_yaml "1.5.1")
CURRENT=$(read_chart_version "$f6")
NEW=$(bump_patch "$CURRENT")
update_chart_version "$f6" "$NEW"
update_artifact_hub_changes "$f6" "metrics-v0.5.0"

assert_eq "pipeline: final version" "1.5.2" "$(read_chart_version "$f6")"

if grep -q "metrics-v0.5.0" "$f6"; then
  pass "pipeline: tag appears in annotation"
else
  fail "pipeline: tag appears in annotation" "metrics-v0.5.0 in annotation" "not found"
fi

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
