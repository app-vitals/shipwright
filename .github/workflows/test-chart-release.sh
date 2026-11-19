#!/usr/bin/env bash
#
# .github/workflows/test-chart-release.sh
#
# Tests lib/chart-release.sh (version derivation, pin stamping, no-op guard,
# release record and the idempotent chart-<version> tag) used by
# chart-release.yml. Pure bash + git + tar; no network.
#
# Run: bash .github/workflows/test-chart-release.sh
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
assert_fails() {  # assert_fails <label> <cmd...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then fail "$label" "non-zero exit" "exit 0"; else pass "$label"; fi
}

# shellcheck source=lib/chart-tag-utils.sh
source "$SCRIPT_DIR/lib/chart-tag-utils.sh"
# shellcheck source=lib/library-pin.sh
source "$SCRIPT_DIR/lib/library-pin.sh"
# shellcheck source=lib/chart-release.sh
source "$SCRIPT_DIR/lib/chart-release.sh"

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
INDEX="$SCRIPT_DIR/fixtures/chart-index.yaml"

make_chart_yaml() {  # make_chart_yaml <version> -> path
  local p="$T/Chart-$1-$RANDOM.yaml"
  cat > "$p" <<EOY
apiVersion: v2
name: shipwright
type: application
version: $1
appVersion: "0.1.0"
annotations:
  licenses: MIT
  artifacthub.io/changes: |
    - kind: changed
      description: "old"
dependencies:
  - name: agent-platform
    version: "0.9.0"
    repository: https://app-vitals.github.io/agent
EOY
  echo "$p"
}

make_values_yaml() {
  local p="$T/values-$RANDOM.yaml"
  cat > "$p" <<'EOY'
admin:
  image:
    repository: ghcr.io/app-vitals/shipwright-admin
    tag: admin-v0.0.1
metrics:
  image:
    tag: metrics-v0.0.1
agent:
  image:
    tag: agent-v0.0.1
  provisioning:
    image:
      tag: agent-v0.0.1
taskStore:
  image:
    tag: task-store-v0.0.1
chat:
  image:
    tag: 0.0.1
EOY
  echo "$p"
}

echo "=== max_patch_from_index ==="
assert_eq "highest patch for 1.32 (numeric, not lexical)" "304" "$(max_patch_from_index "$INDEX" 1.32)"
assert_eq "highest patch for 1.31" "77" "$(max_patch_from_index "$INDEX" 1.31)"
assert_eq "nothing published for 1.33" "" "$(max_patch_from_index "$INDEX" 1.33)"
assert_fails "missing index fails" max_patch_from_index "$T/nope.yaml" 1.32
printf 'garbage\n' > "$T/bad.yaml"
assert_fails "index without entries: fails" max_patch_from_index "$T/bad.yaml" 1.32

echo "=== derive_chart_version ==="
assert_eq "next patch after published latest" "1.32.305" "$(derive_chart_version "$(make_chart_yaml 1.32.0)" "$INDEX")"
assert_eq "floor above published starts at .0" "1.33.0" "$(derive_chart_version "$(make_chart_yaml 1.33.0)" "$INDEX")"
assert_eq "floor patch is ignored" "1.32.305" "$(derive_chart_version "$(make_chart_yaml 1.32.7)" "$INDEX")"
assert_fails "unreadable index never falls back to the floor" derive_chart_version "$(make_chart_yaml 1.32.0)" "$T/nope.yaml"

echo "=== derive_chart_version cross-checks chart-* tags ==="
R="$T/repo"; git init -q "$R"
( cd "$R" && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init \
  && git tag chart-1.32.310 && git tag chart-1.32.99 && git tag chart-1.40.2 )
assert_eq "tag newer than index wins" "1.32.311" "$(cd "$R" && derive_chart_version "$(make_chart_yaml 1.32.0)" "$INDEX")"
assert_eq "tag-only line (index has none)" "1.40.3" "$(cd "$R" && derive_chart_version "$(make_chart_yaml 1.40.0)" "$INDEX")"

echo "=== stamp_pins ==="
S="$T/stamp"; mkdir -p "$S/agent"
printf 'ARG PLATFORM_VERSION=1.19.0\n' > "$S/agent/Dockerfile"
( cd "$S" && git init -q . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m i \
  && git tag admin-v1.1.0 && git tag admin-v1.10.0 && git tag admin-v1.2.0 \
  && git tag agent-v2.0.0 && git tag task-store-v3.1.0 )
V="$(make_values_yaml)"
PINS=$(cd "$S" && stamp_pins "$V" 2>"$T/stamp.err")
assert_eq "admin pinned to highest semver tag" "admin-v1.10.0" "$(read_pinned_tag "$V" admin.image.tag)"
assert_eq "agent top-level pin" "agent-v2.0.0" "$(read_pinned_tag "$V" agent.image.tag)"
assert_eq "agent provisioning pin" "agent-v2.0.0" "$(read_pinned_tag "$V" agent.provisioning.image.tag)"
assert_eq "task-store pin" "task-store-v3.1.0" "$(read_pinned_tag "$V" taskStore.image.tag)"
assert_eq "chat pin is the bare platform version" "1.19.0" "$(read_pinned_tag "$V" chat.image.tag)"
assert_eq "service with no tag is left unchanged" "metrics-v0.0.1" "$(read_pinned_tag "$V" metrics.image.tag)"
assert_eq "missing tag warns" "1" "$(grep -c 'metrics' "$T/stamp.err")"
assert_eq "pin record lists stamped services" "admin=admin-v1.10.0,agent=agent-v2.0.0,chat=agent-chat-v1.19.0,task-store=task-store-v3.1.0" "$(echo "$PINS" | paste -sd, -)"

echo "=== stamp_chart_yaml ==="
C="$(make_chart_yaml 1.32.0)"
stamp_chart_yaml "$C" 1.32.305 "$(echo "$PINS" | paste -sd, -)"
assert_eq "version stamped" "1.32.305" "$(sed -n 's/^version: //p' "$C")"
assert_eq "old annotation replaced" "0" "$(grep -c '"old"' "$C")"
assert_eq "annotation names the pins" "1" "$(grep -c 'admin-v1.10.0' "$C")"
assert_eq "dependencies preserved" "1" "$(grep -c '^dependencies:' "$C")"

echo "=== chart_packages_equivalent ==="
mkpkg() {  # mkpkg <out.tgz> <version> <values-content> <annotation>
  local d="$T/pkg-$RANDOM/shipwright"; mkdir -p "$d"
  printf 'name: shipwright\nversion: %s\nannotations:\n  licenses: MIT\n  artifacthub.io/changes: |\n    - kind: changed\n      description: "%s"\ndependencies: []\n' "$2" "$4" > "$d/Chart.yaml"
  printf '%s\n' "$3" > "$d/values.yaml"
  tar -czf "$1" -C "$(dirname "$d")" shipwright
}
mkpkg "$T/a.tgz" 1.32.304 "tag: a" "one"
mkpkg "$T/b.tgz" 1.32.305 "tag: a" "two"
mkpkg "$T/c.tgz" 1.32.305 "tag: b" "two"
if chart_packages_equivalent "$T/a.tgz" "$T/b.tgz"; then pass "differs only in version/annotation -> equivalent"; else fail "version/annotation only" equivalent different; fi
if chart_packages_equivalent "$T/a.tgz" "$T/c.tgz"; then fail "values change detected" different equivalent; else pass "values change -> not equivalent"; fi

echo "=== release_record ==="
REC=$(release_record 1.32.305 abc123 "admin=admin-v1.10.0" "0.9.0" "https://x/run/1")
assert_eq "record has version" "1" "$(echo "$REC" | grep -c '^Chart: 1.32.305$')"
assert_eq "record has source sha" "1" "$(echo "$REC" | grep -c '^Source-Commit: abc123$')"
assert_eq "record has pin" "1" "$(echo "$REC" | grep -c '^Pin: admin=admin-v1.10.0$')"
assert_eq "record has library pin" "1" "$(echo "$REC" | grep -c '^Library: agent-platform 0.9.0$')"
assert_eq "record has run url" "1" "$(echo "$REC" | grep -c '^Run: https://x/run/1$')"

echo "=== recorded_release / record_field (tag recovery from the gh-pages commit) ==="
GP="$T/ghpages"; git init -q "$GP"
REC1=$(release_record 1.32.305 abc123 "admin=admin-v1.10.0" "0.9.0" "https://x/run/1")
( cd "$GP" && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "chart: publish shipwright 1.32.304" \
  && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "chart: publish shipwright 1.32.305" -m "$REC1" )
assert_eq "recorded_release finds the record by version" "abc123" "$(record_field "$(recorded_release "$GP" 1.32.305)" Source-Commit)"
assert_eq "legacy publish commit has no record" "" "$(recorded_release "$GP" 1.32.304)"
assert_eq "1.32.30 does not match 1.32.305" "" "$(recorded_release "$GP" 1.32.30)"
assert_eq "1.32.3050 does not match 1.32.305" "" "$(recorded_release "$GP" 1.32.3050)"

echo "=== publish_chart_tag (idempotent, never moves a tag) ==="
BARE="$T/origin.git"; git init -q --bare "$BARE"
W="$T/work"; git clone -q "$BARE" "$W" 2>/dev/null
( cd "$W" && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m one \
  && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m two )
SHA1=$(git -C "$W" rev-parse HEAD~1); SHA2=$(git -C "$W" rev-parse HEAD)
export SHIPWRIGHT_SIGNED_COMMITS=off  # local git push wrapper opt-out; no effect in CI
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
echo "Chart: 1.32.305" > "$T/msg"
( cd "$W" && publish_chart_tag 1.32.305 "$SHA2" "$T/msg" origin ) >/dev/null
assert_eq "tag pushed to remote" "1" "$(git -C "$BARE" tag -l chart-1.32.305 | wc -l | tr -d ' ')"
assert_eq "tag is annotated" "tag" "$(git -C "$BARE" cat-file -t refs/tags/chart-1.32.305)"
assert_eq "tag targets the source commit" "$SHA2" "$(git -C "$BARE" rev-parse 'chart-1.32.305^{commit}')"
assert_eq "tag message is the release record" "Chart: 1.32.305" "$(git -C "$BARE" tag -l --format='%(contents:subject)' chart-1.32.305)"
TAGOBJ=$(git -C "$BARE" rev-parse chart-1.32.305)
( cd "$W" && publish_chart_tag 1.32.305 "$SHA2" "$T/msg" origin ) >/dev/null
assert_eq "re-run with same sha exits 0" "0" "$?"
assert_eq "re-run does not duplicate or move the tag" "$TAGOBJ" "$(git -C "$BARE" rev-parse chart-1.32.305)"
# Fresh clone (tag only on remote) re-run is also a no-op.
W2="$T/work2"; git clone -q "$BARE" "$W2" 2>/dev/null
( cd "$W2" && publish_chart_tag 1.32.305 "$SHA2" "$T/msg" origin ) >/dev/null
assert_eq "re-run from a clone without the tag locally exits 0" "0" "$?"
if ( cd "$W" && publish_chart_tag 1.32.305 "$SHA1" "$T/msg" origin ) >/dev/null 2>&1; then
  fail "different sha must fail" "non-zero exit" "exit 0"
else
  pass "different sha fails"
fi
assert_eq "tag not moved after conflicting run" "$TAGOBJ" "$(git -C "$BARE" rev-parse chart-1.32.305)"
# Locally missing, remote present at same sha: tag exists only remotely.
( cd "$W" && git tag -d chart-1.32.305 >/dev/null && publish_chart_tag 1.32.305 "$SHA2" "$T/msg" origin ) >/dev/null
assert_eq "local tag missing but remote same sha: exits 0, remote unchanged" "$TAGOBJ" "$(git -C "$BARE" rev-parse chart-1.32.305)"

echo ""
echo "================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "================================"
[[ $FAIL -gt 0 ]] && exit 1
exit 0
