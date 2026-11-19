#!/usr/bin/env bash
#
# .github/workflows/test-library-pin.sh
#
# Tests lib/library-pin.sh's bump_library_pin: re-pins the agent-platform
# dependency in Chart.yaml / Chart.lock and nothing else. The chart version,
# CHANGELOG and artifacthub annotation are no longer touched at bump time:
# chart-release.yml derives them at publish time (ADR 0001).
#
# Run: bash .github/workflows/test-library-pin.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$(( PASS + 1 )); }
fail() { echo "  FAIL: $1 — expected '$2', got '$3'"; FAIL=$(( FAIL + 1 )); }
assert_eq() {
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "$2" "$3"; fi
}

# shellcheck source=lib/library-pin.sh
source "$SCRIPT_DIR/lib/library-pin.sh"

read_chart_version() { sed -n 's/^version: //p' "$1" | head -n1; }

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

make_chart_dir() {
  local lib_version="${1:-0.3.0}" chart_version="${2:-1.30.0}"
  local dir
  dir="$(mktemp -d "$TMPROOT/chart.XXXXXX")"
  cat > "$dir/Chart.yaml" <<EOY
apiVersion: v2
name: shipwright
version: ${chart_version}
appVersion: "0.1.0"
annotations:
  licenses: MIT
  artifacthub.io/changes: |
    - kind: changed
      description: "previous change"
dependencies:
  - name: agent-platform
    version: "${lib_version}"
    repository: https://app-vitals.github.io/agent
  - name: postgresql
    version: "18.12.4"
    repository: oci://registry-1.docker.io/bitnamicharts
    condition: postgresql.enabled
EOY
  cat > "$dir/Chart.lock" <<EOY
dependencies:
- name: agent-platform
  repository: https://app-vitals.github.io/agent
  version: ${lib_version}
- name: postgresql
  repository: oci://registry-1.docker.io/bitnamicharts
  version: 18.12.4
digest: sha256:abc
generated: "2026-10-27T00:00:00Z"
EOY
  cat > "$dir/CHANGELOG.md" <<EOY
# Changelog

## [${chart_version}] - 2026-10-26
EOY
  echo "$dir"
}

echo "=== library pin bump tests ==="

d=$(make_chart_dir 0.3.0 1.30.0)
cp "$d/CHANGELOG.md" "$d/CHANGELOG.orig"
bump_library_pin "$d" "0.4.0"
assert_eq "Chart.yaml dependency pin" "0.4.0" "$(library_pin_from_chart "$d/Chart.yaml")"
assert_eq "Chart.lock pin" "0.4.0" "$(library_pin_from_lock "$d/Chart.lock")"
assert_eq "chart version is NOT bumped (derived at publish time)" "1.30.0" "$(read_chart_version "$d/Chart.yaml")"
assert_eq "artifacthub annotation untouched" "1" "$(grep -c 'previous change' "$d/Chart.yaml")"
assert_eq "CHANGELOG untouched" "" "$(diff "$d/CHANGELOG.md" "$d/CHANGELOG.orig")"
assert_eq "postgresql pin untouched in Chart.yaml" "1" "$(grep -c '"18.12.4"' "$d/Chart.yaml")"
assert_eq "postgresql pin untouched in Chart.lock" "1" "$(grep -c 'version: 18.12.4' "$d/Chart.lock")"
assert_eq "dependencies key intact" "1" "$(grep -c '^dependencies:' "$d/Chart.yaml")"
printf 'entries:\n  agent-platform:\n  - version: 0.4.0\n' > "$d/index.yaml"
assert_eq "no drift against the version just pinned" "" \
  "$(compute_library_drift "$d/Chart.yaml" "$d/Chart.lock" "$d/index.yaml")"

d2=$(make_chart_dir 0.4.0 1.30.1)
cp "$d2/Chart.yaml" "$d2/Chart.yaml.orig"
bump_library_pin "$d2" "0.4.0"
assert_eq "same version is a no-op" "" "$(diff "$d2/Chart.yaml" "$d2/Chart.yaml.orig")"

d3=$(make_chart_dir 0.5.0 1.31.0)
bump_library_pin "$d3" "0.4.0" 2>/dev/null
assert_eq "older version does not downgrade" "0.5.0" "$(library_pin_from_chart "$d3/Chart.yaml")"

for bad in "" "1.2" "v1.2.3" "1.2.3-rc1" '1.2.3"; rm -rf /' "1.2.3 "; do
  d4=$(make_chart_dir 0.3.0 1.30.0)
  if bump_library_pin "$d4" "$bad" 2>/dev/null; then
    fail "rejects invalid version '$bad'" "non-zero exit" "exit 0"
  else
    pass "rejects invalid version '$bad'"
  fi
  assert_eq "invalid version '$bad' leaves the pin untouched" "0.3.0" "$(library_pin_from_chart "$d4/Chart.yaml")"
done

d5=$(make_chart_dir 0.3.0 1.30.0)
sed -i 's/name: agent-platform/name: other/' "$d5/Chart.yaml"
if bump_library_pin "$d5" "0.4.0" 2>/dev/null; then
  fail "errors when agent-platform dependency is missing" "non-zero exit" "exit 0"
else
  pass "errors when agent-platform dependency is missing"
fi

echo ""
echo "================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "================================"
[[ $FAIL -gt 0 ]] && exit 1
exit 0
