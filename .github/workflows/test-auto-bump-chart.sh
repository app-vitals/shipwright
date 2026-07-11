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

# Maps a release tag prefix to its service key, used to key both the
# values.yaml path table below and the highest-semver grouping in
# select_pinned_tags(). Mirrors the "Pin released tags into values.yaml"
# step's SERVICE_FOR_PREFIX lookup — must stay in sync with the tag prefixes
# in this workflow's `on.push.tags` list.
service_for_tag() {
  local tag="$1"
  case "$tag" in
    admin-v*) echo "admin" ;;
    metrics-v*) echo "metrics" ;;
    agent-v*) echo "agent" ;;
    task-store-v*) echo "task-store" ;;
    chat-v*) echo "chat" ;;
    *) echo "" ;;
  esac
}

# Maps a service key to the values.yaml dot-paths that must be pinned to its
# released tag, one path per line. The agent service pins two paths from the
# same agent-v* tag: the top-level agent image and the admin-provisioned
# agent image nested under agent.provisioning. Mirrors the "Pin released
# tags into values.yaml" step's VALUES_PATHS_FOR_SERVICE lookup.
values_paths_for_service() {
  local service="$1"
  case "$service" in
    admin) printf '%s\n' "admin.image.tag" ;;
    metrics) printf '%s\n' "metrics.image.tag" ;;
    agent) printf '%s\n' "agent.image.tag" "agent.provisioning.image.tag" ;;
    task-store) printf '%s\n' "taskStore.image.tag" ;;
    chat) printf '%s\n' "chat.image.tag" ;;
    *) return 1 ;;
  esac
}

# Returns the highest-semver tag among the given tags (space-separated, all
# sharing the same prefix). Strips the non-numeric prefix so `sort -V`
# compares the bare X.Y.Z portion, then re-attaches the winning original tag.
# A single-tag input is a no-op — the sole tag always "wins". Mirrors the
# "Pin released tags into values.yaml" step's highest_semver_tag().
highest_semver_tag() {
  local tag
  for tag in "$@"; do
    printf '%s %s\n' "${tag##*-v}" "$tag"
  done | sort -V | tail -n1 | cut -d' ' -f2-
}

# Given a batch of tags (comma-separated, possibly mixed services and
# possibly multiple tags per service), groups by service and picks the
# highest-semver tag per service. Returns "service=tag" pairs, one per line,
# sorted by service name for deterministic output. Mirrors the "Pin released
# tags into values.yaml" step's own grouping loop.
select_pinned_tags() {
  local tags_csv="$1"
  local tag service
  declare -A best

  IFS=',' read -ra all_tags <<< "$tags_csv"
  for tag in "${all_tags[@]}"; do
    [ -z "$tag" ] && continue
    service=$(service_for_tag "$tag")
    [ -z "$service" ] && continue
    if [ -z "${best[$service]:-}" ]; then
      best[$service]="$tag"
    else
      best[$service]=$(highest_semver_tag "${best[$service]}" "$tag")
    fi
  done

  for service in "${!best[@]}"; do
    printf '%s=%s\n' "$service" "${best[$service]}"
  done | sort
}

# Writes `tag` into the value at `dot_path` (e.g. "agent.provisioning.image.tag")
# inside `values_yaml`, matching only the `tag:` line nested under the exact
# chain of parent keys (indentation-scoped) — never a blind global regex, so
# agent.image.tag and agent.provisioning.image.tag can be updated
# independently even though both lines read "tag: agent-v...". Mirrors the
# "Pin released tags into values.yaml" step's update_values_tag() (uses
# python3 — same tool the workflow already uses for Chart.yaml edits).
update_values_tag() {
  local values_yaml="$1"
  local dot_path="$2"
  local new_tag="$3"
  python3 - "$values_yaml" "$dot_path" "$new_tag" <<'PYEOF'
import sys

path, dot_path, new_tag = sys.argv[1], sys.argv[2], sys.argv[3]
keys = dot_path.split('.')

with open(path, 'r') as f:
    lines = f.readlines()

# Walk the key chain top-down. Each key must be found at exactly one
# indentation level deeper than the previous key, searching only within the
# span of lines that belongs to the previous key's block (up to the next
# line at the same-or-shallower indentation).
search_start, search_end = 0, len(lines)
indent = -1
for depth, key in enumerate(keys):
    is_last = depth == len(keys) - 1
    target_indent = indent + 2 if indent >= 0 else 0
    found_at = None
    for i in range(search_start, search_end):
        line = lines[i]
        stripped = line.lstrip(' ')
        this_indent = len(line) - len(stripped)
        if this_indent < target_indent:
            break
        if this_indent != target_indent:
            continue
        key_match = stripped.rstrip('\n') == f'{key}:' or stripped.startswith(f'{key}:')
        if key_match:
            found_at = i
            break
    if found_at is None:
        raise SystemExit(f'path segment {key!r} not found for dot_path {dot_path!r}')
    if is_last:
        lines[found_at] = f'{" " * target_indent}{key}: {new_tag}\n'
    else:
        # Narrow the search window to this key's own block: from the next
        # line up to (not including) the next line at <= this indentation.
        block_start = found_at + 1
        block_end = search_end
        for j in range(block_start, search_end):
            j_stripped = lines[j].lstrip(' ')
            if j_stripped.strip() == '':
                continue
            j_indent = len(lines[j]) - len(j_stripped)
            if j_indent <= target_indent:
                block_end = j
                break
        search_start, search_end = block_start, block_end
        indent = target_indent

with open(path, 'w') as f:
    f.writelines(lines)
PYEOF
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

# Fixture mirroring the shape of charts/shipwright/values.yaml's five
# image-tag-bearing service blocks (admin, metrics, agent + nested
# provisioning.image, taskStore, chat) — trimmed to just the keys
# update_values_tag() needs to walk, plus decoy sibling keys at each level to
# catch over-broad matching (e.g. a global "tag:" regex would wrongly hit
# every one of these).
make_values_yaml() {
  local path="$TMPDIR_TEST/values-$$-${RANDOM}.yaml"
  cat > "$path" <<'EOF'
admin:
  enabled: true
  image:
    repository: ghcr.io/app-vitals/shipwright-admin
    tag: admin-v0.188.0
    pullPolicy: ""
  replicas: 1
metrics:
  enabled: true
  image:
    repository: ghcr.io/app-vitals/shipwright-metrics
    tag: metrics-v0.150.0
    pullPolicy: ""
agent:
  enabled: true
  image:
    repository: ghcr.io/app-vitals/shipwright-agent
    tag: agent-v0.172.0
    pullPolicy: ""
  provisioning:
    enabled: false
    namespace: ""
    image:
      repository: ghcr.io/app-vitals/shipwright-agent
      tag: agent-v0.172.0
    replicas: 1
taskStore:
  enabled: false
  image:
    repository: ghcr.io/app-vitals/shipwright-task-store
    tag: task-store-v0.86.0
    pullPolicy: ""
chat:
  enabled: false
  image:
    repository: ghcr.io/app-vitals/shipwright-chat
    tag: chat-v0.38.0
    pullPolicy: ""
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
# Tests: service_for_tag
# ---------------------------------------------------------------------------

echo ""
echo "=== service_for_tag tests ==="

assert_eq "admin-v0.188.0 → admin" "admin" "$(service_for_tag 'admin-v0.188.0')"
assert_eq "metrics-v0.150.0 → metrics" "metrics" "$(service_for_tag 'metrics-v0.150.0')"
assert_eq "agent-v0.172.0 → agent" "agent" "$(service_for_tag 'agent-v0.172.0')"
assert_eq "task-store-v0.86.0 → task-store" "task-store" "$(service_for_tag 'task-store-v0.86.0')"
assert_eq "chat-v0.38.0 → chat" "chat" "$(service_for_tag 'chat-v0.38.0')"
assert_eq "unrecognized prefix → empty" "" "$(service_for_tag 'unknown-v1.0.0')"

# ---------------------------------------------------------------------------
# Tests: values_paths_for_service
# ---------------------------------------------------------------------------

echo ""
echo "=== values_paths_for_service tests ==="

assert_eq "admin → single path" "admin.image.tag" "$(values_paths_for_service 'admin' | paste -sd, -)"
assert_eq "metrics → single path" "metrics.image.tag" "$(values_paths_for_service 'metrics' | paste -sd, -)"
assert_eq "task-store → taskStore.image.tag" "taskStore.image.tag" "$(values_paths_for_service 'task-store' | paste -sd, -)"
assert_eq "chat → single path" "chat.image.tag" "$(values_paths_for_service 'chat' | paste -sd, -)"
assert_eq "agent → dual path (image.tag AND provisioning.image.tag)" \
  "agent.image.tag,agent.provisioning.image.tag" \
  "$(values_paths_for_service 'agent' | paste -sd, -)"

# ---------------------------------------------------------------------------
# Tests: highest_semver_tag
# ---------------------------------------------------------------------------

echo ""
echo "=== highest_semver_tag tests ==="

assert_eq "single tag is a no-op" "agent-v0.144.0" "$(highest_semver_tag 'agent-v0.144.0')"
assert_eq "picks higher patch" "admin-v0.156.1" "$(highest_semver_tag 'admin-v0.156.0' 'admin-v0.156.1')"
assert_eq "picks higher patch regardless of arg order" "admin-v0.156.1" "$(highest_semver_tag 'admin-v0.156.1' 'admin-v0.156.0')"
assert_eq "picks higher minor" "metrics-v0.151.0" "$(highest_semver_tag 'metrics-v0.150.9' 'metrics-v0.151.0')"
assert_eq "picks higher major" "chat-v1.0.0" "$(highest_semver_tag 'chat-v0.99.9' 'chat-v1.0.0')"
assert_eq "double-digit patch beats single-digit (not lexicographic)" "agent-v0.172.10" "$(highest_semver_tag 'agent-v0.172.2' 'agent-v0.172.10')"
assert_eq "three-way batch picks the max" "task-store-v0.86.2" "$(highest_semver_tag 'task-store-v0.86.0' 'task-store-v0.86.2' 'task-store-v0.86.1')"

# ---------------------------------------------------------------------------
# Tests: select_pinned_tags
# ---------------------------------------------------------------------------

echo ""
echo "=== select_pinned_tags tests ==="

assert_eq "single-service batch" "agent=agent-v0.144.0" "$(select_pinned_tags 'agent-v0.144.0')"

assert_eq "multi-service batch, one tag each" \
  "admin=admin-v0.156.0
agent=agent-v0.144.0" \
  "$(select_pinned_tags 'admin-v0.156.0,agent-v0.144.0')"

assert_eq "same-service batch picks highest semver, not last-seen" \
  "admin=admin-v0.156.2" \
  "$(select_pinned_tags 'admin-v0.156.0,admin-v0.156.2,admin-v0.156.1')"

assert_eq "mixed batch: multi-tag service resolved to highest, single-tag services pass through" \
  "admin=admin-v0.156.2
agent=agent-v0.144.0
chat=chat-v0.38.0" \
  "$(select_pinned_tags 'admin-v0.156.0,agent-v0.144.0,admin-v0.156.2,chat-v0.38.0')"

# ---------------------------------------------------------------------------
# Tests: update_values_tag
# ---------------------------------------------------------------------------

echo ""
echo "=== update_values_tag tests ==="

v1=$(make_values_yaml)
update_values_tag "$v1" "admin.image.tag" "admin-v9.9.9"
ADMIN_TAG=$(sed -n '/^admin:/,/^metrics:/p' "$v1" | grep 'tag:' | sed 's/^\s*tag: //')
assert_eq "admin.image.tag updated" "admin-v9.9.9" "$ADMIN_TAG"
METRICS_TAG_UNCHANGED=$(sed -n '/^metrics:/,/^agent:/p' "$v1" | grep 'tag:' | sed 's/^\s*tag: //')
assert_eq "sibling service (metrics) untouched by admin update" "metrics-v0.150.0" "$METRICS_TAG_UNCHANGED"

v2=$(make_values_yaml)
update_values_tag "$v2" "agent.image.tag" "agent-v9.9.8"
update_values_tag "$v2" "agent.provisioning.image.tag" "agent-v9.9.8"
AGENT_TOP_TAG=$(sed -n '/^agent:/,/^provisioning:/p' "$v2" | grep 'tag:' | head -1 | sed 's/^\s*tag: //')
AGENT_PROV_TAG=$(sed -n '/provisioning:/,/^taskStore:/p' "$v2" | grep 'tag:' | head -1 | sed 's/^\s*tag: //')
assert_eq "agent.image.tag updated (dual-path write, top-level)" "agent-v9.9.8" "$AGENT_TOP_TAG"
assert_eq "agent.provisioning.image.tag updated (dual-path write, nested)" "agent-v9.9.8" "$AGENT_PROV_TAG"

v3=$(make_values_yaml)
update_values_tag "$v3" "taskStore.image.tag" "task-store-v9.0.0"
TASKSTORE_TAG=$(sed -n '/^taskStore:/,/^chat:/p' "$v3" | grep 'tag:' | sed 's/^\s*tag: //')
assert_eq "taskStore.image.tag updated" "task-store-v9.0.0" "$TASKSTORE_TAG"
CHAT_TAG_UNCHANGED=$(sed -n '/^chat:/,$p' "$v3" | grep 'tag:' | sed 's/^\s*tag: //')
assert_eq "sibling service (chat) untouched by taskStore update" "chat-v0.38.0" "$CHAT_TAG_UNCHANGED"

# Full multi-service batch pin: exercises select_pinned_tags() output feeding
# straight into update_values_tag() for every path, mirroring how the
# workflow step chains the two.
v4=$(make_values_yaml)
PINNED=$(select_pinned_tags 'admin-v0.156.0,agent-v0.144.0,admin-v0.156.2,chat-v0.38.1')
while IFS='=' read -r service tag; do
  while IFS= read -r path; do
    update_values_tag "$v4" "$path" "$tag"
  done < <(values_paths_for_service "$service")
done <<< "$PINNED"

ADMIN_FINAL=$(sed -n '/^admin:/,/^metrics:/p' "$v4" | grep 'tag:' | sed 's/^\s*tag: //')
AGENT_TOP_FINAL=$(sed -n '/^agent:/,/^  provisioning:/p' "$v4" | grep 'tag:' | head -1 | sed 's/^\s*tag: //')
AGENT_PROV_FINAL=$(sed -n '/provisioning:/,/^taskStore:/p' "$v4" | grep 'tag:' | head -1 | sed 's/^\s*tag: //')
CHAT_FINAL=$(sed -n '/^chat:/,$p' "$v4" | grep 'tag:' | sed 's/^\s*tag: //')
METRICS_FINAL=$(sed -n '/^metrics:/,/^agent:/p' "$v4" | grep 'tag:' | sed 's/^\s*tag: //')
TASKSTORE_FINAL=$(sed -n '/^taskStore:/,/^chat:/p' "$v4" | grep 'tag:' | sed 's/^\s*tag: //')

assert_eq "batch pin: admin resolved to highest semver" "admin-v0.156.2" "$ADMIN_FINAL"
assert_eq "batch pin: agent.image.tag pinned" "agent-v0.144.0" "$AGENT_TOP_FINAL"
assert_eq "batch pin: agent.provisioning.image.tag pinned" "agent-v0.144.0" "$AGENT_PROV_FINAL"
assert_eq "batch pin: chat pinned" "chat-v0.38.1" "$CHAT_FINAL"
assert_eq "batch pin: metrics untouched (not in this batch)" "metrics-v0.150.0" "$METRICS_FINAL"
assert_eq "batch pin: taskStore untouched (not in this batch)" "task-store-v0.86.0" "$TASKSTORE_FINAL"

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
