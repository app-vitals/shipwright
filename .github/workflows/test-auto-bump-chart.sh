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

# Update the artifacthub.io/changes annotation with one entry per batched tag
# (uses python3 — same as the workflow's "Update artifacthub.io/changes
# annotation" step). tags_csv is a comma-separated list, e.g. "a-v1,b-v2".
update_artifact_hub_changes() {
  local chart_yaml="$1"
  local tags_csv="$2"
  local ver="${3:-0.0.0}"
  python3 - "$chart_yaml" "$tags_csv" "$ver" <<'PYEOF'
import sys, re

path, tags_csv, ver = sys.argv[1], sys.argv[2], sys.argv[3]
tags = [t for t in tags_csv.split(',') if t]

with open(path, 'r') as f:
    content = f.read()

lines = ["  artifacthub.io/changes: |"]
for tag in tags:
    lines.append("    - kind: changed")
    lines.append(f'      description: "auto-bump to chart v{ver} triggered by release tag {tag}"')
new_block = "\n".join(lines)

content = re.sub(
    r'  artifacthub\.io/changes:.*?(?=\n\S|\Z)',
    new_block,
    content,
    flags=re.DOTALL,
)

with open(path, 'w') as f:
    f.write(content)
PYEOF
}

# Formats a comma-separated tag list into the backtick-quoted, comma-space
# joined form used in the CHANGELOG.md entry (mirrors the "Update
# CHANGELOG.md" step's TAGS_LIST computation).
format_changelog_tags() {
  local tags_csv="$1"
  echo "$tags_csv" | tr ',' '\n' | sed 's/^/`/; s/$/`/' | paste -sd, - | sed 's/,/, /g'
}

# Collects every release tag pushed since the last chart-bump commit, falling
# back to the triggering tag alone if no prior bump commit exists. Mirrors
# the "Collect release tags in this batch" step — must be run inside a git
# repo with charts/shipwright/Chart.yaml present in history.
collect_batch_tags() {
  local trigger_tag="$1"
  local patterns=("agent-v*" "admin-v*" "metrics-v*" "task-store-v*" "chat-v*")

  local last_bump_sha
  last_bump_sha=$(git log -1 --format=%H --grep='^chore(chart): bump chart version' -- charts/shipwright/Chart.yaml || true)

  local since=""
  if [ -n "$last_bump_sha" ]; then
    since=$(git log -1 --format=%cI "$last_bump_sha")
  fi

  local tags=()
  if [ -n "$since" ]; then
    for pattern in "${patterns[@]}"; do
      while IFS= read -r line; do
        [ -z "$line" ] && continue
        tags+=("$line")
      done < <(git for-each-ref "refs/tags/${pattern}" \
        --format='%(creatordate:iso-strict)|%(refname:short)' \
        | awk -F'|' -v since="$since" '$1 > since { print $2 }')
    done
  fi

  local found=false
  for t in "${tags[@]:-}"; do
    [ "$t" = "$trigger_tag" ] && found=true
  done
  if [ "$found" = "false" ]; then
    tags+=("$trigger_tag")
  fi

  printf '%s\n' "${tags[@]}" | sort -u | paste -sd, -
}

# ---------------------------------------------------------------------------
# Stale-base merge-retry logic (mirrors the "Wait for checks and merge" step)
#
# gh pr merge --admin can fail with a transient GraphQL error when a
# concurrent workflow (e.g. sync-plugin-version.yml) merges its own PR first
# and moves main out from under this one — "Base branch was modified. Review
# and try the merge again." This is NOT a real conflict; it resolves itself on
# retry once the base ref settles. is_stale_base_error() matches on "Base
# branch was modified" alone — that phrase is unambiguous and always present
# in the real error text, so matching on it is sufficient. Any other merge
# failure (real conflict, auth error, branch protection rejection, etc.) must
# NOT match — those should fail fast.
# ---------------------------------------------------------------------------

# Mirrors the function of the same name inlined in auto-bump-chart.yml's
# "Wait for checks and merge" step. Keep both copies in sync.
is_stale_base_error() {
  local output="$1"
  if echo "$output" | grep -qi "Base branch was modified"; then
    return 0
  fi
  return 1
}

echo ""
echo "=== is_stale_base_error tests ==="

if is_stale_base_error "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)"; then
  pass "real stale-base GraphQL error text → true"
else
  fail "real stale-base GraphQL error text → true" "true (match)" "false (no match)"
fi

if is_stale_base_error "GraphQL: the base branch policy prohibits the merge (mergePullRequest)"; then
  fail "unrelated error text → false" "false (no match)" "true (match)"
else
  pass "unrelated error text → false"
fi

if is_stale_base_error "GraphQL: some other conflict, try the merge again later (mergePullRequest)"; then
  fail "'try the merge again' without 'Base branch was modified' → false" "false (no match)" "true (match)"
else
  pass "'try the merge again' without 'Base branch was modified' → false"
fi

if is_stale_base_error ""; then
  fail "empty string → false" "false (no match)" "true (match)"
else
  pass "empty string → false"
fi

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
update_artifact_hub_changes "$f5" "agent-v1.2.3" "1.5.2"

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

f5b=$(make_chart_yaml "1.5.1")
update_artifact_hub_changes "$f5b" "admin-v0.156.0,agent-v0.144.0" "1.5.2"

BATCH_CONTENT=$(cat "$f5b")
if echo "$BATCH_CONTENT" | grep -q 'admin-v0.156.0' && echo "$BATCH_CONTENT" | grep -q 'agent-v0.144.0'; then
  pass "batched tags both appear in annotation"
else
  fail "batched tags both appear in annotation" "both admin-v0.156.0 and agent-v0.144.0 present" "$BATCH_CONTENT"
fi

ENTRY_COUNT=$(echo "$BATCH_CONTENT" | grep -c 'kind: changed')
assert_eq "one 'kind: changed' entry per batched tag" "2" "$ENTRY_COUNT"

# ---------------------------------------------------------------------------
# Tests: format_changelog_tags
# ---------------------------------------------------------------------------

echo ""
echo "=== format_changelog_tags tests ==="

assert_eq "single tag" '`agent-v1.2.3`' "$(format_changelog_tags 'agent-v1.2.3')"
assert_eq "two tags" '`admin-v0.156.0`, `agent-v0.144.0`' "$(format_changelog_tags 'admin-v0.156.0,agent-v0.144.0')"

# ---------------------------------------------------------------------------
# Tests: collect_batch_tags
# ---------------------------------------------------------------------------

echo ""
echo "=== collect_batch_tags tests ==="

GIT_TEST_DIR="$TMPDIR_TEST/git-batch-test"
mkdir -p "$GIT_TEST_DIR/charts/shipwright"
(
  cd "$GIT_TEST_DIR"
  git init -q
  git config user.email "test@test.com"
  git config user.name "test"

  cat > charts/shipwright/Chart.yaml <<'EOF'
apiVersion: v2
name: shipwright
version: 1.6.284
EOF
  git add -A
  GIT_AUTHOR_DATE="2026-07-06T09:00:00-07:00" GIT_COMMITTER_DATE="2026-07-06T09:00:00-07:00" \
    git commit -q -m "chore(chart): bump chart version to 1.6.284"

  GIT_COMMITTER_DATE="2026-07-06T09:50:00-07:00" git tag -a admin-v0.156.0 -m "x"
  GIT_COMMITTER_DATE="2026-07-06T09:52:00-07:00" git tag -a agent-v0.144.0 -m "x"
)

BATCHED=$(cd "$GIT_TEST_DIR" && collect_batch_tags "agent-v0.144.0")
assert_eq "batches both tags landed after the last bump commit" "admin-v0.156.0,agent-v0.144.0" "$BATCHED"

# Fresh repo with no prior chart-bump commit — falls back to the triggering
# tag alone, even though a tag exists that would otherwise be in range.
GIT_TEST_DIR2="$TMPDIR_TEST/git-fallback-test"
mkdir -p "$GIT_TEST_DIR2"
(
  cd "$GIT_TEST_DIR2"
  git init -q
  git config user.email "test@test.com"
  git config user.name "test"
  echo hi > README.md
  git add -A
  git commit -q -m "init"
  git tag -a metrics-v1.0.0 -m "x"
)

FALLBACK=$(cd "$GIT_TEST_DIR2" && collect_batch_tags "metrics-v1.0.0")
assert_eq "falls back to triggering tag with no prior bump commit" "metrics-v1.0.0" "$FALLBACK"

# ---------------------------------------------------------------------------
# Tests: full pipeline (read → bump → update → verify), batched tags
# ---------------------------------------------------------------------------

echo ""
echo "=== full pipeline test ==="

f6=$(make_chart_yaml "1.5.1")
CURRENT=$(read_chart_version "$f6")
NEW=$(bump_patch "$CURRENT")
update_chart_version "$f6" "$NEW"
update_artifact_hub_changes "$f6" "metrics-v0.5.0,admin-v0.5.1" "$NEW"

assert_eq "pipeline: final version" "1.5.2" "$(read_chart_version "$f6")"

if grep -q "metrics-v0.5.0" "$f6" && grep -q "admin-v0.5.1" "$f6"; then
  pass "pipeline: both batched tags appear in annotation"
else
  fail "pipeline: both batched tags appear in annotation" "metrics-v0.5.0 and admin-v0.5.1 in annotation" "not found"
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
